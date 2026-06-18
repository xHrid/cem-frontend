/**
 * SharedMediaSync.js — Automatic media synchronisation for shared projects
 *
 * Architecture:
 *  - Listens for MEDIA_SAVED events from Repository
 *  - For imported editor projects: auto-pushes media to shared Drive folder
 *  - For owner's shared projects: auto-pushes media to own project Drive folder
 *  - External imports (isExternal: true) are SKIPPED — manual sync only
 *  - Uses a queue + debounce to batch rapid saves (e.g. multi-image spot)
 *  - Retries failed uploads up to 3 times with exponential backoff
 *
 * This replaces the broken flow where editors had to manually push media
 * and it silently went to the wrong folder (their own root instead of shared).
 *
 * Public exports:
 *   initSharedMediaSync()  — call once at app startup
 *   getMediaSyncStatus()   — returns queue state for UI indicators
 */

import EventBus, { EVENTS } from '../core/EventBus.js';
import * as DriveService from './DriveService.js';
import * as MasterData from '../data/MasterData.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import { getProjectFolderName } from '../data/projectUtils.js';
import { getAccessToken } from './AuthService.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;       // 2s, 4s, 8s exponential backoff
const DEBOUNCE_MS = 1500;         // Wait 1.5s after last save before processing queue
const MAX_CONCURRENT = 2;         // Max parallel uploads

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Queue of media files waiting to be pushed.
 * @type {Array<{projectId: string, relPath: string, retries: number}>}
 */
const _queue = [];

/** Currently uploading count */
let _activeUploads = 0;

/** Debounce timer ID */
let _debounceTimer = null;

/** Stats for UI */
let _stats = { pushed: 0, failed: 0, pending: 0 };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the shared media sync listener.
 * Call once from App.js after DOMContentLoaded.
 */
export function initSharedMediaSync() {
    EventBus.on(EVENTS.MEDIA_SAVED, ({ data }) => {
        const { projectId, relPath, isExternal } = data;

        // External/imported media (referenced OR copied) is NEVER uploaded or
        // shared — no blobs, no paths. Only in-app captures (spot photos/audio,
        // site KML) sync to Drive.
        if (isExternal) {
            console.log('[SharedMediaSync] External media — never synced:', relPath);
            return;
        }

        // Skip if not logged in to Drive
        if (!getAccessToken()) {
            console.log('[SharedMediaSync] Not logged in, skipping auto-push:', relPath);
            return;
        }

        // Verify project exists
        const state = MasterData.getLocalState();
        const project = state.projects.find(p => p.id === projectId);
        if (!project) return;

        // ALL non-external media auto-pushes to Drive. No exceptions.
        // For imported editor projects → pushed to shared folder
        // For ALL other projects (owner, shared or not) → pushed to own Drive folder

        // Add to queue (dedup by relPath)
        const exists = _queue.some(q => q.projectId === projectId && q.relPath === relPath);
        if (!exists) {
            _queue.push({ projectId, relPath, retries: 0 });
            _stats.pending = _queue.length;
            console.log(`[SharedMediaSync] Queued: ${relPath} (${_queue.length} pending)`);
        }

        // Debounce — wait for rapid saves to settle before processing
        _scheduleDrain();
    });

    // NOTE: project-level pull/merge on switch is owned by SyncEngine
    // (_syncActiveSharedProject). This module only handles media uploads.

    // After storage ready + auth likely complete, scan for unsynced media
    // This catches files saved while user was offline/logged-out
    EventBus.on(EVENTS.STORAGE_READY, () => {
        // Delay to let auth complete (auth happens async after storage)
        setTimeout(() => _catchUpUnsyncedMedia(), 5000);
    });

    // Also try catch-up when data updates (covers post-login scenarios)
    let _catchUpDone = false;
    EventBus.on(EVENTS.DATA_UPDATED, () => {
        if (_catchUpDone || !getAccessToken()) return;
        _catchUpDone = true;
        setTimeout(() => _catchUpUnsyncedMedia(), 2000);
    });

    console.log('[SharedMediaSync] Initialized — listening for MEDIA_SAVED + PROJECT_CHANGED.');
}

