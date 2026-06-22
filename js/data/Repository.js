import EventBus, { EVENTS }       from '../core/EventBus.js';
import * as StorageAdapter         from './StorageAdapter.js';
import * as MasterData             from './MasterData.js';
import { getProjectFolderName }    from './projectUtils.js';
import { getAccessToken, getUserEmail } from '../services/AuthService.js';
import {
    findOrCreateRootFolder,
    findFileByName,
    readDriveTextFile,
    updateDriveFile,
    uploadFile,
    upsertFile,
    ensureDrivePath
} from '../services/DriveService.js';
import { mergeById } from './mergeUtils.js';

function _requireActiveProject() {
    const project = MasterData.getActiveProject();
    if (!project) {
        throw new Error(
            'Repository: no active project. Call StorageAdapter.initStorage() ' +
            'and MasterData.ensureMasterJson() first.'
        );
    }
    return project;
}

function _safeName(name, fallback = 'Unknown') {
    const clean = (name || '')
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_{2,}/g,      '_')
        .replace(/^_|_$/g,      '');
    return clean || fallback;
}

export async function saveSpot(spotData, imageBlobs, audioBlob, recordDate) {
    const project       = _requireActiveProject();
    const projectFolder = getProjectFolderName(project);
    const spotId        = spotData.spotId || crypto.randomUUID();

    const safeSpot    = _safeName(spotData.name, `Spot_${spotId.substring(0, 8)}`);
    const spotPath    = [projectFolder, 'spots', safeSpot];
    const shortId     = spotId.substring(0, 8);

    const blobs = imageBlobs
        ? (Array.isArray(imageBlobs) ? imageBlobs : [imageBlobs])
        : [];

    const imagePaths = [];
    for (let i = 0; i < blobs.length; i++) {
        const suffix = i === 0 ? 'cover' : `img${i + 1}`;
        const path = await StorageAdapter.saveFile(
            blobs[i],
            `${safeSpot}_${shortId}_${suffix}.jpg`,
            [...spotPath, 'images']
        );
        imagePaths.push(path);
    }

    let audioPath = null;
    if (audioBlob) {
        audioPath = await StorageAdapter.saveFile(
            audioBlob,
            `${safeSpot}_${shortId}_note.webm`,
            [...spotPath, 'audio']
        );
    }

    const timestamp = (recordDate instanceof Date)
        ? recordDate.toISOString()
        : new Date().toISOString();

    const newSpot = {
        ...spotData,
        spotId,
        projectId              : project.id,
        created_by             : spotData.created_by || getUserEmail() || null,
        timestamp,
        image_local_filename   : imagePaths[0] || null,
        images                 : imagePaths.length > 0 ? imagePaths : null,
        audio_local_filename   : audioPath
    };

    if (!project.spots) project.spots = [];
    project.spots.push(newSpot);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);

    for (const p of imagePaths) {
        EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: p, isExternal: false });
    }
    if (audioPath) {
        EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: audioPath, isExternal: false });
    }

    return newSpot;
}

export async function updateSpot(spotId, fields, addBlobs = [], removePaths = [], clearDriveImg = false) {
    const project = _requireActiveProject();
    const spot    = (project.spots || []).find(s => s.spotId === spotId);
    if (!spot) throw new Error(`Spot "${spotId}" not found.`);

    if (fields && typeof fields.description === 'string') {
        spot.description = fields.description;
    }

    const blobs = addBlobs instanceof Blob ? [addBlobs] : (Array.isArray(addBlobs) ? addBlobs : []);

    let images = spot.images && spot.images.length > 0
        ? [...spot.images]
        : (spot.image_local_filename ? [spot.image_local_filename] : []);

    if (removePaths.length > 0) {
        const removeSet = new Set(removePaths);
        images = images.filter(p => !removeSet.has(p));
    }

    if (clearDriveImg) {
        spot.image_drive_id = null;
    }

    const projectFolder = getProjectFolderName(project);
    const safeSpot      = _safeName(spot.name, `Spot_${spotId.substring(0, 8)}`);
    const shortId       = spotId.substring(0, 8);
    const newPaths      = [];

    for (let i = 0; i < blobs.length; i++) {
        const suffix = `add_${Date.now()}_${i}`;
        const path = await StorageAdapter.saveFile(
            blobs[i],
            `${safeSpot}_${shortId}_${suffix}.jpg`,
            [projectFolder, 'spots', safeSpot, 'images']
        );
        images.push(path);
        newPaths.push(path);
    }

    spot.images = images.length > 0 ? images : null;
    spot.image_local_filename = images[0] || null;

    if (!spot.image_local_filename && !clearDriveImg) {
    }

    spot.updated_at = new Date().toISOString();

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);

    for (const p of newPaths) {
        EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: p, isExternal: false });
    }

    return spot;
}

