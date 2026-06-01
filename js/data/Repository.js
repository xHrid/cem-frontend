/**
 * Repository.js — All data read / write operations
 *
 * Pattern : Factory (elements of)
 *           Each save function acts as a factory: it assembles a typed record
 *           object (Spot, Site, Route, ExternalFile, Job) from raw inputs,
 *           persists it, and returns the canonical record so callers don't have
 *           to reconstruct it themselves.
 *
 * Bug fixes over original storage.js
 * ------------------------------------
 *  1. saveSpot()         — 4th parameter `recordDate` was silently dropped.
 *                          The timestamp is now `recordDate.toISOString()` when
 *                          supplied, falling back to `new Date().toISOString()`.
 *  2. saveExternalFile() — 3rd parameter `importDate` was silently dropped.
 *                          Same fix: use it for the timestamp when provided.
 *  3. saveSite()         — Now accepts a `clusters` parameter and stores it on
 *                          the site record so clustering metadata is not lost.
 */

import EventBus, { EVENTS }       from '../core/EventBus.js';
import * as StorageAdapter         from './StorageAdapter.js';
import * as MasterData             from './MasterData.js';
import { getProjectFolderName }    from './projectUtils.js';
import { getAccessToken }          from '../services/AuthService.js';
import {
    findOrCreateRootFolder,
    findFileByName,
    updateDriveFile,
    uploadFile,
    ensureDrivePath
} from '../services/DriveService.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return the active project, throwing a descriptive error if none exists.
 * Used by every save function as a guard before writing any data.
 *
 * @returns {object}
 * @throws  {Error}
 */
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

/**
 * Sanitize a display name for use as a filesystem folder / file segment.
 * Converts non-alphanumeric characters to underscores, collapses runs of
 * underscores, and strips leading/trailing underscores.
 *
 * @param {string} name
 * @param {string} [fallback='Unknown']
 * @returns {string}
 */
function _safeName(name, fallback = 'Unknown') {
    const clean = (name || '')
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_{2,}/g,      '_')
        .replace(/^_|_$/g,      '');
    return clean || fallback;
}

// ---------------------------------------------------------------------------
// Spot
// ---------------------------------------------------------------------------

/**
 * Persist a new spot (with optional image and audio blobs) to local storage,
 * then emit DATA_UPDATED and push master JSON to Drive.
 *
 * Bug fix: the original accepted only 3 parameters; the `recordDate` (4th)
 * was dropped, so all spots got `new Date().toISOString()` regardless of when
 * the observation was actually made.  Now `recordDate` drives the timestamp
 * when provided.
 *
 * @param {object}    spotData    Plain spot object (name, coords, notes, …).
 * @param {Blob|null} imageBlob   Cover image; null if no photo was taken.
 * @param {Blob|null} audioBlob   Voice note; null if no audio was recorded.
 * @param {Date|null} recordDate  The real observation date/time. When omitted
 *                                the current system clock is used.
 * @returns {Promise<object>}     The fully populated spot record that was saved.
 */
export async function saveSpot(spotData, imageBlob, audioBlob, recordDate) {
    const project       = _requireActiveProject();
    const projectFolder = getProjectFolderName(project);
    const spotId        = spotData.spotId || crypto.randomUUID();

    // Derive a safe folder name from the spot's display name.
    const safeSpot    = _safeName(spotData.name, `Spot_${spotId.substring(0, 8)}`);
    const spotPath    = [projectFolder, 'spots', safeSpot];

    let imgPath   = null;
    let audioPath = null;

    if (imageBlob) {
        imgPath = await StorageAdapter.saveFile(
            imageBlob,
            `${safeSpot}_cover.jpg`,
            [...spotPath, 'images']
        );
    }

    if (audioBlob) {
        audioPath = await StorageAdapter.saveFile(
            audioBlob,
            `${safeSpot}_note.webm`,
            [...spotPath, 'audio']
        );
    }

    // Bug fix: use recordDate for the canonical timestamp when provided.
    const timestamp = (recordDate instanceof Date)
        ? recordDate.toISOString()
        : new Date().toISOString();

    const newSpot = {
        ...spotData,
        spotId,
        projectId              : project.id,
        timestamp,
        image_local_filename   : imgPath,
        audio_local_filename   : audioPath
    };

    if (!project.spots) project.spots = [];
    project.spots.push(newSpot);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
    // Drive push is centralised in SyncEngine (debounced on DATA_UPDATED).

    // Auto-sync media files (non-external → automatic)
    if (imgPath) {
        EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: imgPath, isExternal: false });
    }
    if (audioPath) {
        EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: audioPath, isExternal: false });
    }

    return newSpot;
}