/**
 * Scan all projects for media files that exist locally but not on Drive.
 * Queues them for upload. Called after login to catch up files saved while offline.
 */
async function _catchUpUnsyncedMedia() {
    if (!getAccessToken()) return;

    const state = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === state.currentProjectId);
    if (!project) return;

    // Skip imported projects — they sync via PROJECT_CHANGED handler
    if (project.shared?.isImported) return;

    // Gather all media paths for active project
    const mediaPaths = [];
    for (const spot of (project.spots || [])) {
        // Multi-image: iterate images[] array
        const imgPaths = spot.images && spot.images.length > 0
            ? spot.images
            : (spot.image_local_filename ? [spot.image_local_filename] : []);
        for (const p of imgPaths) mediaPaths.push(p);
        if (spot.audio_local_filename) mediaPaths.push(spot.audio_local_filename);
    }
    for (const site of (project.sites || [])) {
        if (site.kml_filename) mediaPaths.push(site.kml_filename);
    }

    // external_files are intentionally excluded — external media never syncs.

    if (mediaPaths.length === 0) return;

    // Check which are already on Drive
    let driveFiles;
    try {
        driveFiles = await DriveService.listAllDriveFiles();
    } catch { return; }

    const drivePaths = new Set(
        driveFiles.map(f => f.appProperties?.relativePath).filter(Boolean)
    );

    // Queue any that are local-only
    let queued = 0;
    for (const relPath of mediaPaths) {
        if (drivePaths.has(relPath)) continue; // Already on Drive

        // Verify local file exists
        const exists = await StorageAdapter.checkFileExists(relPath);
        if (!exists) continue;

        const alreadyQueued = _queue.some(q => q.relPath === relPath);
        if (!alreadyQueued) {
            _queue.push({ projectId: project.id, relPath, retries: 0 });
            queued++;
        }
    }

    if (queued > 0) {
        _stats.pending = _queue.length;
        console.log(`[SharedMediaSync] Catch-up: queued ${queued} unsynced media file(s).`);
        _scheduleDrain();
    }
}

/**
 * Get current sync status for UI indicators.
 * @returns {{ pushed: number, failed: number, pending: number, active: number }}
 */
export function getMediaSyncStatus() {
    return { ..._stats, active: _activeUploads, pending: _queue.length };
}

// ---------------------------------------------------------------------------
// Internal: Queue processing
// ---------------------------------------------------------------------------

function _scheduleDrain() {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(_drainQueue, DEBOUNCE_MS);
}

async function _drainQueue() {
    _debounceTimer = null;

    // Collect all promises so we can notify when batch completes
    const promises = [];

    while (_queue.length > 0 && _activeUploads < MAX_CONCURRENT) {
        const item = _queue.shift();
        _stats.pending = _queue.length;
        _activeUploads++;

        const p = _processItem(item).finally(() => {
            _activeUploads--;
        });
        promises.push(p);
    }

    // Wait for current batch, then notify UI and drain remaining
    if (promises.length > 0) {
        await Promise.allSettled(promises);

        // Notify UI so Sync Dashboard refreshes
        EventBus.emit(EVENTS.SYNC_BATCH_COMPLETE, {
            success: _stats.pushed,
            failed: _stats.failed,
            direction: 'push',
        });

        // Continue draining if more items queued during processing
        if (_queue.length > 0) _scheduleDrain();
    }
}

/**
 * Process a single media upload item.
 * Routes to shared folder (imported editor) or own project folder (owner).
 */