export async function saveSite(siteName, kmlFile, clusters) {
    const project       = _requireActiveProject();
    const projectFolder = getProjectFolderName(project);
    const siteId        = crypto.randomUUID();

    const safeSite = _safeName(siteName, `Site_${siteId.substring(0, 8)}`);
    const shortId  = siteId.substring(0, 8);

    const kmlPath = await StorageAdapter.saveFile(
        kmlFile,
        `${safeSite}_${shortId}.kml`,
        [projectFolder, 'sites']
    );

    const newSite = {
        id             : siteId,
        projectId      : project.id,
        name           : siteName,
        kml_filename   : kmlPath,
        clusters       : clusters || null,
        created_by     : getUserEmail() || null,
        timestamp      : new Date().toISOString()
    };

    if (!project.sites) project.sites = [];
    project.sites.push(newSite);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);

    if (kmlPath) {
        EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: kmlPath, isExternal: false });
    }

    return newSite;
}

export async function saveRoute(routeData) {
    const project = _requireActiveProject();

    const newRoute = {
        ...routeData,
        id        : crypto.randomUUID(),
        projectId : project.id,
        created_by: getUserEmail() || null,
        timestamp : new Date().toISOString()
    };

    if (!project.routes) project.routes = [];
    project.routes.push(newRoute);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);

    return newRoute;
}

export async function saveRouteAnnotation(routeId, data, imageBlob, audioBlob) {
    const project       = _requireActiveProject();
    const projectFolder = getProjectFolderName(project);

    const route = (project.routes || []).find(r => r.id === routeId);
    if (!route) throw new Error(`Route "${routeId}" not found.`);

    const annId    = crypto.randomUUID();
    const safeRoute = _safeName(route.name, `Route_${routeId.substring(0, 8)}`);
    const base      = [projectFolder, 'routes', safeRoute, 'annotations', annId.substring(0, 8)];

    let imgPath = null;
    let audioPath = null;

    if (imageBlob) {
        imgPath = await StorageAdapter.saveFile(imageBlob, `${annId.substring(0, 8)}_photo.jpg`, [...base, 'images']);
    }
    if (audioBlob) {
        audioPath = await StorageAdapter.saveFile(audioBlob, `${annId.substring(0, 8)}_note.webm`, [...base, 'audio']);
    }

    const now = new Date().toISOString();
    const annotation = {
        id                   : annId,
        latitude             : data.latitude  ?? data.lat,
        longitude            : data.longitude ?? data.lng,
        description          : data.description || '',
        created_by           : getUserEmail() || null,
        image_local_filename : imgPath,
        audio_local_filename : audioPath,
        timestamp            : now,
    };

    if (!route.annotations) route.annotations = [];
    route.annotations.push(annotation);
    route.timestamp = now;

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);

    if (imgPath)   EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: imgPath,   isExternal: false });
    if (audioPath) EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: audioPath, isExternal: false });

    return annotation;
}

export async function deleteRouteAnnotation(routeId, annId) {
    const project = _requireActiveProject();
    const route   = (project.routes || []).find(r => r.id === routeId);
    if (!route?.annotations) return;
    route.annotations = route.annotations.filter(a => a.id !== annId);
    route.timestamp = new Date().toISOString();
    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
}

export async function saveExternalFile(fileObj, spotIds, importDate) {
    const project       = _requireActiveProject();
    const projectFolder = getProjectFolderName(project);

    const primarySpotId = spotIds[0];
    const spot          = (project.spots || []).find(s => s.spotId === primarySpotId);

    const safeSpot = _safeName(
        spot?.name,
        `Spot_${(primarySpotId || '').substring(0, 8)}`
    );

    const pathArray = [projectFolder, 'spots', safeSpot, 'external_data'];
    const savedPath = await StorageAdapter.saveFile(fileObj, fileObj.name, pathArray);

    const timestamp = (importDate instanceof Date)
        ? importDate.toISOString()
        : new Date().toISOString();

    const newFileEntry = {
        id           : crypto.randomUUID(),
        name         : fileObj.name,
        type         : fileObj.type,
        linked_spots : spotIds,
        projectId    : project.id,
        timestamp,
        sync_status  : 'pending',
        local_path   : savedPath
    };

    if (!project.external_files) project.external_files = [];
    project.external_files.push(newFileEntry);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);

    if (savedPath) {
        EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: savedPath, isExternal: true });
    }

    return newFileEntry;
}