// ---------------------------------------------------------------------------
// Site
// ---------------------------------------------------------------------------

/**
 * Persist a new site (KML file + optional cluster data).
 *
 * Bug fix: original accepted only 2 parameters; `clusters` was added as a 3rd
 * so cluster metadata from the analysis layer is stored alongside the site.
 *
 * @param {string}    siteName  Display name for the site.
 * @param {File|Blob} kmlFile   The KML boundary file.
 * @param {object[]|null} clusters  Optional cluster analysis results to attach.
 * @returns {Promise<object>}   The saved site record.
 */
export async function saveSite(siteName, kmlFile, clusters) {
    const project       = _requireActiveProject();
    const projectFolder = getProjectFolderName(project);

    const kmlPath = await StorageAdapter.saveFile(
        kmlFile,
        `${siteName}.kml`,
        [projectFolder, 'sites']
    );

    const newSite = {
        id             : crypto.randomUUID(),
        projectId      : project.id,
        name           : siteName,
        kml_filename   : kmlPath,
        clusters       : clusters || null,  // Bug fix: persist clusters param.
        timestamp      : new Date().toISOString()
    };

    if (!project.sites) project.sites = [];
    project.sites.push(newSite);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
    // Drive push is centralised in SyncEngine (debounced on DATA_UPDATED).

    // Auto-sync KML (non-external → automatic)
    if (kmlPath) {
        EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: kmlPath, isExternal: false });
    }

    return newSite;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * Persist a new route (GeoJSON / GPX payload already in routeData).
 *
 * @param {object} routeData  Raw route payload (coordinates, name, notes, …).
 * @returns {Promise<object>} The saved route record.
 */
export async function saveRoute(routeData) {
    const project = _requireActiveProject();

    const newRoute = {
        ...routeData,
        id        : crypto.randomUUID(),
        projectId : project.id,
        timestamp : new Date().toISOString()
    };

    if (!project.routes) project.routes = [];
    project.routes.push(newRoute);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
    // Drive push is centralised in SyncEngine (debounced on DATA_UPDATED).

    return newRoute;
}

// ---------------------------------------------------------------------------
// External file
// ---------------------------------------------------------------------------

/**
 * Persist a file imported from an external source and link it to one or more spots.
 *
 * Bug fix: the original accepted only 2 parameters; `importDate` was the
 * documented 3rd parameter but was silently dropped, causing all imported files
 * to receive the current timestamp instead of their true import date.
 *
 * @param {File|Blob} fileObj     The file to save.
 * @param {string[]}  spotIds     UUIDs of spots this file is associated with.
 * @param {Date|null} importDate  When the file was originally imported; falls
 *                                back to current time if not provided.
 * @returns {Promise<object>}     The saved external-file record.
 */
