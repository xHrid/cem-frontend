/**
 * SyncService.js — Media and master-data synchronisation with Google Drive
 *
 * Pattern  : Strategy (sync direction — push / pull — is a swappable param,
 *            not a hard-coded branch; conflict resolution action is likewise
 *            a strategy chosen at call-time)
 *
 * Consolidates:
 *  - media_sync.js  (generateSyncReport, getAllProjectsSyncStatus,
 *                    syncUp, syncDown, syncBatch)
 *  - sync parts of storage.js  (checkForRemoteUpdates, resolveMasterConflict,
 *                               mergeDatasets)
 *
 * Key fixes over the originals:
 *  1. `listAllDriveFiles()` result is shared across `generateSyncReport` and
 *     `getAllProjectsSyncStatus` — callers can pass a pre-fetched list, or let
 *     each function fetch it once internally.
 *  2. `syncUp()` does a true upsert: checks `appProperties.relativePath` on
 *     Drive to find an existing file before deciding to update vs. create.
 *  3. `isSyncing` mutex uses try/finally so it always resets on error.
 *  4. `checkForRemoteUpdates()` replaces `alert()` calls with
 *     EventBus.emit(Events.TOAST_SHOW, ...) and emits MASTER_SYNC_CONFLICT
 *     when signatures differ.
 *  5. `resolveMasterConflict()` replaces `alert()` with EventBus toasts and
 *     emits DATA_UPDATED + PROJECT_CHANGED after resolution.
 *
 * Public exports:
 *   generateSyncReport, getAllProjectsSyncStatus,
 *   syncUp, syncDown, syncBatch,
 *   checkForRemoteUpdates, resolveMasterConflict, mergeDatasets
 */

import EventBus, { EVENTS } from '../core/EventBus.js';
import * as DriveService from './DriveService.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import { getLocalState, replaceState, generateDataSignature } from '../data/MasterData.js';
import { getProjectFolderName } from '../data/ProjectManager.js';
import { getAccessToken } from './AuthService.js';

// ---------------------------------------------------------------------------
// Module-level mutex
// ---------------------------------------------------------------------------

/** True while a `syncBatch` operation is running.  Reset in try/finally. */
let isSyncing = false;

/**
 * TTL cache for shared folder file listings.
 * Prevents re-scanning a remote shared folder on every UI refresh.
 * @type {Map<string, {files: Array, fetchedAt: number}>}
 */
const _sharedFolderCache = new Map();
const SHARED_FOLDER_CACHE_TTL = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// Remote master-data cache (used across conflict-check -> resolve lifecycle)
// ---------------------------------------------------------------------------

/**
 * Cached copy of the remote master_data.json fetched during conflict detection.
 * Cleared after a resolution action.
 * @type {{ data: object, fileId: string }|null}
 */
let remoteMasterCache = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise any masterData object to the v2 project schema.
 * Handles the legacy flat schema (pre-project v1) gracefully.
 *
 * @param {object} data  Raw masterData (may be v1 or v2).
 * @returns {object}     Normalised v2 masterData.
 */
function _normaliseToProjectSchema(data) {
    if (data && data.projects) return data;

    const id = crypto.randomUUID();
    return {
        currentProjectId: id,
        projects: [{
            id,
            name: 'Default Project',
            spots:          data?.spots          || [],
            routes:         data?.routes         || [],
            sites:          data?.sites          || [],
            external_files: data?.external_files || [],
            created_at: data?.metadata?.created_at || new Date().toISOString(),
        }],
        metadata: { ...(data?.metadata || {}), schema_version: 2 },
    };
}

/**
 * Detect whether a path looks like a Windows absolute path (e.g. "C:\..." or "E:\...").
 * Such paths must never be used as storage-relative keys — they would create
 * mangled folder names when passed to the File System Access API.
 *
 * @param {string} p
 * @returns {boolean}
 */
function _isAbsoluteOrMalformed(p) {
    if (!p) return true;
    // Drive letter (C:\..., E:/...)
    if (/^[A-Za-z]:[\\/]/.test(p)) return true;
    // UNC path (\\server\share)
    if (p.startsWith('\\\\'))      return true;
    // Unix absolute
    if (p.startsWith('/'))         return true;
    return false;
}

/**
 * Normalise a relative path so it always uses forward slashes.
 * Handles any stray backslashes that may have leaked in from Windows paths.
 *
 * @param {string} p
 * @returns {string}
 */