export async function deleteSpot(spotId) {
    const project = _requireActiveProject();
    if (!project.spots) return;
    project.spots = project.spots.filter(s => s.spotId !== spotId);
    if (project.external_files) {
        project.external_files = project.external_files.filter(f => {
            if (!f.linked_spots) return true;
            f.linked_spots = f.linked_spots.filter(id => id !== spotId);
            return f.linked_spots.length > 0;
        });
    }
    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
}

export async function deleteSite(siteId) {
    const project = _requireActiveProject();
    if (!project.sites) return;
    project.sites = project.sites.filter(s => s.id !== siteId);
    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
}

export async function deleteRoute(routeId) {
    const project = _requireActiveProject();
    if (!project.routes) return;
    project.routes = project.routes.filter(r => r.id !== routeId);
    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
}

export async function deleteExternalFile(fileId) {
    const project = _requireActiveProject();
    if (!project.external_files) return;
    project.external_files = project.external_files.filter(f => f.id !== fileId);
    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
}

export async function deleteJob(jobId, currentStatus) {
    const project = MasterData.getActiveProject();
    if (!project) return false;
    const projectFolder = getProjectFolderName(project);

    // currentStatus was captured when the dashboard loaded; the watcher may have
    // moved the job since (e.g. queue→processing), so deleting only that path can
    // silently miss. Try every status folder by job_id and report whether the
    // descriptor was actually removed.
    const statuses = ['queue', 'processing', 'completed', 'failed'];
    const ordered  = [currentStatus, ...statuses.filter(s => s !== currentStatus)].filter(Boolean);

    let deleted = false;
    for (const status of ordered) {
        const ok = await StorageAdapter.deleteFile(`${projectFolder}/jobs/${status}/${jobId}.json`);
        if (ok) deleted = true;
    }

    try {
        const resultFiles = await StorageAdapter.listDirectoryFiles(
            [projectFolder, 'jobs', 'results', jobId]
        );
        for (const f of resultFiles) {
            await StorageAdapter.deleteFile(`${projectFolder}/jobs/results/${jobId}/${f}`);
        }
    } catch { }

    return deleted;
}

export async function saveExternalFileByReference(fileName, filePath, fileType, spotIds, importDate) {
    const project = _requireActiveProject();

    if (!project.external_files) project.external_files = [];

    if (project.external_files.some(f => f.local_path === filePath)) return null;

    const timestamp = (importDate instanceof Date)
        ? importDate.toISOString()
        : new Date().toISOString();

    const newFileEntry = {
        id           : crypto.randomUUID(),
        name         : fileName,
        type         : fileType,
        linked_spots : spotIds,
        projectId    : project.id,
        timestamp,
        sync_status  : 'reference',
        local_path   : filePath,
        is_reference : true
    };

    project.external_files.push(newFileEntry);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);

    return newFileEntry;
}

export async function saveExternalFilesByReferenceBatch(fileDescriptors, spotIds, importDate, onProgress) {
    const project = _requireActiveProject();

    const timestamp = (importDate instanceof Date)
        ? importDate.toISOString()
        : new Date().toISOString();

    if (!project.external_files) project.external_files = [];

    const existingPaths = new Set(
        project.external_files.map(f => f.local_path).filter(Boolean)
    );

    const entries = [];
    const total   = fileDescriptors.length;
    let skipped   = 0;

    for (let i = 0; i < total; i++) {
        const { name, path, type } = fileDescriptors[i];

        if (existingPaths.has(path)) { skipped++; continue; }
        existingPaths.add(path);

        const entry = {
            id           : crypto.randomUUID(),
            name,
            type,
            linked_spots : spotIds,
            projectId    : project.id,
            timestamp,
            sync_status  : 'reference',
            local_path   : path,
            is_reference : true
        };
        project.external_files.push(entry);
        entries.push(entry);

        if (onProgress && (i % 200 === 0 || i === total - 1)) {
            onProgress(i + 1, total);
            await new Promise(r => setTimeout(r, 0));
        }
    }

    if (entries.length > 0) {
        await MasterData.saveMasterData();
        EventBus.emit(EVENTS.DATA_UPDATED);
    }

    return entries;
}

