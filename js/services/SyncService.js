import EventBus, { EVENTS } from '../core/EventBus.js';
import * as DriveService from './DriveService.js';
import { getLocalState, replaceState, generateDataSignature } from '../data/MasterData.js';
import { getAccessToken } from './AuthService.js';
import { mergeMasterData } from '../data/mergeUtils.js';

// modifiedTime of the Drive master as of our last successful pull/push/check.
// pushMasterToDrive folds the remote in when it moved past this.
let _knownRemoteMasterTime = null;

export function getKnownRemoteMasterTime() {
    return _knownRemoteMasterTime;
}

export function setKnownRemoteMasterTime(t) {
    _knownRemoteMasterTime = t || null;
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

// Called by the guarded Drive push when the remote master moved since we last
// saw it: union-merge the remote into local so the subsequent write can never
// clobber another device's changes. No user-facing conflict prompt.
export async function foldRemoteMasterIntoLocal(driveFile) {
    EventBus.emit(EVENTS.SYNC_PROGRESS, { detail: 'Merging remote changes…' });
    const remoteData = JSON.parse(await DriveService.readDriveTextFile(driveFile.id));
    const merged = mergeDatasets(getLocalState(), remoteData);
    await replaceState(merged);
}

export async function checkForRemoteUpdates(interactive = false) {
    if (!getAccessToken()) return;

    try {
        const rootFolderId = await DriveService.findOrCreateRootFolder();
        const driveFile    = await DriveService.findFileByName('master_data.json', rootFolderId);

        if (!driveFile) {
            if (interactive) {
                EventBus.emit(EVENTS.SYNC_PROGRESS, { detail: 'Uploading local copy…' });
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

        // On the poll path, an unchanged remote needs no download.
        if (!interactive &&
            _knownRemoteMasterTime &&
            driveFile.modifiedTime === _knownRemoteMasterTime) {
            return;
        }

        EventBus.emit(EVENTS.SYNC_PROGRESS, { detail: 'Downloading from Drive…' });
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

        // Divergence: union-merge remote into local and write the result back,
        // automatically. Both sides survive (mergeById keeps all items and
        // tombstones); there is no conflict list to resolve by hand.
        EventBus.emit(EVENTS.SYNC_PROGRESS, { detail: 'Merging remote changes…' });
        await _uploadLocalOnlyMediaSafe();
        const merged = mergeDatasets(localData, remoteData);
        await replaceState(merged);

        EventBus.emit(EVENTS.SYNC_PROGRESS, { detail: 'Uploading merged data…' });
        const driveState = {
            ...merged,
            projects: (merged.projects || []).filter(p => !p.shared?.isImported),
        };
        const blob = new Blob([JSON.stringify(driveState, null, 2)], { type: 'application/json' });
        await DriveService.updateDriveFile(driveFile.id, blob);
        await _refreshKnownRemoteTime();
        await _reconcileActiveProjectMedia();

        EventBus.emit(EVENTS.DATA_UPDATED);
        EventBus.emit(EVENTS.PROJECT_CHANGED);
        if (interactive) {
            EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Synced with Drive.', type: 'success' });
        }
    } catch (err) {
        console.error('[SyncService] checkForRemoteUpdates error:', err);
        if (interactive) {
            EventBus.emit(EVENTS.TOAST_SHOW, { message: `Sync check failed: ${err.message}`, type: 'error' });
        }
    }
}

// Before a merge replaces local state, upload any media that only exists on
// this device - a merge that drops the referencing item followed by GC would
// otherwise destroy the only copy.
async function _uploadLocalOnlyMediaSafe() {
    try {
        const { uploadLocalOnlyMedia } = await import('./SharedMediaSync.js');
        await uploadLocalOnlyMedia();
    } catch (e) {
        console.warn('[SyncService] pre-merge media upload failed:', e.message);
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

async function _refreshKnownRemoteTime() {
    try {
        const rootFolderId = await DriveService.findOrCreateRootFolder();
        const fresh = await DriveService.findFileByName('master_data.json', rootFolderId);
        if (fresh?.modifiedTime) setKnownRemoteMasterTime(fresh.modifiedTime);
    } catch { }
}

export function mergeDatasets(local, remote) {
    return mergeMasterData(
        _normaliseToProjectSchema(local),
        _normaliseToProjectSchema(remote)
    );
}
