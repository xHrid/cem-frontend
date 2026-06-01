/**
 * DriveService.js — Google Drive API facade with caching and pagination
 *
 * Pattern  : Facade (single clean surface over raw Drive REST calls) +
 *            Proxy/Cache (folderCache deduplicates folder-creation races)
 *
 * Fixes over drive_api.js:
 *  1. `listAllDriveFiles()` — full pagination via `nextPageToken` loop.
 *     pageSize capped at 1 000 (Drive API max).
 *  2. `findOrCreateRootFolder()` — pending-promise guard prevents two
 *     concurrent callers from creating duplicate root folders.
 *  3. `escapeQueryString()` — escapes BOTH single-quotes AND backslashes.
 *  4. `fetchDrive()` — calls `ensureValidToken()` before every request so
 *     expired tokens are refreshed transparently.
 *  5. `clearCache()` added to let tests / auth-logout wipe folder state.
 *
 * Public exports:
 *   findOrCreateRootFolder, findFileByName, readDriveTextFile,
 *   updateDriveFile, ensureDrivePath, listAllDriveFiles,
 *   downloadBlob, uploadFile, clearCache
 */

import { getAccessToken, isTokenExpired, ensureValidToken } from './AuthService.js';
import Config from '../core/Config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT_FOLDER_NAME  = Config.google.driveRootFolder;
const DRIVE_FILES_URL   = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL  = 'https://www.googleapis.com/upload/drive/v3/files';

/** Maximum number of files returned per page (Drive API hard limit = 1 000). */
const PAGE_SIZE = 1000;

// ---------------------------------------------------------------------------
// Module-level cache state
// ---------------------------------------------------------------------------

/**
 * Folder ID cache: prevents redundant "does this folder exist?" queries.
 * Key format: `"${parentId}|${folderName}"` -> Promise<folderId: string>
 * @type {Map<string, Promise<string>>}
 */
const folderCache = new Map();

/**
 * Pending-promise guard for `findOrCreateRootFolder`.
 * If two callers race during startup only one Drive request is made.
 * @type {Promise<string>|null}
 */
let _rootFolderPromise = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for use inside a Drive query `name = '...'` clause.
 * Drive query syntax requires both `'` -> `\'` AND `\` -> `\\`.
 *
 * @param {string} str  Raw folder / file name.
 * @returns {string}    Safe string for interpolation into a Drive query.
 */
function escapeQueryString(str) {
    // Order matters: escape backslashes first so we do not double-escape the
    // newly introduced backslashes in the single-quote replacement.
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Thin fetch wrapper that:
 *  - Ensures a valid (non-expired) token before each request.
 *  - Attaches the Authorization header automatically.
 *  - Throws a descriptive Error on non-2xx HTTP responses.
 *
 * @param {string}       url       Full Drive REST endpoint URL.
 * @param {object}       [opts]    Standard `fetch` init options (method, body, …).
 * @param {AbortSignal}  [signal]  Optional AbortSignal for cancellable requests.
 * @returns {Promise<Response>}
 */
async function fetchDrive(url, opts = {}, signal) {
    // Refresh the token if it is expired or within the 1-min buffer
    const token = isTokenExpired()
        ? await ensureValidToken()
        : getAccessToken();

    if (!token) throw new Error('[DriveService] Not logged in — token unavailable.');

    const headers = {
        ...opts.headers,
        Authorization: `Bearer ${token}`,
    };

    // Thread the signal into fetch so callers can abort in-flight requests
    const fetchOpts = { ...opts, headers };
    if (signal) fetchOpts.signal = signal;

    const res = await fetch(url, fetchOpts);

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`[DriveService] Drive API ${res.status} ${res.statusText}: ${body}`);
    }

    return res;
}

// ---------------------------------------------------------------------------
// Root-folder management
// ---------------------------------------------------------------------------

/**
 * Find (or create) the application root folder in Drive.
 *
 * The pending-promise guard ensures that if this function is called
 * concurrently during app startup only one network round-trip is made and
 * all callers share the same resolved value.
 *
 * @returns {Promise<string>} The Drive folder ID for the root folder.
 */
export async function findOrCreateRootFolder() {
    // Return the in-flight promise if one is already pending
    if (_rootFolderPromise) return _rootFolderPromise;

    _rootFolderPromise = _findOrCreateRootFolderImpl();

    try {
        return await _rootFolderPromise;
    } finally {
        // Always clear so future calls after an error can retry
        _rootFolderPromise = null;
    }
}

/**
 * Actual implementation — called once at a time thanks to the guard above.
 * @returns {Promise<string>}
 */
async function _findOrCreateRootFolderImpl() {
    const safeName = escapeQueryString(ROOT_FOLDER_NAME);
    const q = `name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

    const res  = await fetchDrive(`${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id)`);
    const data = await res.json();

    if (data.files && data.files.length > 0) {
        return data.files[0].id;
    }

    // Folder not found — create it
    const createRes = await fetchDrive(DRIVE_FILES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: ROOT_FOLDER_NAME,
            mimeType: 'application/vnd.google-apps.folder',
        }),
    });
    const folder = await createRes.json();
    console.log('[DriveService] Created root folder:', folder.id);
    return folder.id;
}