function _normalisePath(p) {
    return p.replace(/\\/g, '/');
}

/**
 * Collect every file path that is tracked by a project (spots, sites,
 * external files).
 *
 * Skips absolute / malformed paths and reference-only external files that
 * have no locally-stored data to sync.
 *
 * @param {object} project  A single project from masterData.
 * @returns {string[]}
 */
function _gatherProjectFilePaths(project) {
    const paths = [];

    const _add = (p) => {
        if (!p) return;
        const norm = _normalisePath(p);
        // Skip absolute / malformed paths — they are not storage-relative
        // and would create garbled folders if passed to saveFile().
        if (_isAbsoluteOrMalformed(norm)) {
            console.warn('[SyncService] Skipping absolute/malformed path:', p);
            return;
        }
        paths.push(norm);
    };

    (project.spots          || []).forEach(s => {
        _add(s.image_local_filename);
        _add(s.audio_local_filename);
    });
    (project.sites          || []).forEach(s => {
        _add(s.kml_filename);
    });
    (project.external_files || []).forEach(f => {
        // Reference-only files store external system paths — skip them.
        if (f.is_reference) return;
        _add(f.local_path);
    });
    return paths;
}

// ---------------------------------------------------------------------------
// Sync report & status
// ---------------------------------------------------------------------------

/**
 * Build a per-file sync report for one project, showing which files exist
 * locally, on Drive, or in both.
 *
 * Handles two cases:
 *  - Own projects: scans the user's root folder on Drive
 *  - Imported projects: scans the shared folder on the owner's Drive
 *
 * @param {string|null} [targetProjectId]  Defaults to the active project.
 * @param {Array}       [driveFiles]       Pre-fetched Drive file list (own projects only).
 * @returns {Promise<Array<{name:string, isLocal:boolean, isDrive:boolean, driveId:string|null, isImported:boolean}>>}
 */
export async function generateSyncReport(targetProjectId = null, driveFiles = null) {
    const appState   = getLocalState();
    const projectId  = targetProjectId || appState.currentProjectId;
    const project    = appState.projects.find(p => p.id === projectId);

    if (!project) return [];

    // Imported project — scan shared folder instead of own root
    if (project.shared?.isImported) {
        return _generateSharedSyncReport(project);
    }

    // Own project — scan own root folder
    const allDriveFiles = driveFiles ?? await DriveService.listAllDriveFiles();
    const projectFolder = getProjectFolderName(project);

    // Build a map of relativePath -> Drive file for this project's folder
    const driveMap = new Map();
    allDriveFiles.forEach(f => {
        const rp = f.appProperties?.relativePath;
        if (rp && rp.startsWith(projectFolder + '/')) {
            driveMap.set(rp, f);
        }
    });

    const expectedPaths  = _gatherProjectFilePaths(project);
    const processedPaths = new Set();
    const report         = [];

    // Files tracked by the project
    for (const relPath of expectedPaths) {
        processedPaths.add(relPath);
        const item = {
            name:    relPath,
            isLocal: await StorageAdapter.checkFileExists(relPath),
            isDrive: driveMap.has(relPath),
            driveId: driveMap.get(relPath)?.id ?? null,
            isImported: false,
        };
        report.push(item);
    }

    // Drive-only files (not in the project's tracked list)
    for (const [relPath, driveFile] of driveMap.entries()) {
        if (!processedPaths.has(relPath)) {
            report.push({
                name:    relPath,
                isLocal: false,
                isDrive: true,
                driveId: driveFile.id,
                isImported: false,
            });
        }
    }

    return report;
}

/**
 * Generate sync report for an imported (shared) project.
 * Scans the shared folder on the owner's Drive and compares with local files.
 *
 * @param {object} project  The imported project object.
 * @returns {Promise<Array>}
 */
