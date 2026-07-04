import EventBus, { EVENTS } from '../core/EventBus.js';
import * as DriveService from './DriveService.js';
import { getLocalState, replaceState, generateDataSignature } from '../data/MasterData.js';
import { getAccessToken } from './AuthService.js';
import { mergeMasterData } from '../data/mergeUtils.js';

let remoteMasterCache = null;

// modifiedTime of the Drive master as of our last successful pull/push/check.
// pushMasterToDrive refuses to overwrite a remote that moved past this.
let _knownRemoteMasterTime = null;

export function getKnownRemoteMasterTime() {
    return _knownRemoteMasterTime;
}

export function setKnownRemoteMasterTime(t) {
    _knownRemoteMasterTime = t || null;
}

// Called by the guarded Drive push when it detects the remote master moved:
// fetch the remote content and open the normal conflict flow.
export async function raiseRemoteConflict(driveFile) {
    const remoteData = JSON.parse(await DriveService.readDriveTextFile(driveFile.id));
    remoteMasterCache = { data: remoteData, fileId: driveFile.id, modifiedTime: driveFile.modifiedTime };

    EventBus.emit(EVENTS.MASTER_SYNC_CONFLICT, {
        localCount:  _countSpots(getLocalState()),
        remoteCount: _countSpots(remoteData),
    });
}

function _countSpots(data) {
    if (data?.projects) {
        return data.projects.reduce(
            (n, p) => n + (p.spots?.filter(s => !s.deleted).length ?? 0), 0);
    }
    return data?.spots?.length ?? 0;
}

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

export async function checkForRemoteUpdates(interactive = false) {
    if (!getAccessToken()) return;

    try {
        const rootFolderId = await DriveService.findOrCreateRootFolder();
        const driveFile    = await DriveService.findFileByName('master_data.json', rootFolderId);

        if (!driveFile) {
            if (interactive) {
                EventBus.emit(EVENTS.TOAST_SHOW, {
                    message: 'No master file on Drive - uploading local copy...',
                    type: 'info',
                });
                const localState = getLocalState();
                const cleanState = {
                    ...localState,
                    projects: (localState.projects || []).filter(p => !p.shared?.isImported),
                };
                const blob = new Blob([JSON.stringify(cleanState, null, 2)], { type: 'application/json' });
                await DriveService.upsertFile('master_data.json', rootFolderId, blob, 'application/json', 'master_data.json');
                const fresh = await DriveService.findFileByName('master_data.json', rootFolderId);
                if (fresh?.modifiedTime) setKnownRemoteMasterTime(fresh.modifiedTime);
                EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Master data uploaded to Drive.', type: 'success' });
            }
            return;
        }

        // On the poll path, an unchanged remote needs no download and no dialog.
        if (!interactive &&
            _knownRemoteMasterTime &&
            driveFile.modifiedTime === _knownRemoteMasterTime) {
            return;
        }

        const remoteData = JSON.parse(await DriveService.readDriveTextFile(driveFile.id));
        const localData  = getLocalState();

        const localForCompare = {
            ...localData,
            projects: (localData.projects || []).filter(p => !p.shared?.isImported),
        };

        if (generateDataSignature(localForCompare) === generateDataSignature(remoteData)) {
            setKnownRemoteMasterTime(driveFile.modifiedTime);
            if (interactive) {
                EventBus.emit(EVENTS.TOAST_SHOW, { message: 'You are up to date.', type: 'success' });
            }
            return;
        }

        remoteMasterCache = { data: remoteData, fileId: driveFile.id, modifiedTime: driveFile.modifiedTime };

        EventBus.emit(EVENTS.MASTER_SYNC_CONFLICT, {
            localCount:  _countSpots(localData),
            remoteCount: _countSpots(remoteData),
        });
    } catch (err) {
        console.error('[SyncService] checkForRemoteUpdates error:', err);
        if (interactive) {
            EventBus.emit(EVENTS.TOAST_SHOW, { message: `Sync check failed: ${err.message}`, type: 'error' });
        }
    }
}