export async function saveExternalFile(fileObj, spotIds, importDate) {
    const project       = _requireActiveProject();
    const projectFolder = getProjectFolderName(project);

    // Resolve the primary spot so we can place the file inside its folder.
    const primarySpotId = spotIds[0];
    const spot          = (project.spots || []).find(s => s.spotId === primarySpotId);

    const safeSpot = _safeName(
        spot?.name,
        `Spot_${(primarySpotId || '').substring(0, 8)}`
    );

    const pathArray = [projectFolder, 'spots', safeSpot, 'external_data'];
    const savedPath = await StorageAdapter.saveFile(fileObj, fileObj.name, pathArray);

    // Bug fix: use importDate for the canonical timestamp when provided.
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
    // Drive push is centralised in SyncEngine (debounced on DATA_UPDATED).

    // External imports → manual sync only (isExternal: true)
    if (savedPath) {
        EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: savedPath, isExternal: true });
    }

    return newFileEntry;
}

// ---------------------------------------------------------------------------
// Delete — Spot
// ---------------------------------------------------------------------------

/**
 * Delete a spot by its spotId from the active project.
 *
 * @param {string} spotId  UUID of the spot to remove.
 * @returns {Promise<void>}
 */
export async function deleteSpot(spotId) {
    const project = _requireActiveProject();
    if (!project.spots) return;
    project.spots = project.spots.filter(s => s.spotId !== spotId);
    // Also remove any external files linked exclusively to this spot
    if (project.external_files) {
        project.external_files = project.external_files.filter(f => {
            if (!f.linked_spots) return true;
            f.linked_spots = f.linked_spots.filter(id => id !== spotId);
            return f.linked_spots.length > 0;
        });
    }
    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
    // Drive push is centralised in SyncEngine (debounced on DATA_UPDATED).
}

// ---------------------------------------------------------------------------
// Delete — Site
// ---------------------------------------------------------------------------

/**
 * Delete a site by its id from the active project.
 *
 * @param {string} siteId  UUID of the site to remove.
 * @returns {Promise<void>}
 */
export async function deleteSite(siteId) {
    const project = _requireActiveProject();
    if (!project.sites) return;
    project.sites = project.sites.filter(s => s.id !== siteId);
    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
    // Drive push is centralised in SyncEngine (debounced on DATA_UPDATED).
}

// ---------------------------------------------------------------------------
// Delete — Route
// ---------------------------------------------------------------------------

/**
 * Delete a route by its id from the active project.
 *
 * @param {string} routeId  UUID of the route to remove.
 * @returns {Promise<void>}
 */
export async function deleteRoute(routeId) {
    const project = _requireActiveProject();
    if (!project.routes) return;
    project.routes = project.routes.filter(r => r.id !== routeId);
    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
    // Drive push is centralised in SyncEngine (debounced on DATA_UPDATED).
}

// ---------------------------------------------------------------------------
// Delete — External file
// ---------------------------------------------------------------------------

/**
 * Delete an external file by its id from the active project.
 *
 * @param {string} fileId  UUID of the external file to remove.
 * @returns {Promise<void>}
 */
export async function deleteExternalFile(fileId) {
    const project = _requireActiveProject();
    if (!project.external_files) return;
    project.external_files = project.external_files.filter(f => f.id !== fileId);
    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
    // Drive push is centralised in SyncEngine (debounced on DATA_UPDATED).
}

// ---------------------------------------------------------------------------
// Delete — Job
// ---------------------------------------------------------------------------

/**
 * Delete a job JSON file from its status folder.
 *
 * @param {string} jobId          UUID of the job.
 * @param {string} currentStatus  The job's current status folder (queue/processing/completed/failed).
 * @returns {Promise<void>}
 */
export async function deleteJob(jobId, currentStatus) {
    const project = MasterData.getActiveProject();
    if (!project) return;
    const projectFolder = getProjectFolderName(project);
    await StorageAdapter.deleteFile(`${projectFolder}/jobs/${currentStatus}/${jobId}.json`);
    // Also try to delete result files
    try {
        const resultFiles = await StorageAdapter.listDirectoryFiles(
            [projectFolder, 'jobs', 'results', jobId]
        );
        for (const f of resultFiles) {
            await StorageAdapter.deleteFile(`${projectFolder}/jobs/results/${jobId}/${f}`);
        }
    } catch { /* results folder may not exist */ }
}