async function _generateSharedSyncReport(project) {
    const { sourceFolderId } = project.shared;
    if (!sourceFolderId) return [];

    // List all files in the shared folder (with TTL cache to avoid repeated scans)
    let sharedFiles;
    const cached = _sharedFolderCache.get(sourceFolderId);
    if (cached && (Date.now() - cached.fetchedAt) < SHARED_FOLDER_CACHE_TTL) {
        sharedFiles = cached.files;
    } else {
        try {
            sharedFiles = await DriveService.listAllFilesInFolder(sourceFolderId);
            _sharedFolderCache.set(sourceFolderId, { files: sharedFiles, fetchedAt: Date.now() });
        } catch (err) {
            console.warn('[SyncService] Could not list shared folder:', err);
            return [];
        }
    }

    const projectFolder = getProjectFolderName(project);
    const report = [];

    // Build folder-ID-to-name map for path reconstruction fallback
    const folderMap = new Map();
    folderMap.set(sourceFolderId, ''); // root of shared folder
    for (const f of sharedFiles) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
            // Build relative path from parent chain
            const parentId = f.parents?.[0];
            const parentPath = folderMap.get(parentId) ?? '';
            folderMap.set(f.id, parentPath ? `${parentPath}/${f.name}` : f.name);
        }
    }

    for (const file of sharedFiles) {
        // Skip folders and metadata files
        if (file.mimeType === 'application/vnd.google-apps.folder') continue;
        if (file.name === 'project_data.json') continue;
        if (file.name === 'editor_contributions.json') continue;

        // Try appProperties.relativePath first (set by owner's app)
        let localPath = null;
        const relPath = file.appProperties?.relativePath;

        if (relPath) {
            // Remap owner's folder prefix to our local project folder
            const ownerFolderPrefix = relPath.split('/')[0];
            const pathSuffix = relPath.substring(ownerFolderPrefix.length);
            localPath = projectFolder + pathSuffix;
        } else {
            // Fallback: reconstruct path from Drive folder hierarchy
            const parentId = file.parents?.[0];
            const parentPath = folderMap.get(parentId);
            if (parentPath !== undefined) {
                const subPath = parentPath
                    ? `${parentPath}/${file.name}`
                    : file.name;
                localPath = `${projectFolder}/${subPath}`;
            } else {
                // Can't determine path — skip
                console.warn(`[SyncService] Skipping file with unknown parent: ${file.name}`);
                continue;
            }
        }

        const isLocal = await StorageAdapter.checkFileExists(localPath);

        report.push({
            name:       localPath,
            isLocal,
            isDrive:    true,
            driveId:    file.id,
            isImported: true,
        });
    }

    // Also check local-only files (files tracked by project but not on shared Drive)
    const expectedPaths = _gatherProjectFilePaths(project);
    const drivePathSet = new Set(report.map(r => r.name));

    for (const localPath of expectedPaths) {
        if (!drivePathSet.has(localPath)) {
            const isLocal = await StorageAdapter.checkFileExists(localPath);
            if (isLocal) {
                report.push({
                    name:       localPath,
                    isLocal:    true,
                    isDrive:    false,
                    driveId:    null,
                    isImported: true,
                });
            }
        }
    }

    return report;
}

/**
 * Return a map of `{ projectId -> boolean }` indicating whether each
 * project's files are fully synced (exist both locally and on Drive with
 * no orphans).
 *
 * One `listAllDriveFiles()` call is shared for all projects.
 *
 * @returns {Promise<Record<string, boolean>>}
 */
export async function getAllProjectsSyncStatus() {
    const appState = getLocalState();
    const statuses = {};

    // Shared Drive file fetch — avoids one request per project
    const allDriveFiles = await DriveService.listAllDriveFiles();
    const drivePaths    = new Set(
        allDriveFiles
            .map(f => f.appProperties?.relativePath)
            .filter(Boolean)
    );

    for (const project of appState.projects) {
        // Imported projects: mark as synced if recently synced, skip heavy scan
        if (project.shared?.isImported) {
            const lastSync = project.shared.lastSyncedAt;
            statuses[project.id] = !!lastSync; // true if ever synced
            continue;
        }

        const projectFolder  = getProjectFolderName(project);
        const expectedPaths  = _gatherProjectFilePaths(project);

        // Parallel local-existence checks instead of serial await per file
        const localChecks = await Promise.allSettled(
            expectedPaths.map(p => StorageAdapter.checkFileExists(p))
        );

        let isSynced = true;
        for (let i = 0; i < expectedPaths.length; i++) {
            const hasDrive = drivePaths.has(expectedPaths[i]);
            const hasLocal = localChecks[i].status === 'fulfilled' && localChecks[i].value;
            if (!hasDrive || !hasLocal) { isSynced = false; break; }
        }

        // No Drive file for this project should be missing locally
        if (isSynced) {
            const expectedSet = new Set(expectedPaths);
            for (const drivePath of drivePaths) {
                if (
                    drivePath.startsWith(projectFolder + '/') &&
                    !expectedSet.has(drivePath)
                ) {
                    isSynced = false;
                    break;
                }
            }
        }

        statuses[project.id] = isSynced;
    }

    return statuses;
}

