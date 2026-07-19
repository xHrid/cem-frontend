import EventBus, { EVENTS } from '../core/EventBus.js';
import * as DriveService from './DriveService.js';
import * as MasterData from '../data/MasterData.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import { getAccessToken } from './AuthService.js';
import { touch } from '../data/mergeUtils.js';
import { enumerateFileRefs } from './ProjectFilesSync.js';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;
const DEBOUNCE_MS = 1500;
const MAX_CONCURRENT = 2;

const _queue = [];

let _activeUploads = 0;

let _debounceTimer = null;

let _stats = { pushed: 0, failed: 0, pending: 0 };

export function initSharedMediaSync() {
    EventBus.on(EVENTS.MEDIA_SAVED, ({ data }) => {
        const { projectId, relPath, isExternal } = data;

        if (isExternal) {
            return;
        }

        if (!getAccessToken()) {
            return;
        }

        const state = MasterData.getLocalState();
        const project = state.projects.find(p => p.id === projectId);
        if (!project) return;

        const exists = _queue.some(q => q.projectId === projectId && q.relPath === relPath);
        if (!exists) {
            _queue.push({ projectId, relPath, retries: 0 });
            _stats.pending = _queue.length;
        }

        _scheduleDrain();
    });

    // On load, upload any local media that never reached Drive (created offline
    // or before sign-in). One pass is enough; new saves enqueue themselves via
    // MEDIA_SAVED above.
    EventBus.on(EVENTS.STORAGE_READY, () => {
        setTimeout(() => { uploadLocalOnlyMedia().catch(() => {}); }, 5000);
    });
}

export function getMediaSyncStatus() {
    return { ..._stats, active: _activeUploads, pending: _queue.length };
}

function _scheduleDrain() {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(_drainQueue, DEBOUNCE_MS);
}

