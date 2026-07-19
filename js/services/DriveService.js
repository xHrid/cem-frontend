import { getAccessToken, isTokenExpired, ensureValidToken } from './AuthService.js';
import Config from '../core/Config.js';

const ROOT_FOLDER_NAME  = Config.google.driveRootFolder;
const DRIVE_FILES_URL   = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL  = 'https://www.googleapis.com/upload/drive/v3/files';

const PAGE_SIZE = 1000;

const folderCache = new Map();

let _rootFolderPromise = null;

let _rootFolderId = null;

const _namedFileId      = new Map();
const _namedFilePending = new Map();

function escapeQueryString(str) {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function fetchDrive(url, opts = {}, signal) {
    const token = isTokenExpired()
        ? await ensureValidToken()
        : getAccessToken();

    if (!token) throw new Error('[DriveService] Not logged in — token unavailable.');

    const headers = {
        ...opts.headers,
        Authorization: `Bearer ${token}`,
    };

    const fetchOpts = { ...opts, headers };
    if (signal) fetchOpts.signal = signal;

    const res = await fetch(url, fetchOpts);

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`[DriveService] Drive API ${res.status} ${res.statusText}: ${body}`);
    }

    return res;
}

export async function findOrCreateRootFolder() {
    if (_rootFolderId) return _rootFolderId;

    if (_rootFolderPromise) return _rootFolderPromise;

    _rootFolderPromise = _findOrCreateRootFolderImpl();

    try {
        _rootFolderId = await _rootFolderPromise;
        return _rootFolderId;
    } finally {
        _rootFolderPromise = null;
    }
}

export async function upsertFile(name, parentId, blob, mimeType = 'application/json', relativePath = null) {
    const key = `${parentId}|${name}`;

    const knownId = _namedFileId.get(key);
    if (knownId) {
        try {
            await updateDriveFile(knownId, blob);
            return knownId;
        } catch (err) {
            _namedFileId.delete(key);
        }
    }

    if (_namedFilePending.has(key)) {
        const id = await _namedFilePending.get(key);
        await updateDriveFile(id, blob);
        _namedFileId.set(key, id);
        return id;
    }

    const pending = (async () => {
        const existing = await findFileByName(name, parentId);
        if (existing) {
            await updateDriveFile(existing.id, blob);
            return existing.id;
        }
        const created = await uploadFile(blob, name, mimeType, parentId, relativePath);
        return created.id;
    })();

    _namedFilePending.set(key, pending);
    try {
        const id = await pending;
        _namedFileId.set(key, id);
        return id;
    } finally {
        _namedFilePending.delete(key);
    }
}

async function _findOrCreateRootFolderImpl() {
    const safeName = escapeQueryString(ROOT_FOLDER_NAME);
    const q = `name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

    const res  = await fetchDrive(`${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id)`);
    const data = await res.json();

    if (data.files && data.files.length > 0) {
        return data.files[0].id;
    }

    const createRes = await fetchDrive(DRIVE_FILES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: ROOT_FOLDER_NAME,
            mimeType: 'application/vnd.google-apps.folder',
        }),
    });
    const folder = await createRes.json();
    return folder.id;
}

export async function findFileByName(filename, parentId) {
    const safeName   = escapeQueryString(filename);
    const safeParent = escapeQueryString(parentId);
    const q = `name = '${safeName}' and '${safeParent}' in parents and trashed = false`;

    const res  = await fetchDrive(
        `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    const data = await res.json();

    return (data.files && data.files.length > 0) ? data.files[0] : null;
}

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

export async function readDriveTextFile(fileId) {
    const res = await fetchDrive(`${DRIVE_FILES_URL}/${fileId}?alt=media&supportsAllDrives=true`);
    return res.text();
}

export async function updateDriveFile(fileId, blob) {
    const res = await fetchDrive(
        `${DRIVE_UPLOAD_URL}/${fileId}?uploadType=media`,
        { method: 'PATCH', body: blob }
    );
    return res.json();
}

export async function ensureDrivePath(pathParts, rootId) {
    let currentParentId = rootId;

    for (const folderName of pathParts) {
        const cacheKey = `${currentParentId}|${folderName}`;

        if (folderCache.has(cacheKey)) {
            currentParentId = await folderCache.get(cacheKey);
            continue;
        }

        const folderPromise = _resolveFolder(folderName, currentParentId);
        folderCache.set(cacheKey, folderPromise);

        try {
            currentParentId = await folderPromise;
        } catch (err) {
            folderCache.delete(cacheKey);
            throw err;
        }
    }

    return currentParentId;
}

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