// ---------------------------------------------------------------------------
// Individual file sync operations
// ---------------------------------------------------------------------------

/**
 * Push a single local file to Drive (upsert — update if it exists, create
 * if it does not).
 *
 * The existing Drive file is identified by `appProperties.relativePath` so
 * the lookup works even if the filename was changed locally.
 *
 * @param {string} relPath  App-relative path of the local file to push.
 */
export async function syncUp(relPath) {
    // Normalise backslashes → forward slashes.
    const normPath = _normalisePath(relPath);

    if (_isAbsoluteOrMalformed(normPath)) {
        console.error('[SyncService] Refusing to push absolute/malformed path:', relPath);
        return;
    }

    const rootFolderId = await DriveService.findOrCreateRootFolder();
    const fileBlob     = await StorageAdapter.getFileBlob(normPath);
    if (!fileBlob) throw new Error(`[SyncService] Local file not found: ${normPath}`);

    if (normPath === 'master_data.json') {
        // Master JSON lives directly in the root folder. Idempotent upsert
        // prevents duplicate master_data.json under concurrent pushes.
        await DriveService.upsertFile('master_data.json', rootFolderId, fileBlob, 'application/json', normPath);
        return;
    }

    // For media files: check by relativePath appProperty across all Drive files
    const allFiles     = await DriveService.listAllDriveFiles();
    const existingFile = allFiles.find(f => f.appProperties?.relativePath === normPath);

    if (existingFile) {
        // File already on Drive — update the content in-place
        await DriveService.updateDriveFile(existingFile.id, fileBlob);
    } else {
        // New file — resolve folder path and upload
        const parts    = normPath.split('/');
        const filename = parts.pop();
        const parentId = await DriveService.ensureDrivePath(parts, rootFolderId);
        await DriveService.uploadFile(
            fileBlob,
            filename,
            fileBlob.type || 'application/octet-stream',
            parentId,
            normPath
        );
    }
}

/**
 * Pull a single Drive file to local storage.
 *
 * @param {string} driveId  Drive file ID.
 * @param {string} relPath  App-relative destination path.
 */
export async function syncDown(driveId, relPath) {
    // Normalise backslashes → forward slashes before splitting.
    const normPath = _normalisePath(relPath);

    // Reject absolute paths — they should never have been stored as
    // relativePath metadata on Drive.  Pulling them would create mangled
    // folders inside the user's root directory.
    if (_isAbsoluteOrMalformed(normPath)) {
        console.error('[SyncService] Refusing to pull absolute/malformed path:', relPath);
        return;
    }

    const blob = await DriveService.downloadBlob(driveId);

    if (normPath === 'master_data.json') {
        const text = await blob.text();
        const data = JSON.parse(text);
        await StorageAdapter.saveMasterData(data);
    } else {
        const parts    = normPath.split('/');
        const filename = parts.pop();
        await StorageAdapter.saveFile(blob, filename, parts);
    }
}

// ---------------------------------------------------------------------------
// Batch sync
// ---------------------------------------------------------------------------

/**
 * Push or pull a batch of files, emitting progress events after each item.
 *
 * The `isSyncing` mutex uses try/finally so it is always cleared even when
 * an unexpected error propagates out of the loop.
 *
 * @param {Array<{name:string, driveId?:string, isImported?:boolean}>} items  Files to sync.
 * @param {'push'|'pull'}                          direction  Sync direction.
 * @param {AbortSignal}  [signal]  Optional signal to cancel the batch mid-run.
 * @param {string|null}  [projectId]  If provided and project is imported, routes push to shared folder.
 * @returns {Promise<{success:number, failed:number}>}
 */