export async function saveExternalFilesBatch(files, spotIds, importDate, onProgress, concurrency = 5) {
    const project       = _requireActiveProject();
    const projectFolder = getProjectFolderName(project);
    const primarySpotId = spotIds[0];
    const spot          = (project.spots || []).find(s => s.spotId === primarySpotId);
    const safeSpot      = _safeName(
        spot?.name,
        `Spot_${(primarySpotId || '').substring(0, 8)}`
    );
    const pathArray = [projectFolder, 'spots', safeSpot, 'external_data'];

    const timestamp = (importDate instanceof Date)
        ? importDate.toISOString()
        : new Date().toISOString();

    if (!project.external_files) project.external_files = [];

    const existingNames = new Set(
        project.external_files
            .filter(f => !f.is_reference && f.linked_spots?.includes(primarySpotId))
            .map(f => f.name)
    );

    const uniqueFiles = files.filter(f => {
        if (existingNames.has(f.name)) return false;
        existingNames.add(f.name);
        return true;
    });

    const total   = uniqueFiles.length;
    let processed = 0;
    const entries = new Array(total);

    const queue = uniqueFiles.map((file, idx) => ({ file, idx }));
    const workers = [];

    for (let w = 0; w < Math.min(concurrency, total); w++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const { file, idx } = queue.shift();
                const savedPath = await StorageAdapter.saveFile(file, file.name, pathArray);

                entries[idx] = {
                    id           : crypto.randomUUID(),
                    name         : file.name,
                    type         : file.type,
                    linked_spots : spotIds,
                    projectId    : project.id,
                    timestamp,
                    sync_status  : 'pending',
                    local_path   : savedPath
                };

                processed++;
                if (onProgress) onProgress(processed, total);
            }
        })());
    }

    await Promise.all(workers);

    for (const entry of entries) {
        if (entry) project.external_files.push(entry);
    }

    if (total > 0) {
        await MasterData.saveMasterData();
        EventBus.emit(EVENTS.DATA_UPDATED);
        EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, isExternal: true, batch: true });
    }

    return entries.filter(Boolean);
}

export async function getLocalFileUrl(relativePath) {
    return StorageAdapter.getFileUrl(relativePath);
}

export async function saveJobRequest(jobData) {
    const project       = _requireActiveProject();
    const projectFolder = getProjectFolderName(project);
    const jobId         = jobData.job_id || crypto.randomUUID();

    const finalData = {
        ...jobData,
        job_id     : jobId,
        job_name   : jobData.job_name || `Job ${jobId.substring(0, 8)}`,
        project_id : project.id,
        status     : 'queued',
        created_at : new Date().toISOString()
    };

    const blob = new Blob(
        [JSON.stringify(finalData, null, 2)],
        { type: 'application/json' }
    );

    await StorageAdapter.saveFile(blob, `${jobId}.json`, [projectFolder, 'jobs', 'queue']);
    return finalData;
}

export async function getAllJobs() {
    const project = MasterData.getActiveProject();
    if (!project) return [];

    const projectFolder = getProjectFolderName(project);
    const statuses      = ['queue', 'processing', 'completed', 'failed'];

    const listResults = await Promise.allSettled(
        statuses.map(s => StorageAdapter.listDirectoryFiles([projectFolder, 'jobs', s]))
    );

    const readPromises = [];
    for (let i = 0; i < statuses.length; i++) {
        const result = listResults[i];
        if (result.status !== 'fulfilled') continue;
        const status = statuses[i];

        for (const file of result.value) {
            if (!file.endsWith('.json')) continue;
            readPromises.push(
                StorageAdapter.getFileBlob(`${projectFolder}/jobs/${status}/${file}`)
                    .then(async blob => {
                        if (!blob) return null;
                        const data = JSON.parse(await blob.text());
                        data.current_status = status;
                        return data;
                    })
                    .catch(e => {
                        console.warn(`Repository.getAllJobs: could not read "${file}":`, e);
                        return null;
                    })
            );
        }
    }

    const jobs = (await Promise.allSettled(readPromises))
        .filter(r => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value);

    // The four folders are listed concurrently, so if the watcher moves a job
    // (queue→processing→completed/failed) between two listings, the same job_id
    // can be read from two folders. Dedup, keeping the most-advanced status —
    // moves only ever go forward — so a row never doubles or shows a stale state.
    const STATUS_RANK = { queue: 0, processing: 1, failed: 2, completed: 3 };
    const byId = new Map();
    for (const job of jobs) {
        const id   = job.job_id || `__noid_${Math.random()}`;
        const prev = byId.get(id);
        if (!prev ||
            (STATUS_RANK[job.current_status] ?? -1) > (STATUS_RANK[prev.current_status] ?? -1)) {
            byId.set(id, job);
        }
    }

    return [...byId.values()].sort((a, b) => {
        const tA = new Date(a.created_at || 0).getTime();
        const tB = new Date(b.created_at || 0).getTime();
        return tB - tA;
    });
}