// ---------------------------------------------------------------------------
// File & folder queries
// ---------------------------------------------------------------------------

/**
 * Find a single file by name inside a specific parent folder.
 *
 * @param {string} filename  Exact file name to search for.
 * @param {string} parentId  Drive ID of the parent folder.
 * @returns {Promise<{id:string, name:string, modifiedTime:string}|null>}
 */
export async function findFileByName(filename, parentId) {
    const safeName   = escapeQueryString(filename);
    const safeParent = escapeQueryString(parentId);
    const q = `name = '${safeName}' and '${safeParent}' in parents and trashed = false`;

    const res  = await fetchDrive(
        `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)`
    );
    const data = await res.json();

    return (data.files && data.files.length > 0) ? data.files[0] : null;
}

/**
 * Find a file by name inside a parent folder that WE own (created by our app).
 * Uses `'me' in owners` filter so drive.file scope can update it later.
 *
 * @param {string} filename  Exact file name.
 * @param {string} parentId  Drive parent folder ID.
 * @returns {Promise<{id:string, name:string, modifiedTime:string}|null>}
 */
export async function findMyFileByName(filename, parentId) {
    const safeName   = escapeQueryString(filename);
    const safeParent = escapeQueryString(parentId);
    const q = `name = '${safeName}' and '${safeParent}' in parents and 'me' in owners and trashed = false`;

    const res  = await fetchDrive(
        `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)`
    );
    const data = await res.json();

    return (data.files && data.files.length > 0) ? data.files[0] : null;
}

/**
 * List all files matching a name pattern in a folder (any owner).
 * Useful for owner pulling editor contribution files.
 *
 * @param {string} namePrefix  File name prefix to match (uses `contains`).
 * @param {string} parentId    Drive parent folder ID.
 * @returns {Promise<Array<{id:string, name:string, modifiedTime:string, owners:Array}>>}
 */
export async function findFilesByPrefix(namePrefix, parentId) {
    const safePrefix = escapeQueryString(namePrefix);
    const safeParent = escapeQueryString(parentId);
    const q = `name contains '${safePrefix}' and '${safeParent}' in parents and trashed = false`;

    const res  = await fetchDrive(
        `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,owners)`
    );
    const data = await res.json();

    return data.files || [];
}

/**
 * Download a Drive file as plain text.
 *
 * @param {string} fileId  Drive file ID.
 * @returns {Promise<string>}
 */
export async function readDriveTextFile(fileId) {
    const res = await fetchDrive(`${DRIVE_FILES_URL}/${fileId}?alt=media`);
    return res.text();
}

/**
 * Replace the content of an existing Drive file (media-only PATCH).
 *
 * @param {string} fileId  Drive file ID.
 * @param {Blob}   blob    New file content.
 * @returns {Promise<object>} Updated file metadata from Drive.
 */
export async function updateDriveFile(fileId, blob) {
    const res = await fetchDrive(
        `${DRIVE_UPLOAD_URL}/${fileId}?uploadType=media`,
        { method: 'PATCH', body: blob }
    );
    return res.json();
}

// ---------------------------------------------------------------------------
// Folder path resolver (with cache)
// ---------------------------------------------------------------------------

/**
 * Walk (and create if missing) a chain of folders from a root ID, returning
 * the ID of the deepest folder.
 *
 * Results are cached per `"${parentId}|${folderName}"` key.  Concurrent
 * calls for the same path share the same in-flight Promise so only one
 * folder-creation request is ever sent.
 *
 * @param {string[]} pathParts  Folder names to traverse, outermost first.
 * @param {string}   rootId     Drive ID of the starting (root) folder.
 * @returns {Promise<string>}   Drive ID of the final folder in the chain.
 */