export async function syncBatch(items, direction, signal, projectId = null) {
    if (isSyncing) {
        throw new Error('[SyncService] A sync operation is already running.');
    }

    // Lazy-import to avoid circular dependency
    const { pushMediaToSharedFolder } = await import('./SharingService.js');

    // Determine if we're working on an imported project
    let isImportedProject = false;
    if (projectId) {
        const appState = getLocalState();
        const proj = appState.projects.find(p => p.id === projectId);
        isImportedProject = !!proj?.shared?.isImported && proj.shared.permission === 'writer';
    }

    isSyncing = true;
    let successCount = 0;
    let failCount    = 0;

    try {
        for (let i = 0; i < items.length; i++) {
            // Check for cancellation before each file
            if (signal?.aborted) {
                console.log('[SyncService] Batch cancelled by AbortSignal.');
                break;
            }

            const item = items[i];
            try {
                if (direction === 'push') {
                    // For imported projects, push media to shared folder instead of own root
                    if (isImportedProject && item.isImported) {
                        await pushMediaToSharedFolder(projectId, item.name);
                    } else {
                        await syncUp(item.name);
                    }
                } else if (direction === 'pull') {
                    if (!item.driveId) throw new Error('Missing Drive ID for pull');
                    await syncDown(item.driveId, item.name);
                }
                successCount++;
            } catch (err) {
                if (err.name === 'AbortError') break; // fetch was cancelled
                console.error(`[SyncService] Failed to ${direction} "${item.name}":`, err);
                failCount++;
            }

            const percent = Math.round(((i + 1) / items.length) * 100);
            EventBus.emit(EVENTS.SYNC_PROGRESS, {
                percent,
                currentFile: item.name,
                fails: failCount,
            });
        }
    } finally {
        isSyncing = false;
    }

    EventBus.emit(EVENTS.SYNC_BATCH_COMPLETE, {
        success: successCount,
        failed:  failCount,
        direction,
    });

    return { success: successCount, failed: failCount };
}

// ---------------------------------------------------------------------------
// Master-data conflict detection & resolution
// ---------------------------------------------------------------------------

/**
 * Compare local masterData with the copy on Drive.
 *
 * - If signatures match: show a "you are up to date" toast (interactive mode).
 * - If they differ: cache the remote copy and emit MASTER_SYNC_CONFLICT so
 *   the UI can render the conflict resolution modal.
 * - Uses EventBus toasts instead of `alert()` for non-blocking UX.
 *
 * @param {boolean} [interactive=false]  Show toasts for "clean" / "no remote" states.
 */
export async function checkForRemoteUpdates(interactive = false) {
    if (!getAccessToken()) return;

    try {
        const rootFolderId = await DriveService.findOrCreateRootFolder();
        const driveFile    = await DriveService.findFileByName('master_data.json', rootFolderId);

        if (!driveFile) {
            if (interactive) {
                EventBus.emit(EVENTS.TOAST_SHOW, {
                    message: 'No master file on Drive — uploading local copy...',
                    type: 'info',
                });
                const localState = getLocalState();
                // Strip imported projects — they don't belong on our Drive
                const cleanState = {
                    ...localState,
                    projects: (localState.projects || []).filter(p => !p.shared?.isImported),
                };
                const blob = new Blob(
                    [JSON.stringify(cleanState, null, 2)],
                    { type: 'application/json' }
                );
                await DriveService.upsertFile('master_data.json', rootFolderId, blob, 'application/json', 'master_data.json');
                EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Master data uploaded to Drive.', type: 'success' });
            }
            return;
        }

        const remoteText = await DriveService.readDriveTextFile(driveFile.id);
        const remoteData = JSON.parse(remoteText);
        const localData  = getLocalState();

        // Strip imported projects from local before comparing — they exist only
        // locally and would always cause a signature mismatch vs remote.
        const localForCompare = {
            ...localData,
            projects: (localData.projects || []).filter(p => !p.shared?.isImported),
        };

        const localSignature  = generateDataSignature(localForCompare);
        const remoteSignature = generateDataSignature(remoteData);

        if (localSignature === remoteSignature) {
            console.log('[SyncService] Sync clean — signatures match.');
            if (interactive) {
                EventBus.emit(EVENTS.TOAST_SHOW, { message: 'You are up to date.', type: 'success' });
            }
            return;
        }

        console.warn('[SyncService] Remote updates detected.');
        remoteMasterCache = { data: remoteData, fileId: driveFile.id };

        // Count spots across all projects for the conflict modal summary
        const localCount  = localData.projects?.reduce((n, p) => n + (p.spots?.length ?? 0), 0) ?? 0;
        const remoteCount = remoteData.projects
            ? remoteData.projects.reduce((n, p) => n + (p.spots?.length ?? 0), 0)
            : (remoteData.spots?.length ?? 0);

        EventBus.emit(EVENTS.MASTER_SYNC_CONFLICT, { localCount, remoteCount });

    } catch (err) {
        console.error('[SyncService] checkForRemoteUpdates error:', err);
        if (interactive) {
            EventBus.emit(EVENTS.TOAST_SHOW, {
                message: `Sync check failed: ${err.message}`,
                type: 'error',
            });
        }
    }
}