export async function getJobResultFiles(jobId) {
    const project = MasterData.getActiveProject();
    if (!project) return [];

    const projectFolder = getProjectFolderName(project);
    const files         = await StorageAdapter.listDirectoryFiles(
        [projectFolder, 'jobs', 'results', jobId]
    );

    return files.map(fileName => ({
        name : fileName,
        path : `${projectFolder}/jobs/results/${jobId}/${fileName}`
    }));
}

export async function getWatcherStatus() {
    try {
        const blob = await StorageAdapter.getFileBlob('system/status.json');
        if (!blob) return null;
        return JSON.parse(await blob.text());
    } catch {
        return null;
    }
}

export async function getInstalledScripts() {
    try {
        const blob = await StorageAdapter.getFileBlob('system/scripts/installed.json');
        if (!blob) return [];
        return JSON.parse(await blob.text());
    } catch (e) {
        console.error('Repository.getInstalledScripts:', e);
        return [];
    }
}

export async function getProcessedFilesCache(targetScriptFile) {
    try {
        const project = MasterData.getActiveProject();
        if (!project) return [];
        const projectFolder = getProjectFolderName(project);
        const txtPath       = `${projectFolder}/system/database/processed_${targetScriptFile}.txt`;
        const blob          = await StorageAdapter.getFileBlob(txtPath);
        if (!blob) return [];
        return (await blob.text())
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
    } catch (e) {
        console.warn(`Repository.getProcessedFilesCache("${targetScriptFile}"):`, e);
        return [];
    }
}

export async function getAnalysisCache() {
    try {
        const blob = await StorageAdapter.getFileBlob('system/analysis_cache.json');
        if (!blob) return {};
        return JSON.parse(await blob.text());
    } catch (e) {
        console.error('Repository.getAnalysisCache:', e);
        return {};
    }
}

export async function checkDependencyExists(scriptName, cacheKey) {
    const cache = await getAnalysisCache();
    return !!(cache[scriptName] && cache[scriptName][cacheKey]);
}

export async function pushMasterToDrive() {
    const token = getAccessToken();
    if (!token) return;

    try {
        const rootFolderId = await findOrCreateRootFolder();
        const state        = MasterData.getLocalState();
        const cleanState = {
            ...state,
            projects: (state.projects || []).filter(p => !p.shared?.isImported),
        };
        const blob = new Blob(
            [JSON.stringify(cleanState, null, 2)],
            { type: 'application/json' }
        );

        await upsertFile('master_data.json', rootFolderId, blob, 'application/json', 'master_data.json');
    } catch (e) {
        console.error('Repository.pushMasterToDrive: auto-push failed (offline?):', e);
    }

    try {
        const activeProject = MasterData.getActiveProject();
        if (activeProject) {
            await pushProjectDataToDrive(activeProject);
        }
    } catch (e) {
        console.error('Repository.pushMasterToDrive: project_data push failed:', e);
    }
}

export async function pushProjectDataToDrive(project) {
    const token = getAccessToken();
    if (!token || !project) return;

    try {
        const rootFolderId  = await findOrCreateRootFolder();
        const projectFolder = getProjectFolderName(project);
        const folderId      = await ensureDrivePath([projectFolder], rootFolderId);

        let projectData = { ...project };
        delete projectData.sharing;
        if (projectData.shared?.isImported) {
            delete projectData.shared;
        }
        delete projectData.external_files;

        if (project.sharing?.isShared) {
            const existing = await findFileByName('project_data.json', folderId);
            if (existing) {
                try {
                    const remote = JSON.parse(await readDriveTextFile(existing.id));
                    projectData.spots          = _mergeItemArray(projectData.spots,          remote.spots);
                    projectData.routes         = _mergeItemArray(projectData.routes,         remote.routes);
                    projectData.sites          = _mergeItemArray(projectData.sites,          remote.sites);
                    projectData.jobs           = _mergeItemArray(projectData.jobs,           remote.jobs);
                } catch { }
            }

            delete projectData.inline_files;
        }

        const blob = new Blob(
            [JSON.stringify(projectData, null, 2)],
            { type: 'application/json' }
        );

        await upsertFile('project_data.json', folderId, blob);

    } catch (e) {
        console.error(`[Repository] pushProjectDataToDrive failed for "${project.name}":`, e);
    }
}

const _mergeItemArray = (a = [], b = []) => mergeById(a, b);