export async function ensureDrivePath(pathParts, rootId) {
    let currentParentId = rootId;

    for (const folderName of pathParts) {
        const cacheKey = `${currentParentId}|${folderName}`;

        if (folderCache.has(cacheKey)) {
            // Await the cached promise (it may still be in-flight)
            currentParentId = await folderCache.get(cacheKey);
            continue;
        }

        // Build and cache the promise immediately so concurrent callers share it
        const folderPromise = _resolveFolder(folderName, currentParentId);
        folderCache.set(cacheKey, folderPromise);

        try {
            currentParentId = await folderPromise;
        } catch (err) {
            // On failure, evict the cache entry so the next call can retry
            folderCache.delete(cacheKey);
            throw err;
        }
    }

    return currentParentId;
}

/**
 * Find or create a single folder inside `parentId`.
 *
 * @param {string} folderName
 * @param {string} parentId
 * @returns {Promise<string>} Folder ID.
 */
async function _resolveFolder(folderName, parentId) {
    const safeName   = escapeQueryString(folderName);
    const safeParent = escapeQueryString(parentId);
    const q = [
        `name = '${safeName}'`,
        `'${safeParent}' in parents`,
        `mimeType = 'application/vnd.google-apps.folder'`,
        `trashed = false`,
    ].join(' and ');

    const res  = await fetchDrive(`${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id)`);
    const data = await res.json();

    if (data.files && data.files.length > 0) {
        return data.files[0].id;
    }

    // Folder missing — create it
    const createRes = await fetchDrive(DRIVE_FILES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
        }),
    });
    const folder = await createRes.json();
    return folder.id;
}

// ---------------------------------------------------------------------------
// File listing (with full pagination)
// ---------------------------------------------------------------------------

/**
 * List every non-trashed file in the application's Drive space.
 *
 * Scoped to the app's root folder to avoid scanning the entire Drive
 * (which happens with drive.readonly scope). Recursively collects files
 * from the root folder and all subfolders.
 *
 * @returns {Promise<Array<{id:string, name:string, mimeType:string, parents:string[], appProperties:object}>>}
 */
export async function listAllDriveFiles() {
    // First find our root folder — this scopes everything
    const rootId = await findOrCreateRootFolder();
    return _listFilesRecursive(rootId);
}

/**
 * Recursively list all files inside a folder and its subfolders.
 *
 * @param {string} folderId  Parent folder to scan.
 * @returns {Promise<Array>}
 */
async function _listFilesRecursive(folderId) {
    const fields = 'nextPageToken,files(id,name,mimeType,parents,appProperties)';
    const safeFolderId = escapeQueryString(folderId);
    const q = `'${safeFolderId}' in parents and trashed = false`;

    let files     = [];
    let pageToken = null;

    do {
        const params = new URLSearchParams({
            q,
            fields,
            pageSize: String(PAGE_SIZE),
        });
        if (pageToken) params.set('pageToken', pageToken);

        const res  = await fetchDrive(`${DRIVE_FILES_URL}?${params.toString()}`);
        const data = await res.json();

        if (data.files) files.push(...data.files);
        pageToken = data.nextPageToken || null;

    } while (pageToken);

    // Recurse into subfolders
    const subfolders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    for (const sub of subfolders) {
        const subFiles = await _listFilesRecursive(sub.id);
        files.push(...subFiles);
    }

    return files;
}

/**
 * List all files recursively inside any folder (including shared folders).
 * Public wrapper over _listFilesRecursive for use by SyncService when
 * scanning shared project folders.
 *
 * @param {string} folderId  Drive folder ID to scan.
 * @returns {Promise<Array<{id:string, name:string, mimeType:string, parents:string[], appProperties:object}>>}
 */
export async function listAllFilesInFolder(folderId) {
    return _listFilesRecursive(folderId);
}

// ---------------------------------------------------------------------------
// File downloads and uploads
// ---------------------------------------------------------------------------

/**
 * Download a Drive file and return it as a Blob.
 *
 * @param {string} fileId
 * @returns {Promise<Blob>}
 */
export async function downloadBlob(fileId) {
    const res = await fetchDrive(`${DRIVE_FILES_URL}/${fileId}?alt=media`);
    return res.blob();
}

/**
 * Upload a new file to Drive using multipart upload.
 *
 * If `relativePath` is supplied it is stored in the file's `appProperties`
 * so that `listAllDriveFiles` results can be mapped back to local paths.
 *
 * @param {Blob}        blob           File content.
 * @param {string}      filename       Name stored on Drive.
 * @param {string}      mimeType       Content-Type of the file.
 * @param {string}      parentId       Drive folder ID to upload into.
 * @param {string|null} [relativePath] App-relative path stored as appProperty.
 * @returns {Promise<object>}  Drive file metadata for the newly created file.
 */