/**
 * Execute the user's chosen conflict resolution strategy.
 *
 * @param {'pull'|'push'|'merge'} action
 *   - `pull`  — overwrite local with the remote copy.
 *   - `push`  — overwrite Drive with the local copy.
 *   - `merge` — last-write-wins merge at item level, then push the result.
 */
export async function resolveMasterConflict(action) {
    if (!remoteMasterCache) return;
    const { data: remoteData, fileId } = remoteMasterCache;

    try {
        if (action === 'pull') {
            const normalised = _normaliseToProjectSchema(remoteData);
            await replaceState(normalised);
            EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Pulled from Drive successfully.', type: 'success' });

        } else if (action === 'push') {
            const localData = getLocalState();
            const blob = new Blob(
                [JSON.stringify(localData, null, 2)],
                { type: 'application/json' }
            );
            await DriveService.updateDriveFile(fileId, blob);
            EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Pushed to Drive successfully.', type: 'success' });

        } else if (action === 'merge') {
            const localData = getLocalState();
            const merged    = mergeDatasets(localData, remoteData);
            await replaceState(merged);

            const blob = new Blob(
                [JSON.stringify(merged, null, 2)],
                { type: 'application/json' }
            );
            await DriveService.updateDriveFile(fileId, blob);
            EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Merged local and Drive data.', type: 'success' });
        }

        // Media/results follow the metadata: after a Drive-wins pull or a merge,
        // download anything referenced but missing locally and push local-only
        // files up (bidirectional — see ProjectFilesSync.reconcileProjectFiles).
        if (action === 'pull' || action === 'merge') {
            try {
                const { reconcileProjectFiles } = await import('./ProjectFilesSync.js');
                const { getActiveProject } = await import('../data/MasterData.js');
                const active = getActiveProject();
                if (active) await reconcileProjectFiles(active);
            } catch (e) {
                console.warn('[SyncService] media reconcile after conflict failed:', e.message);
            }
        }

        remoteMasterCache = null;

        // Pull / merge may have orphaned local files — sweep them.
        if (action === 'pull' || action === 'merge') {
            try {
                const { gcAndRefresh } = await import('./StorageGC.js');
                await gcAndRefresh();
            } catch (e) { console.warn('[SyncService] post-resolution GC failed:', e.message); }
        }

        // Notify the rest of the app that data has changed
        EventBus.emit(EVENTS.DATA_UPDATED);
        EventBus.emit(EVENTS.PROJECT_CHANGED);

    } catch (err) {
        console.error('[SyncService] resolveMasterConflict error:', err);
        EventBus.emit(EVENTS.TOAST_SHOW, {
            message: `Resolution failed: ${err.message}`,
            type: 'error',
        });
    }
}

// ---------------------------------------------------------------------------
// Interactive diff resolution (git-diff style conflict UI)
// ---------------------------------------------------------------------------

/**
 * Snapshot the data needed to render the interactive local-vs-Drive diff.
 * Returns the live local state and the cached remote master captured when the
 * conflict was detected. Null remote means there is nothing to diff against.
 *
 * @returns {{ local: object|null, remote: object|null, fileId: string|null }}
 */
export function getConflictSnapshot() {
    return {
        local:  getLocalState(),
        remote: remoteMasterCache?.data || null,
        fileId: remoteMasterCache?.fileId || null,
    };
}

/**
 * Apply a fully user-resolved master state produced by the diff UI.
 *
 * The resolved state is the single source of truth chosen by the user — it is
 * saved locally AND written to Drive so both sides end up identical (the whole
 * point of the diff workflow). Imported projects are kept locally but stripped
 * from the Drive copy (they live in their owners' Drives, not ours).
 *
 * @param {object} resolvedState  Full v2 masterData to become the new truth.
 * @returns {Promise<void>}
 */