async function _drainQueue() {
    _debounceTimer = null;

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

    if (promises.length > 0) {
        await Promise.allSettled(promises);

        EventBus.emit(EVENTS.SYNC_BATCH_COMPLETE, {
            success: _stats.pushed,
            failed: _stats.failed,
            direction: 'push',
        });

        if (_queue.length > 0) _scheduleDrain();
    }
}

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

        // Always upload to this account's own Drive - under the drive.file
        // scope an editor was never granted access to the owner's folder (only
        // to the project_data.json file they picked), so writing there always
        // fails. The file's physical location doesn't matter: once it's made
        // public, project_data.json's drive_id is enough for anyone to render it.
        const fileId = await _pushToOwnProjectFolder(project, relPath);

        if (fileId) {
            if (isShared) await DriveService.makeFilePublic(fileId);
            await _recordDriveId(project, relPath, fileId);
        }

        _stats.pushed++;

    } catch (err) {
        console.error(`[SharedMediaSync] ✗ Failed (attempt ${retries + 1}): ${relPath}`, err.message);

        if (retries < MAX_RETRIES) {
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

async function _pushToOwnProjectFolder(project, relPath) {
    const fileBlob = await StorageAdapter.getFileBlob(relPath);
    if (!fileBlob) throw new Error(`Local file not found: ${relPath}`);

    const rootFolderId = await DriveService.findOrCreateRootFolder();

    const parts = relPath.split('/');
    const filename = parts.pop();

    if (!filename) throw new Error(`Invalid relPath: ${relPath}`);

    let parentId = rootFolderId;
    if (parts.length > 0) {
        parentId = await DriveService.ensureDrivePath(parts, rootFolderId);
    }

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

function _assignDriveId(project, relPath, fileId) {
    let changed = false;
    for (const spot of (project.spots || [])) {
        const imgPaths = spot.images && spot.images.length > 0
            ? spot.images
            : (spot.image_local_filename ? [spot.image_local_filename] : []);
        const imgIdx = imgPaths.indexOf(relPath);
        if (imgIdx >= 0) {
            if (!spot.image_drive_ids) spot.image_drive_ids = [];
            while (spot.image_drive_ids.length < imgPaths.length) spot.image_drive_ids.push(null);
            if (spot.image_drive_ids[imgIdx] !== fileId) {
                spot.image_drive_ids[imgIdx] = fileId;
                if (imgIdx === 0) spot.image_drive_id = fileId;
                touch(spot);
                changed = true;
            }
        }
        if (spot.audio_local_filename === relPath && spot.audio_drive_id !== fileId) {
            spot.audio_drive_id = fileId; touch(spot); changed = true;
        }
    }
    for (const site of (project.sites || [])) {
        if (site.kml_filename === relPath && site.kml_drive_id !== fileId) {
            site.kml_drive_id = fileId; touch(site); changed = true;
        }
    }
    for (const route of (project.routes || [])) {
        for (const a of (route.annotations || [])) {
            if (a.image_local_filename === relPath && a.image_drive_id !== fileId) {
                a.image_drive_id = fileId; touch(a); touch(route); changed = true;
            }
            if (a.audio_local_filename === relPath && a.audio_drive_id !== fileId) {
                a.audio_drive_id = fileId; touch(a); touch(route); changed = true;
            }
        }
    }
    for (const job of (project.jobs || [])) {
        if (job.job_file === relPath && job.job_file_drive_id !== fileId) {
            job.job_file_drive_id = fileId; touch(job); changed = true;
        }
        for (const rf of (job.result_files || [])) {
            if (rf.rel_path === relPath && rf.drive_id !== fileId) {
                rf.drive_id = fileId; touch(job); changed = true;
            }
        }
    }
    return changed;
}

async function _recordDriveId(project, relPath, fileId) {
    // Re-resolve the live project by id: a flush/rehydrate may have rebuilt the
    // object graph while the upload was in flight, orphaning `project`. Writing
    // the id to a stale copy would be silently dropped by the next save.
    const live = MasterData.getLocalState().projects.find(p => p.id === project.id) || project;
    if (_assignDriveId(live, relPath, fileId)) {
        await MasterData.saveMasterData();
        EventBus.emit(EVENTS.DATA_UPDATED);
        _scheduleWriteThrough(live.id);
    }
}

const _writeThroughTimers = new Map();
const WRITE_THROUGH_DEBOUNCE_MS = 1500;

// project_data.json is the shared source of truth collaborators read, so push
// the freshly-recorded drive_id there instead of waiting for the debounced
// master flush - otherwise a collaborator can pull a copy that is missing the
// id and has no way to recover it (they can't enumerate the owner's folder).
// Debounced per project so a bulk catch-up coalesces into a single push.
function _scheduleWriteThrough(projectId) {
    const prev = _writeThroughTimers.get(projectId);
    if (prev) clearTimeout(prev);
    _writeThroughTimers.set(projectId, setTimeout(async () => {
        _writeThroughTimers.delete(projectId);
        try {
            const state = MasterData.getLocalState();
            const project = state.projects.find(p => p.id === projectId);
            if (!project) return;
            if (project.shared?.isImported && project.shared?.permission === 'writer') {
                const { pushToSharedProject } = await import('./SharingService.js');
                await pushToSharedProject(project.id);
            } else if (project.sharing?.isShared) {
                const { pushProjectDataToDrive } = await import('../data/Repository.js');
                await pushProjectDataToDrive(project);
            }
        } catch (e) {
            console.warn('[SharedMediaSync] project_data.json write-through failed:', e.message);
        }
    }, WRITE_THROUGH_DEBOUNCE_MS));
}

// Synchronously push every locally-referenced file that has no drive_id yet.
// Called before a pull replaces local state, so the pull can never orphan the
// only copy of a file.
export async function uploadLocalOnlyMedia() {
    if (!getAccessToken()) return 0;

    const state = MasterData.getLocalState();
    let uploaded = 0;

    for (const project of (state.projects || [])) {
        const isImportedEditor = project.shared?.isImported && project.shared?.permission === 'writer';
        if (project.shared?.isImported && !isImportedEditor) continue;

        for (const ref of enumerateFileRefs(project)) {
            // Already on Drive (this account's or the owner's) - trust the id
            // and never re-upload. Re-uploading owner-hosted media that the
            // editor merely downloaded would fork the reference to a duplicate
            // in the editor's own Drive and churn project_data.json.
            if (ref.driveId) continue;
            let exists = false;
            try { exists = await StorageAdapter.checkFileExists(ref.relPath); } catch { }
            if (!exists) continue;

            try {
                const fileId = await _pushToOwnProjectFolder(project, ref.relPath);
                if (fileId) {
                    if (isImportedEditor || project.sharing?.isShared) {
                        await DriveService.makeFilePublic(fileId);
                    }
                    await _recordDriveId(project, ref.relPath, fileId);
                    uploaded++;
                }
            } catch (e) {
                console.warn(`[SharedMediaSync] pre-pull upload failed "${ref.relPath}":`, e.message);
            }
        }
    }
    return uploaded;
}