export async function uploadFile(blob, filename, mimeType, parentId, relativePath = null) {
    const metadata = {
        name: filename,
        mimeType,
        parents: [parentId],
    };
    if (relativePath) {
        metadata.appProperties = { relativePath };
    }

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob);

    const res = await fetchDrive(
        `${DRIVE_UPLOAD_URL}?uploadType=multipart`,
        { method: 'POST', body: form }
    );
    return res.json();
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

/**
 * Wipe the in-memory folder cache.
 *
 * Call this after logout or when you know the Drive folder structure may have
 * changed externally (e.g. another device moved files).
 */
export function clearCache() {
    folderCache.clear();
    console.log('[DriveService] Folder cache cleared.');
}

// ---------------------------------------------------------------------------
// Sharing & Permissions (Drive Permissions API v3)
// ---------------------------------------------------------------------------

/**
 * Share a Drive file or folder with a specific user.
 *
 * @param {string} fileId       Drive ID of the file/folder to share.
 * @param {string} emailAddress Gmail address of the recipient.
 * @param {'reader'|'writer'} role  Permission role.
 * @param {boolean} [sendEmail=true]  Whether Drive sends a notification email.
 * @returns {Promise<object>}   The created permission resource.
 */
export async function shareWithUser(fileId, emailAddress, role, sendEmail = true) {
    const params = new URLSearchParams({ sendNotificationEmail: String(sendEmail) });
    const res = await fetchDrive(
        `${DRIVE_FILES_URL}/${fileId}/permissions?${params.toString()}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'user',
                role,
                emailAddress,
            }),
        }
    );
    return res.json();
}

/**
 * List all permissions on a Drive file/folder.
 *
 * @param {string} fileId  Drive file/folder ID.
 * @returns {Promise<Array<{id:string, role:string, type:string, emailAddress:string}>>}
 */
export async function listPermissions(fileId) {
    const res = await fetchDrive(
        `${DRIVE_FILES_URL}/${fileId}/permissions?fields=permissions(id,role,type,emailAddress)`
    );
    const data = await res.json();
    return data.permissions || [];
}

/**
 * Remove a permission from a Drive file/folder.
 *
 * @param {string} fileId        Drive file/folder ID.
 * @param {string} permissionId  Permission ID to remove.
 * @returns {Promise<void>}
 */
export async function removePermission(fileId, permissionId) {
    await fetchDrive(
        `${DRIVE_FILES_URL}/${fileId}/permissions/${permissionId}`,
        { method: 'DELETE' }
    );
}

/**
 * Get metadata for a Drive file/folder (works for shared files with drive.readonly).
 *
 * @param {string} fileId  Drive file/folder ID.
 * @param {string} [fields='id,name,mimeType,parents,owners,shared,permissions']
 * @returns {Promise<object>}
 */
export async function getFileMetadata(fileId, fields = 'id,name,mimeType,parents,owners,shared,permissions(id,role,type,emailAddress)') {
    const res = await fetchDrive(
        `${DRIVE_FILES_URL}/${fileId}?fields=${encodeURIComponent(fields)}`
    );
    return res.json();
}

/**
 * List all non-trashed children of a Drive folder.
 * Works on shared folders via drive.readonly scope.
 *
 * @param {string} folderId  Drive folder ID.
 * @returns {Promise<Array<{id:string, name:string, mimeType:string, appProperties:object}>>}
 */
export async function listFolderContents(folderId) {
    const safeFolderId = escapeQueryString(folderId);
    const q = `'${safeFolderId}' in parents and trashed = false`;
    const fields = 'nextPageToken,files(id,name,mimeType,appProperties)';

    let files = [];
    let pageToken = null;

    do {
        const params = new URLSearchParams({ q, fields, pageSize: String(PAGE_SIZE) });
        if (pageToken) params.set('pageToken', pageToken);

        const res  = await fetchDrive(`${DRIVE_FILES_URL}?${params.toString()}`);
        const data = await res.json();

        if (data.files) files.push(...data.files);
        pageToken = data.nextPageToken || null;
    } while (pageToken);

    return files;
}

/**
 * Recursively find a file by name inside a folder tree.
 * Searches breadth-first.
 *
 * @param {string} filename   File name to find.
 * @param {string} folderId   Root folder to start searching from.
 * @returns {Promise<{id:string, name:string}|null>}
 */
export async function findFileInTree(filename, folderId) {
    // Check direct children first
    const direct = await findFileByName(filename, folderId);
    if (direct) return direct;

    // Search subfolders
    const children = await listFolderContents(folderId);
    const subfolders = children.filter(
        f => f.mimeType === 'application/vnd.google-apps.folder'
    );

    for (const sub of subfolders) {
        const found = await findFileInTree(filename, sub.id);
        if (found) return found;
    }

    return null;
}
