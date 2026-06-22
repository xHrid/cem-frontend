import * as StorageAdapter from './StorageAdapter.js';

let masterData = {
    currentProjectId : null,
    projects         : [],
    metadata         : { created_at: new Date().toISOString() }
};

let remoteMasterCache = null;

export async function ensureMasterJson() {
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

export async function saveMasterData() {
    await StorageAdapter.saveMasterData(masterData);
}

export function generateDataSignature(data) {
    if (!data || !data.projects) return 'empty';

    return data.projects
        .map(p => {
            const spots  = (p.spots          || []).map(s => `${s.spotId}_${s.timestamp}_${s.updated_at || ''}`).sort().join(',');
            const sites  = (p.sites          || []).map(s => `${s.id}_${s.timestamp}_${s.updated_at || ''}`).sort().join(',');
            const routes = (p.routes         || []).map(r => `${r.id}_${r.timestamp}_${r.updated_at || ''}`).sort().join(',');
            const files  = (p.external_files || []).map(f => `${f.id}_${f.timestamp}_${f.updated_at || ''}`).sort().join(',');
            const jobs   = (p.jobs           || []).map(j => `${j.job_id}_${j.status || ''}`).sort().join(',');

            return `Project:${p.id}_${p.name}|Spots:${spots}|Sites:${sites}|Routes:${routes}|Jobs:${jobs}|Files:${files}`;
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

export function getSpots() {
    return getActiveProject()?.spots || [];
}

export function getRoutes() {
    return getActiveProject()?.routes || [];
}

export function getSites() {
    return getActiveProject()?.sites || [];
}

export function getExternalFiles() {
    return getActiveProject()?.external_files || [];
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