export async function applyResolvedConflict(resolvedState) {
    const fileId = remoteMasterCache?.fileId || null;

    // 1) Local truth.
    await replaceState(resolvedState);

    // 2) Drive truth — strip imported projects (not part of our Drive master).
    if (fileId && getAccessToken()) {
        const driveState = {
            ...resolvedState,
            projects: (resolvedState.projects || []).filter(p => !p.shared?.isImported),
        };
        const blob = new Blob([JSON.stringify(driveState, null, 2)], { type: 'application/json' });
        try {
            await DriveService.updateDriveFile(fileId, blob);
        } catch (err) {
            console.error('[SyncService] applyResolvedConflict: Drive write failed:', err);
            EventBus.emit(EVENTS.TOAST_SHOW, {
                message: `Saved locally, but Drive update failed: ${err.message}`,
                type: 'error',
            });
        }
    }

    // 3) Media follows metadata: pull anything referenced but missing, push
    //    local-only files up.
    try {
        const { reconcileProjectFiles } = await import('./ProjectFilesSync.js');
        const { getActiveProject } = await import('../data/MasterData.js');
        const active = getActiveProject();
        if (active) await reconcileProjectFiles(active);
    } catch (e) {
        console.warn('[SyncService] media reconcile after resolution failed:', e.message);
    }

    remoteMasterCache = null;

    // Resolving a conflict can orphan whole project folders (e.g. Drive-wins
    // replaces local projects with new-id copies). Sweep dead local files.
    try {
        const { gcAndRefresh } = await import('./StorageGC.js');
        await gcAndRefresh();
    } catch (e) { console.warn('[SyncService] post-resolution GC failed:', e.message); }

    EventBus.emit(EVENTS.DATA_UPDATED);
    EventBus.emit(EVENTS.PROJECT_CHANGED);
    EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Local and Drive are now in sync.', type: 'success' });
}

// ---------------------------------------------------------------------------
// Dataset merge (last-write-wins at item level)
// ---------------------------------------------------------------------------

/**
 * Merge two masterData objects using last-write-wins semantics at the
 * individual item level (spot, site, route, external_file).
 *
 * - Projects present on both sides have their item arrays merged.
 * - Projects present on only one side are kept as-is.
 * - `currentProjectId` is always taken from the local copy.
 * - `metadata.last_merged` is stamped with the current timestamp.
 *
 * @param {object} local   Local masterData (may be v1 or v2 schema).
 * @param {object} remote  Remote masterData (may be v1 or v2 schema).
 * @returns {object}       Merged v2 masterData ready for persistence.
 */
export function mergeDatasets(local, remote) {
    const l = _normaliseToProjectSchema(local);
    const r = _normaliseToProjectSchema(remote);

    /**
     * Merge two item arrays by id (spotId or id), keeping the item with the
     * later `timestamp` when both sides have the same id.
     *
     * @param {object[]} arr1
     * @param {object[]} arr2
     * @returns {object[]}
     */
    function _mergeArray(arr1 = [], arr2 = []) {
        const map = new Map();
        [...arr1, ...arr2].forEach(item => {
            const id = item.spotId || item.id;
            if (!id) return;
            const existing     = map.get(id);
            const newTime      = new Date(item.timestamp      || 0).getTime();
            const existingTime = new Date(existing?.timestamp || 0).getTime();
            if (!existing || newTime > existingTime) map.set(id, item);
        });
        return Array.from(map.values());
    }

    // Merge at project level
    const projectMap = new Map();

    l.projects.forEach(p => projectMap.set(p.id, { ...p }));

    r.projects.forEach(rp => {
        if (projectMap.has(rp.id)) {
            // Project exists on both sides — merge item arrays
            const lp = projectMap.get(rp.id);
            projectMap.set(rp.id, {
                ...lp,
                spots:          _mergeArray(lp.spots,          rp.spots),
                routes:         _mergeArray(lp.routes,         rp.routes),
                sites:          _mergeArray(lp.sites,          rp.sites),
                jobs:           _mergeArray(lp.jobs,           rp.jobs),
                external_files: _mergeArray(lp.external_files, rp.external_files),
            });
        } else {
            // Remote-only project — add wholesale
            projectMap.set(rp.id, { ...rp });
        }
    });

    return {
        currentProjectId: l.currentProjectId,
        projects: Array.from(projectMap.values()),
        metadata: {
            ...l.metadata,
            last_merged:    new Date().toISOString(),
            schema_version: 2,
        },
    };
}
