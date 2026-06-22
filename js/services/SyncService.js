import EventBus, { EVENTS } from '../core/EventBus.js';
import * as DriveService from './DriveService.js';
import { getLocalState, replaceState, generateDataSignature } from '../data/MasterData.js';
import { getAccessToken } from './AuthService.js';
import { mergeById } from '../data/mergeUtils.js';

let remoteMasterCache = null;

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
                    message: 'No master file on Drive — uploading local copy...',
                    type: 'info',
                });
                const localState = getLocalState();
                const cleanState = {
                    ...localState,
                    projects: (localState.projects || []).filter(p => !p.shared?.isImported),
                };
                const blob = new Blob([JSON.stringify(cleanState, null, 2)], { type: 'application/json' });
                await DriveService.upsertFile('master_data.json', rootFolderId, blob, 'application/json', 'master_data.json');
                EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Master data uploaded to Drive.', type: 'success' });
            }
            return;
        }

        const remoteData = JSON.parse(await DriveService.readDriveTextFile(driveFile.id));
        const localData  = getLocalState();

        const localForCompare = {
            ...localData,
            projects: (localData.projects || []).filter(p => !p.shared?.isImported),
        };

        if (generateDataSignature(localForCompare) === generateDataSignature(remoteData)) {
            if (interactive) {
                EventBus.emit(EVENTS.TOAST_SHOW, { message: 'You are up to date.', type: 'success' });
            }
            return;
        }

        remoteMasterCache = { data: remoteData, fileId: driveFile.id };

        const localCount  = localData.projects?.reduce((n, p) => n + (p.spots?.length ?? 0), 0) ?? 0;
        const remoteCount = remoteData.projects
            ? remoteData.projects.reduce((n, p) => n + (p.spots?.length ?? 0), 0)
            : (remoteData.spots?.length ?? 0);

        EventBus.emit(EVENTS.MASTER_SYNC_CONFLICT, { localCount, remoteCount });
    } catch (err) {
        console.error('[SyncService] checkForRemoteUpdates error:', err);
        if (interactive) {
            EventBus.emit(EVENTS.TOAST_SHOW, { message: `Sync check failed: ${err.message}`, type: 'error' });
        }
    }
}

export async function resolveMasterConflict(action) {
    if (!remoteMasterCache) return;
    const { data: remoteData, fileId } = remoteMasterCache;

    try {
        if (action === 'pull') {
            await replaceState(_normaliseToProjectSchema(remoteData));
            EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Pulled from Drive successfully.', type: 'success' });
        } else if (action === 'push') {
            const blob = new Blob([JSON.stringify(getLocalState(), null, 2)], { type: 'application/json' });
            await DriveService.updateDriveFile(fileId, blob);
            EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Pushed to Drive successfully.', type: 'success' });
        } else if (action === 'merge') {
            const merged = mergeDatasets(getLocalState(), remoteData);
            await replaceState(merged);
            const blob = new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json' });
            await DriveService.updateDriveFile(fileId, blob);
            EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Merged local and Drive data.', type: 'success' });
        }

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

        if (action === 'pull' || action === 'merge') {
            try {
                const { gcAndRefresh } = await import('./StorageGC.js');
                await gcAndRefresh();
            } catch (e) { console.warn('[SyncService] post-resolution GC failed:', e.message); }
        }

        EventBus.emit(EVENTS.DATA_UPDATED);
        EventBus.emit(EVENTS.PROJECT_CHANGED);
    } catch (err) {
        console.error('[SyncService] resolveMasterConflict error:', err);
        EventBus.emit(EVENTS.TOAST_SHOW, { message: `Resolution failed: ${err.message}`, type: 'error' });
    }
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

    await replaceState(resolvedState);

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

    try {
        const { reconcileProjectFiles } = await import('./ProjectFilesSync.js');
        const { getActiveProject } = await import('../data/MasterData.js');
        const active = getActiveProject();
        if (active) await reconcileProjectFiles(active);
    } catch (e) {
        console.warn('[SyncService] media reconcile after resolution failed:', e.message);
    }

    remoteMasterCache = null;

    try {
        const { gcAndRefresh } = await import('./StorageGC.js');
        await gcAndRefresh();
    } catch (e) { console.warn('[SyncService] post-resolution GC failed:', e.message); }

    EventBus.emit(EVENTS.DATA_UPDATED);
    EventBus.emit(EVENTS.PROJECT_CHANGED);
    EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Local and Drive are now in sync.', type: 'success' });
}

export function mergeDatasets(local, remote) {
    const l = _normaliseToProjectSchema(local);
    const r = _normaliseToProjectSchema(remote);

    const projectMap = new Map();
    l.projects.forEach(p => projectMap.set(p.id, { ...p }));

    r.projects.forEach(rp => {
        if (projectMap.has(rp.id)) {
            const lp = projectMap.get(rp.id);
            projectMap.set(rp.id, {
                ...lp,
                spots:          mergeById(lp.spots,          rp.spots),
                routes:         mergeById(lp.routes,         rp.routes),
                sites:          mergeById(lp.sites,          rp.sites),
                jobs:           mergeById(lp.jobs,           rp.jobs),
                external_files: mergeById(lp.external_files, rp.external_files),
            });
        } else {
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