// ---------------------------------------------------------------------------
// Save — External file by reference (no copy)
// ---------------------------------------------------------------------------

/**
 * Save an external file entry as a reference (path only, no file copy).
 *
 * @param {string}   fileName    Original file name.
 * @param {string}   filePath    Full path to the file on disk.
 * @param {string}   fileType    MIME type of the file.
 * @param {string[]} spotIds     UUIDs of spots this file is associated with.
 * @param {Date|null} importDate When the file was originally imported.
 * @returns {Promise<object>}    The saved external-file record.
 */
export async function saveExternalFileByReference(fileName, filePath, fileType, spotIds, importDate) {
    const project = _requireActiveProject();

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

    if (!project.external_files) project.external_files = [];
    project.external_files.push(newFileEntry);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
    // Drive push is centralised in SyncEngine (debounced on DATA_UPDATED).

    return newFileEntry;
}

// ---------------------------------------------------------------------------
// File URL helper
// ---------------------------------------------------------------------------

/**
 * Resolve a stored relative path to an Object URL.
 * Delegates to StorageAdapter — see that module for blob-URL tracking notes.
 *
 * @param {string|null} relativePath
 * @returns {Promise<string|null>}
 */
export async function getLocalFileUrl(relativePath) {
    return StorageAdapter.getFileUrl(relativePath);
}

// ---------------------------------------------------------------------------
// Analysis — Jobs
// ---------------------------------------------------------------------------

/**
 * Queue a new analysis job by writing its descriptor JSON into the project's
 * jobs/queue/ folder.  The watcher.py process polls this folder.
 *
 * @param {object} jobData  Job descriptor (target files, script name, params, …).
 * @returns {Promise<object>} The finalised job descriptor (with generated id).
 */
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

/**
 * Collect all job descriptors from every status sub-folder (queue, processing,
 * completed, failed) and return them sorted newest-first.
 *
 * @returns {Promise<object[]>}
 */
export async function getAllJobs() {
    const project = MasterData.getActiveProject();
    if (!project) return [];

    const projectFolder = getProjectFolderName(project);
    const statuses      = ['queue', 'processing', 'completed', 'failed'];

    // Parallel folder listing — all 4 status folders are independent I/O
    const listResults = await Promise.allSettled(
        statuses.map(s => StorageAdapter.listDirectoryFiles([projectFolder, 'jobs', s]))
    );

    // Parallel JSON reads across all folders
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

    return jobs.sort((a, b) => {
        const tA = new Date(a.created_at || 0).getTime();
        const tB = new Date(b.created_at || 0).getTime();
        return tB - tA;
    });
}

/**
 * List result files produced by a completed job.
 *
 * @param {string} jobId
 * @returns {Promise<Array<{name: string, path: string}>>}
 */
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

// ---------------------------------------------------------------------------
// System — watcher / scripts / caches
// ---------------------------------------------------------------------------

/**
 * Read the watcher.py heartbeat status file.
 * This file lives at the global system root, not inside any project folder.
 *
 * @returns {Promise<object|null>}
 */
export async function getWatcherStatus() {
    try {
        const blob = await StorageAdapter.getFileBlob('system/status.json');
        if (!blob) return null;
        return JSON.parse(await blob.text());
    } catch {
        return null;
    }
}

/**
 * Read the installed-scripts registry.
 * Lives at system/scripts/installed.json (global, not per-project).
 *
 * @returns {Promise<object[]>}
 */
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

/**
 * Read the per-script list of already-processed file names.
 *
 * Single source of truth: the script's own processed-files list at
 * <projectFolder>/system/database/processed_<scriptFile>.txt — one filename
 * per line, written by the analysis script itself. (The old watcher-generated
 * cache_<scriptFile>.json has been removed to avoid two copies of the same data.)
 *
 * @param {string} targetScriptFile  Script identifier, e.g. 'birdnet_predictions.py'.
 * @returns {Promise<string[]>}       Array of processed file names.
 */
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