// Before a pull/merge replaces local state, upload any media that only exists
// on this device - a pull that drops the referencing item followed by GC would
// otherwise destroy the only copy.
async function _uploadLocalOnlyMediaSafe() {
    try {
        const { uploadLocalOnlyMedia } = await import('./SharedMediaSync.js');
        await uploadLocalOnlyMedia();
    } catch (e) {
        console.warn('[SyncService] pre-pull media upload failed:', e.message);
    }
}

async function _reconcileActiveProjectMedia() {
    try {
        const { reconcileProjectFiles } = await import('./ProjectFilesSync.js');
        const { getActiveProject } = await import('../data/MasterData.js');
        const active = getActiveProject();
        if (active) await reconcileProjectFiles(active);
    } catch (e) {
        console.warn('[SyncService] media reconcile failed:', e.message);
    }
}

export async function resolveMasterConflict(action) {
    if (!remoteMasterCache) return;
    const { data: remoteData, fileId, modifiedTime } = remoteMasterCache;

    try {
        if (action === 'pull') {
            await _uploadLocalOnlyMediaSafe();
            await replaceState(_normaliseToProjectSchema(remoteData));
            setKnownRemoteMasterTime(modifiedTime);
            EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Pulled from Drive successfully.', type: 'success' });
        } else if (action === 'push') {
            const blob = new Blob([JSON.stringify(getLocalState(), null, 2)], { type: 'application/json' });
            await DriveService.updateDriveFile(fileId, blob);
            await _refreshKnownRemoteTime();
            EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Pushed to Drive successfully.', type: 'success' });
        } else if (action === 'merge') {
            await _uploadLocalOnlyMediaSafe();
            const merged = mergeDatasets(getLocalState(), remoteData);
            await replaceState(merged);
            const blob = new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json' });
            await DriveService.updateDriveFile(fileId, blob);
            await _refreshKnownRemoteTime();
            EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Merged local and Drive data.', type: 'success' });
        }

        if (action === 'pull' || action === 'merge') {
            await _reconcileActiveProjectMedia();
        }

        remoteMasterCache = null;

        // Deliberately no GC here: right after a destructive replaceState is
        // exactly when unreferenced-but-irreplaceable files exist. GC stays a
        // user-triggered action from the sync panel.

        EventBus.emit(EVENTS.DATA_UPDATED);
        EventBus.emit(EVENTS.PROJECT_CHANGED);
    } catch (err) {
        console.error('[SyncService] resolveMasterConflict error:', err);
        EventBus.emit(EVENTS.TOAST_SHOW, { message: `Resolution failed: ${err.message}`, type: 'error' });
    }
}

async function _refreshKnownRemoteTime() {
    try {
        const rootFolderId = await DriveService.findOrCreateRootFolder();
        const fresh = await DriveService.findFileByName('master_data.json', rootFolderId);
        if (fresh?.modifiedTime) setKnownRemoteMasterTime(fresh.modifiedTime);
    } catch { }
}

export function getConflictSnapshot() {
    return {
        local:  getLocalState(),
        remote: remoteMasterCache?.data || null,
        fileId: remoteMasterCache?.fileId || null,
    };
}

export async function applyResolvedConflict(resolvedState) {
    const fileId = remoteMasterCache?.fileId || null;

    await _uploadLocalOnlyMediaSafe();
    await replaceState(resolvedState);

    if (fileId && getAccessToken()) {
        const driveState = {
            ...resolvedState,
            projects: (resolvedState.projects || []).filter(p => !p.shared?.isImported),
        };
        const blob = new Blob([JSON.stringify(driveState, null, 2)], { type: 'application/json' });
        try {
            await DriveService.updateDriveFile(fileId, blob);
            await _refreshKnownRemoteTime();
        } catch (err) {
            console.error('[SyncService] applyResolvedConflict: Drive write failed:', err);
            EventBus.emit(EVENTS.TOAST_SHOW, {
                message: `Saved locally, but Drive update failed: ${err.message}`,
                type: 'error',
            });
        }
    }

    await _reconcileActiveProjectMedia();

    remoteMasterCache = null;

    EventBus.emit(EVENTS.DATA_UPDATED);
    EventBus.emit(EVENTS.PROJECT_CHANGED);
    EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Local and Drive are now in sync.', type: 'success' });
}

export function mergeDatasets(local, remote) {
    return mergeMasterData(
        _normaliseToProjectSchema(local),
        _normaliseToProjectSchema(remote)
    );
}