export async function downloadBlob(fileId) {
    const res = await fetchDrive(`${DRIVE_FILES_URL}/${fileId}?alt=media&supportsAllDrives=true`);
    return res.blob();
}

// Drive caps each appProperty (key + value) at 124 bytes UTF-8, so a long
// relativePath (e.g. jobs/results/<uuid>/boxplot_...png) can't fit in one.
// Split it into rp0, rp1, ... chunks that each stay under the cap; reassemble
// with driveFileRelPath.
const _RELPATH_CHUNK_BYTES = 110;

function _relPathToProps(relativePath) {
    const enc = new TextEncoder();
    const chunks = [];
    let cur = '';
    for (const ch of relativePath) {
        if (enc.encode(cur + ch).length > _RELPATH_CHUNK_BYTES) {
            chunks.push(cur);
            cur = ch;
        } else {
            cur += ch;
        }
    }
    if (cur) chunks.push(cur);

    const props = {};
    chunks.forEach((c, i) => { props[`rp${i}`] = c; });
    return props;
}

export function driveFileRelPath(file) {
    const props = file?.appProperties;
    if (!props || props.rp0 === undefined) return null;
    let out = '';
    for (let i = 0; props[`rp${i}`] !== undefined; i++) out += props[`rp${i}`];
    return out;
}

export async function uploadFile(blob, filename, mimeType, parentId, relativePath = null) {
    const metadata = {
        name: filename,
        mimeType,
        parents: [parentId],
    };
    if (relativePath) {
        metadata.appProperties = _relPathToProps(relativePath);
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

export function clearCache() {
    folderCache.clear();
    _namedFileId.clear();
    _namedFilePending.clear();
    _rootFolderId = null;
}

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

export async function makeFilePublic(fileId) {
    try {
        await fetchDrive(
            `${DRIVE_FILES_URL}/${fileId}/permissions?supportsAllDrives=true`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'reader', type: 'anyone' }),
            }
        );
    } catch (e) {
        console.warn('[DriveService] makeFilePublic failed:', e.message);
    }
}

export async function fetchPublicBlob(fileId, kind = '') {
    try {
        const blob = await downloadBlob(fileId);
        if (blob && blob.size > 0) return blob;
    } catch { }

    const urls = [`https://drive.usercontent.google.com/download?id=${fileId}&export=download`];
    if (kind === 'image') urls.unshift(`https://lh3.googleusercontent.com/d/${fileId}`);

    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                const blob = await res.blob();
                // A non-public file returns Google's HTML sign-in/permission page
                // (HTTP 200, text/html). Never mistake that for the real file.
                if (blob && blob.size > 0 && !/^text\/html/i.test(blob.type)) return blob;
            }
        } catch { }
    }
    return null;
}

export async function listPermissions(fileId) {
    const res = await fetchDrive(
        `${DRIVE_FILES_URL}/${fileId}/permissions?fields=permissions(id,role,type,emailAddress)`
    );
    const data = await res.json();
    return data.permissions || [];
}

export async function removePermission(fileId, permissionId) {
    await fetchDrive(
        `${DRIVE_FILES_URL}/${fileId}/permissions/${permissionId}`,
        { method: 'DELETE' }
    );
}

export async function getFileMetadata(fileId, fields = 'id,name,mimeType,parents,owners,shared,permissions(id,role,type,emailAddress)') {
    const res = await fetchDrive(
        `${DRIVE_FILES_URL}/${fileId}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`
    );
    return res.json();
}

export async function listFolderContents(folderId) {
    const safeFolderId = escapeQueryString(folderId);
    const q = `'${safeFolderId}' in parents and trashed = false`;
    const fields = 'nextPageToken,files(id,name,mimeType,appProperties)';

    let files = [];
    let pageToken = null;

    do {
        const params = new URLSearchParams({
            q, fields, pageSize: String(PAGE_SIZE),
            supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
        });
        if (pageToken) params.set('pageToken', pageToken);

        const res  = await fetchDrive(`${DRIVE_FILES_URL}?${params.toString()}`);
        const data = await res.json();

        if (data.files) files.push(...data.files);
        pageToken = data.nextPageToken || null;
    } while (pageToken);

    return files;
}

export async function findFileInTree(filename, folderId) {
    const direct = await findFileByName(filename, folderId);
    if (direct) return direct;

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