/**
 * Read the global analysis result cache.
 *
 * @returns {Promise<object>}
 */
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

/**
 * Check whether a specific dependency is recorded in the analysis cache.
 *
 * @param {string} scriptName  The script whose cache entry to inspect.
 * @param {string} cacheKey    The dependency key to look up.
 * @returns {Promise<boolean>}
 */
export async function checkDependencyExists(scriptName, cacheKey) {
    const cache = await getAnalysisCache();
    return !!(cache[scriptName] && cache[scriptName][cacheKey]);
}

// ---------------------------------------------------------------------------
// Drive sync — master JSON push
// ---------------------------------------------------------------------------

/**
 * Push the current local masterData JSON to Google Drive.
 *
 * Fire-and-forget: callers should NOT await this.  Errors are caught and
 * logged without bubbling so a connectivity issue never breaks a local save.
 *
 * Requires an active Drive access token (getAccessToken() returns non-null).
 * If the user is not authenticated the function returns immediately.
 *
 * @returns {Promise<void>}
 */
export async function pushMasterToDrive() {
    const token = getAccessToken();
    if (!token) return;

    try {
        const rootFolderId = await findOrCreateRootFolder();
        const driveFile    = await findFileByName('master_data.json', rootFolderId);
        const state        = MasterData.getLocalState();
        // Strip imported projects — they belong to other users, not our Drive
        const cleanState = {
            ...state,
            projects: (state.projects || []).filter(p => !p.shared?.isImported),
        };
        const blob         = new Blob(
            [JSON.stringify(cleanState, null, 2)],
            { type: 'application/json' }
        );

        if (driveFile) {
            await updateDriveFile(driveFile.id, blob);
            console.log('StorageAdapter: auto-pushed master JSON to Drive.');
        } else {
            await uploadFile(blob, 'master_data.json', 'application/json', rootFolderId);
            console.log('StorageAdapter: created master JSON on Drive.');
        }
    } catch (e) {
        console.error('Repository.pushMasterToDrive: auto-push failed (offline?):', e);
    }

    // Also push per-project project_data.json for the active project
    try {
        const activeProject = MasterData.getActiveProject();
        if (activeProject) {
            await pushProjectDataToDrive(activeProject);
        }
    } catch (e) {
        console.error('Repository.pushMasterToDrive: project_data push failed:', e);
    }
}

// ---------------------------------------------------------------------------
// Drive sync — per-project JSON push
// ---------------------------------------------------------------------------

/**
 * Push a project's data as `project_data.json` inside its Drive folder.
 *
 * This makes the project folder self-contained — when shared, recipients
 * can read project_data.json directly without needing access to the
 * parent master_data.json.
 *
 * @param {object} project  The project object to push.
 * @returns {Promise<void>}
 */
export async function pushProjectDataToDrive(project) {
    const token = getAccessToken();
    if (!token || !project) return;

    try {
        const rootFolderId  = await findOrCreateRootFolder();
        const projectFolder = getProjectFolderName(project);
        const folderId      = await ensureDrivePath([projectFolder], rootFolderId);

        // Build clean project data (strip local sharing/import metadata)
        const projectData = { ...project };
        delete projectData.sharing; // Owner-only metadata, not for recipients
        // Keep shared metadata only if it's the owner's project (not imported)
        if (projectData.shared?.isImported) {
            delete projectData.shared;
        }

        const blob = new Blob(
            [JSON.stringify(projectData, null, 2)],
            { type: 'application/json' }
        );

        const existing = await findFileByName('project_data.json', folderId);

        if (existing) {
            await updateDriveFile(existing.id, blob);
        } else {
            await uploadFile(blob, 'project_data.json', 'application/json', folderId);
        }

        console.log(`[Repository] Pushed project_data.json for "${project.name}".`);
    } catch (e) {
        console.error(`[Repository] pushProjectDataToDrive failed for "${project.name}":`, e);
    }
}
