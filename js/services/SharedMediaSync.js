import EventBus, { EVENTS } from '../core/EventBus.js';
import * as DriveService from './DriveService.js';
import * as MasterData from '../data/MasterData.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import { getProjectFolderName } from '../data/projectUtils.js';
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

    EventBus.on(EVENTS.STORAGE_READY, () => {
        setTimeout(() => _catchUpUnsyncedMedia(), 5000);
    });

    let _catchUpDone = false;
    EventBus.on(EVENTS.DATA_UPDATED, () => {
        if (_catchUpDone || !getAccessToken()) return;
        _catchUpDone = true;
        setTimeout(() => _catchUpUnsyncedMedia(), 2000);
    });

}

async function _catchUpUnsyncedMedia() {
    if (!getAccessToken()) return;

    const state = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === state.currentProjectId);
    if (!project) return;

    if (project.shared?.isImported) return;

    const mediaPaths = [];
    for (const spot of (project.spots || [])) {
        const imgPaths = spot.images && spot.images.length > 0
            ? spot.images
            : (spot.image_local_filename ? [spot.image_local_filename] : []);
        for (const p of imgPaths) mediaPaths.push(p);
        if (spot.audio_local_filename) mediaPaths.push(spot.audio_local_filename);
    }
    for (const site of (project.sites || [])) {
        if (site.kml_filename) mediaPaths.push(site.kml_filename);
    }

    if (mediaPaths.length === 0) return;

    let driveFiles;
    try {
        driveFiles = await DriveService.listAllDriveFiles();
    } catch { return; }

    const drivePaths = new Set(
        driveFiles.map(f => f.appProperties?.relativePath).filter(Boolean)
    );

    let queued = 0;
    for (const relPath of mediaPaths) {
        if (drivePaths.has(relPath)) continue;

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
        _scheduleDrain();
    }
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

        let fileId = null;
        if (isImportedEditor) {
            fileId = await _pushToSharedFolder(project, relPath);
        } else {
            fileId = await _pushToOwnProjectFolder(project, relPath);
        }

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

async function _pushToSharedFolder(project, relPath) {
    const { sourceFolderId, ownerFolderName } = project.shared;
    if (!sourceFolderId) throw new Error('No sourceFolderId on imported project');

    const fileBlob = await StorageAdapter.getFileBlob(relPath);
    if (!fileBlob) throw new Error(`Local file not found: ${relPath}`);

    const localFolder = getProjectFolderName(project);
    const ownerFolder = ownerFolderName || localFolder;

    let targetPath = relPath;
    if (relPath.startsWith(localFolder + '/')) {
        targetPath = ownerFolder + relPath.substring(localFolder.length);
    }

    const parts = targetPath.split('/');
    parts.shift();
    const filename = parts.pop();

    if (!filename) throw new Error(`Invalid relPath after split: ${relPath}`);

    let parentId = sourceFolderId;
    if (parts.length > 0) {
        parentId = await DriveService.ensureDrivePath(parts, sourceFolderId);
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
        targetPath
    );
    return created.id;
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

async function _recordDriveId(project, relPath, fileId) {
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
    if (changed) {
        await MasterData.saveMasterData();
        EventBus.emit(EVENTS.DATA_UPDATED);
    }
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
            if (ref.driveId) continue;
            let exists = false;
            try { exists = await StorageAdapter.checkFileExists(ref.relPath); } catch { }
            if (!exists) continue;

            try {
                const fileId = isImportedEditor
                    ? await _pushToSharedFolder(project, ref.relPath)
                    : await _pushToOwnProjectFolder(project, ref.relPath);
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
