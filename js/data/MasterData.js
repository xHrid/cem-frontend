import * as StorageAdapter from './StorageAdapter.js';
import { mergeMasterData, isDeleted } from './mergeUtils.js';

let masterData = {
    currentProjectId : null,
    projects         : [],
    metadata         : { created_at: new Date().toISOString() }
};

let remoteMasterCache = null;

export async function ensureMasterJson() {
    // getMasterData throws on unreadable/corrupt content (it only returns null
    // when the file is genuinely absent), so a read failure propagates to the
    // caller instead of being papered over with a fresh empty master.
    const data = await StorageAdapter.getMasterData();

    if (data && !data.projects) {
        const defaultId      = crypto.randomUUID();
        const defaultProject = {
            id             : defaultId,
            name           : 'Default Project',
            spots          : data.spots          || [],
            routes         : data.routes         || [],
            sites          : data.sites          || [],
            external_files : data.external_files || [],
            created_at     : data.metadata?.created_at || new Date().toISOString()
        };

        masterData = {
            currentProjectId : defaultId,
            projects         : [defaultProject],
            metadata         : { ...data.metadata, schema_version: 2 }
        };

        await saveMasterData();

    } else if (data) {
        masterData = data;

        if (!masterData.projects.find(p => p.id === masterData.currentProjectId)) {
            masterData.currentProjectId = masterData.projects[0]?.id || null;
        }

    } else {
        const defaultId = crypto.randomUUID();
        masterData = {
            currentProjectId : defaultId,
            projects         : [{
                id             : defaultId,
                name           : 'Untitled Project',
                spots          : [],
                routes         : [],
                sites          : [],
                external_files : [],
                created_at     : new Date().toISOString()
            }],
            metadata : { created_at: new Date().toISOString(), schema_version: 2 }
        };

        await saveMasterData();
    }
}

// Single-flight write queue: at most one write in flight, at most one queued.
// Every write serializes the state at write time, so N mutations coalesce into
// the in-flight write plus one trailing write of the latest state.
let _inflightSave = null;
let _queuedSave   = null;

export function saveMasterData() {
    if (_queuedSave) return _queuedSave;
    if (_inflightSave) {
        _queuedSave = _inflightSave
            .catch(() => {})
            .then(() => {
                _queuedSave = null;
                return _runSave();
            });
        return _queuedSave;
    }
    return _runSave();
}

function _runSave() {
    _inflightSave = StorageAdapter.saveMasterData(masterData)
        .finally(() => { _inflightSave = null; });
    return _inflightSave;
}

export function generateDataSignature(data) {
    if (!data || !data.projects) return 'empty';

    const sig = it => `${it.rev || 0}_${it.timestamp || ''}_${it.updated_at || ''}${it.deleted ? '_D' : ''}`;

    return data.projects
        .map(p => {
            const spots  = (p.spots          || []).map(s => `${s.spotId}_${sig(s)}`).sort().join(',');
            const sites  = (p.sites          || []).map(s => `${s.id}_${sig(s)}`).sort().join(',');
            const routes = (p.routes         || []).map(r => `${r.id}_${sig(r)}`).sort().join(',');
            const files  = (p.external_files || []).map(f => `${f.id}_${sig(f)}`).sort().join(',');
            const jobs   = (p.jobs           || []).map(j => `${j.job_id}_${j.status || ''}_${sig(j)}`).sort().join(',');

            return `Project:${p.id}_${p.name}_${p.rev || 0}|Spots:${spots}|Sites:${sites}|Routes:${routes}|Jobs:${jobs}|Files:${files}`;
        })
        .sort()
        .join('||');
}

export function getLocalState() {
    return masterData;
}

export function getMasterData() {
    return masterData;
}

export async function replaceState(newData) {
    masterData = newData;
    await saveMasterData();
}

// Fold the persisted state (possibly written by another tab) into memory.
// Never writes; the caller decides whether a save/push follows.
export async function rehydrate() {
    let disk = null;
    try {
        disk = await StorageAdapter.getMasterData();
    } catch (e) {
        console.warn('[MasterData] rehydrate skipped, master unreadable:', e.message);
        return false;
    }
    if (!disk?.projects) return false;

    const before = generateDataSignature(masterData);
    masterData = mergeMasterData(masterData, disk);
    if (!masterData.projects.find(p => p.id === masterData.currentProjectId)) {
        masterData.currentProjectId = masterData.projects[0]?.id || null;
    }
    return generateDataSignature(masterData) !== before;
}

export function getActiveProject() {
    if (!masterData.projects || masterData.projects.length === 0) return null;

    return (
        masterData.projects.find(p => p.id === masterData.currentProjectId) ||
        masterData.projects[0]
    );
}

export function getActiveProjectId() {
    return masterData.currentProjectId;
}

export function setCurrentProjectId(id) {
    masterData.currentProjectId = id;
}

const _live = arr => (arr || []).filter(it => !isDeleted(it));

export function getSpots() {
    return _live(getActiveProject()?.spots);
}

export function getRoutes() {
    return _live(getActiveProject()?.routes);
}

export function getSites() {
    return _live(getActiveProject()?.sites);
}

export function getExternalFiles() {
    return _live(getActiveProject()?.external_files);
}

export function getRemoteMasterCache() {
    return remoteMasterCache;
}

export function setRemoteMasterCache(cache) {
    remoteMasterCache = cache;
}

export function clearRemoteMasterCache() {
    remoteMasterCache = null;
}