async function _processItem(item) {
    const { projectId, relPath, retries } = item;

    try {
        const state = MasterData.getLocalState();
        const project = state.projects.find(p => p.id === projectId);
        if (!project) {
            console.warn('[SharedMediaSync] Project gone, dropping:', projectId);
            return;
        }

        const isImportedEditor = project.shared?.isImported && project.shared?.permission === 'writer';
        const isShared = isImportedEditor || project.sharing?.isShared;

        let fileId = null;
        if (isImportedEditor) {
            // Editor → push to owner's shared folder so owner can see it
            fileId = await _pushToSharedFolder(project, relPath);
        } else {
            // Any other project (owner, shared or not) → push to own Drive folder
            fileId = await _pushToOwnProjectFolder(project, relPath);
        }

        // For SHARED projects, make the media link-public and record its Drive
        // ID on the spot/site so the OTHER side (who can't list our folder under
        // drive.file) can display it via a public URL.
        if (isShared && fileId) {
            await DriveService.makeFilePublic(fileId);
            _recordDriveId(project, relPath, fileId);
        }

        _stats.pushed++;
        console.log(`[SharedMediaSync] ✓ Pushed: ${relPath}`);

    } catch (err) {
        console.error(`[SharedMediaSync] ✗ Failed (attempt ${retries + 1}): ${relPath}`, err.message);

        if (retries < MAX_RETRIES) {
            // Re-queue with backoff
            const delay = RETRY_BASE_MS * Math.pow(2, retries);
            setTimeout(() => {
                _queue.push({ projectId, relPath, retries: retries + 1 });
                _stats.pending = _queue.length;
                _scheduleDrain();
            }, delay);
        } else {
            _stats.failed++;
            console.error(`[SharedMediaSync] Gave up after ${MAX_RETRIES} retries: ${relPath}`);
            EventBus.emit(EVENTS.TOAST_SHOW, {
                message: `Failed to sync media: ${relPath.split('/').pop()}`,
                type: 'error',
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Internal: Upload to shared folder (editor → owner's Drive folder)
// ---------------------------------------------------------------------------

/**
 * Push a media file into the shared project folder on the owner's Drive.
 * This is what makes editor media visible to the owner.
 *
 * Path mapping:
 *   Local: "MyProject_abc123/spots/Deer/images/Deer_cover.jpg"
 *   Owner: "OwnerProject_def456/spots/Deer/images/Deer_cover.jpg"
 *   Drive: [sharedFolderId]/spots/Deer/images/Deer_cover.jpg
 */
async function _pushToSharedFolder(project, relPath) {
    const { sourceFolderId, ownerFolderName } = project.shared;
    if (!sourceFolderId) throw new Error('No sourceFolderId on imported project');

    // Get the file blob from local storage
    const fileBlob = await StorageAdapter.getFileBlob(relPath);
    if (!fileBlob) throw new Error(`Local file not found: ${relPath}`);

    // Remap local folder prefix → owner's folder prefix
    const localFolder = getProjectFolderName(project);
    const ownerFolder = ownerFolderName || localFolder;

    let targetPath = relPath;
    if (relPath.startsWith(localFolder + '/')) {
        targetPath = ownerFolder + relPath.substring(localFolder.length);
    }

    // Split path: remove project root folder (the shared folder IS the project root)
    // e.g. "OwnerProject_def456/spots/Deer/images/Deer_cover.jpg"
    //  → folders: ["spots", "Deer", "images"]
    //  → filename: "Deer_cover.jpg"
    const parts = targetPath.split('/');
    parts.shift(); // Remove project folder name (mapped to sourceFolderId)
    const filename = parts.pop();

    if (!filename) throw new Error(`Invalid relPath after split: ${relPath}`);

    // Ensure subfolders exist inside shared folder
    let parentId = sourceFolderId;
    if (parts.length > 0) {
        parentId = await DriveService.ensureDrivePath(parts, sourceFolderId);
    }

    // Check if file already exists (avoid duplicates on retry)
    const existing = await DriveService.findFileByName(filename, parentId);
    if (existing) {
        await DriveService.updateDriveFile(existing.id, fileBlob);
        return existing.id;
    }
    const created = await DriveService.uploadFile(
        fileBlob,
        filename,
        fileBlob.type || 'application/octet-stream',
        parentId,
        targetPath
    );
    return created.id;
}

// ---------------------------------------------------------------------------
// Internal: Upload to own project folder (owner's auto-sync)
// ---------------------------------------------------------------------------

/**
 * Push media to the owner's own project folder on Drive.
 * This ensures shared project media is on Drive for editors to pull.
 */
async function _pushToOwnProjectFolder(project, relPath) {
    const fileBlob = await StorageAdapter.getFileBlob(relPath);
    if (!fileBlob) throw new Error(`Local file not found: ${relPath}`);

    const rootFolderId = await DriveService.findOrCreateRootFolder();

    // Split into folder path + filename
    const parts = relPath.split('/');
    const filename = parts.pop();

    if (!filename) throw new Error(`Invalid relPath: ${relPath}`);

    // Ensure folder structure exists
    let parentId = rootFolderId;
    if (parts.length > 0) {
        parentId = await DriveService.ensureDrivePath(parts, rootFolderId);
    }

    // Check if already exists (upsert)
    const existing = await DriveService.findFileByName(filename, parentId);
    if (existing) {
        await DriveService.updateDriveFile(existing.id, fileBlob);
        return existing.id;
    }
    const created = await DriveService.uploadFile(
        fileBlob,
        filename,
        fileBlob.type || 'application/octet-stream',
        parentId,
        relPath
    );
    return created.id;
}

/**
 * Record a media file's Drive ID on the matching spot/site record so the other
 * collaborator can display it via a public URL (they can't list our folder
 * under drive.file). Triggers a project_data.json re-push via DATA_UPDATED.
 *
 * @param {object} project
 * @param {string} relPath  Local relative path of the media file.
 * @param {string} fileId   Drive file ID (now public).
 */
function _recordDriveId(project, relPath, fileId) {
    let changed = false;
    // Bump timestamp when a new drive_id is stamped so last-write-wins merges
    // carry the drive_id across to the other collaborator (a plain field edit
    // does NOT change the item's timestamp, so without this the public ID is
    // dropped on merge and the media never shows on the other side).
    const now = new Date().toISOString();
    for (const spot of (project.spots || [])) {
        // Multi-image: check images[] array first, then legacy single field
        const imgPaths = spot.images && spot.images.length > 0
            ? spot.images
            : (spot.image_local_filename ? [spot.image_local_filename] : []);
        const imgIdx = imgPaths.indexOf(relPath);
        if (imgIdx >= 0) {
            if (!spot.image_drive_ids) spot.image_drive_ids = [];
            // Pad array to match index
            while (spot.image_drive_ids.length < imgPaths.length) spot.image_drive_ids.push(null);
            if (spot.image_drive_ids[imgIdx] !== fileId) {
                spot.image_drive_ids[imgIdx] = fileId;
                // Keep legacy field in sync with first image
                if (imgIdx === 0) spot.image_drive_id = fileId;
                spot.timestamp = now;
                changed = true;
            }
        }
        if (spot.audio_local_filename === relPath && spot.audio_drive_id !== fileId) {
            spot.audio_drive_id = fileId; spot.timestamp = now; changed = true;
        }
    }
    for (const site of (project.sites || [])) {
        if (site.kml_filename === relPath && site.kml_drive_id !== fileId) {
            site.kml_drive_id = fileId; site.timestamp = now; changed = true;
        }
    }
    for (const route of (project.routes || [])) {
        for (const a of (route.annotations || [])) {
            if (a.image_local_filename === relPath && a.image_drive_id !== fileId) {
                a.image_drive_id = fileId; a.timestamp = now; route.timestamp = now; changed = true;
            }
            if (a.audio_local_filename === relPath && a.audio_drive_id !== fileId) {
                a.audio_drive_id = fileId; a.timestamp = now; route.timestamp = now; changed = true;
            }
        }
    }
    for (const job of (project.jobs || [])) {
        if (job.job_file === relPath && job.job_file_drive_id !== fileId) {
            job.job_file_drive_id = fileId; job.timestamp = now; changed = true;
        }
        for (const rf of (job.result_files || [])) {
            if (rf.rel_path === relPath && rf.drive_id !== fileId) {
                rf.drive_id = fileId; job.timestamp = now; changed = true;
            }
        }
    }
    if (changed) {
        MasterData.saveMasterData();
        EventBus.emit(EVENTS.DATA_UPDATED); // re-push project_data.json with the IDs
    }
}
