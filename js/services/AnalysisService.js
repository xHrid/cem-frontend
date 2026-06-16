/**
 * AnalysisService.js — Pure business-logic layer for the Analysis panel
 *
 * Pattern  : Module Pattern (IIFE that returns a frozen public API; internal
 *            helpers are never exposed)
 *
 * Extracted from analysis.js, which mixed DOM manipulation, event wiring,
 * and data logic together.  This module contains ONLY pure data / business
 * logic with no DOM access.  UI components import these functions and own
 * the rendering themselves.
 *
 * All I/O goes through the storage layer (storage.js), keeping this module
 * decoupled from the underlying persistence backend (native FS or IndexedDB).
 *
 * Public exports:
 *   getWatcherOnlineStatus   — parse status.json blob -> status descriptor
 *   loadInstalledScripts     — read installed.json -> script array
 *   calculateCacheOverlap    — pure cache/dependency intersection calculation
 *   buildJobData             — assemble the job JSON object
 *   queueJob                 — persist a job to the queue folder via storage
 */

import {
    getWatcherStatus,
    getInstalledScripts,
    getProcessedFilesCache,
    saveJobRequest,
} from '../data/Repository.js';

// ---------------------------------------------------------------------------
// Watcher status parsing
// ---------------------------------------------------------------------------

/**
 * Parse raw status.json data into a display-ready descriptor.
 *
 * The age thresholds come from `analysis.js` and mirror the watcher.py
 * defaults documented in Config.watcher.
 *
 * @param {object|null} statusData  Object from `getWatcherStatus()`, or null.
 * @returns {{
 *   isOnline: boolean,
 *   isBusy:   boolean,
 *   color:    string,
 *   text:     string,
 * }}
 */
export function getWatcherOnlineStatus(statusData) {
    // Offline state — no data or stale heartbeat
    const offlineResult = {
        isOnline: false,
        isBusy:   false,
        color:    'red',
        text:     'Watcher Offline',
    };

    if (!statusData) return offlineResult;

    // Compute how many seconds ago the watcher last wrote status.json.
    // The watcher may store `last_active_ts` as a UNIX epoch number (seconds)
    // or as an ISO-8601 string — handle both.
    const lastActiveMs = typeof statusData.last_active_ts === 'number'
        ? statusData.last_active_ts * 1000
        : new Date(statusData.last_active_ts).getTime();

    const ageSeconds = (Date.now() - lastActiveMs) / 1000;

    // Per-status maximum acceptable age (seconds) before considered stale
    const maxAge = {
        processing_job:           1800, // 30 min — jobs can take a while
        installing_dependencies:   600, // 10 min — pip installs can be slow
    }[statusData.status] ?? 15;         // default: heartbeat every ~10-15 s

    // Allow up to 5 seconds of clock skew in either direction
    const isAlive = !isNaN(ageSeconds) && ageSeconds >= -5 && ageSeconds < maxAge;

    if (!isAlive) {
        return {
            isOnline: false,
            isBusy:   false,
            color:    'red',
            text:     `Offline (stale ${ageSeconds.toFixed(1)} s)`,
        };
    }

    const busyStatuses = new Set(['installing_dependencies', 'syncing_scripts']);
    const isBusy       = busyStatuses.has(statusData.status);

    const colorMap = {
        installing_dependencies: '#FFC107',
        syncing_scripts:         '#17A2B8',
        processing_job:          '#28A745',
        online:                  '#28A745',
    };
    const textMap = {
        installing_dependencies: 'Setting up Environment...',
        syncing_scripts:         'Syncing Scripts...',
        processing_job:          'Processing Job...',
        online:                  'Watcher Online',
    };

    return {
        isOnline: true,
        isBusy,
        color: colorMap[statusData.status] ?? '#28A745',
        text:  textMap[statusData.status]  ?? 'Watcher Online',
    };
}

// ---------------------------------------------------------------------------
// Script registry
// ---------------------------------------------------------------------------

/**
 * Load the list of installed analysis scripts from the local storage layer.
 *
 * Delegates to `getInstalledScripts()` (storage.js) which reads
 * `system/scripts/installed.json` from the user's folder / IndexedDB.
 *
 * @returns {Promise<object[]>}  Array of script descriptor objects.
 *                               Returns `[]` if the registry is absent.
 */
export async function loadInstalledScripts() {
    try {
        return await getInstalledScripts();
    } catch (err) {
        console.error('[AnalysisService] Failed to load installed scripts:', err);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Cache overlap calculation
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CacheOverlapResult
 * @property {number}  matchingFiles        Files in range that match the selection.
 * @property {number}  cachedFiles          Of those, how many already have results.
 * @property {number}  newFiles             Files that need fresh ML processing.
 * @property {boolean} isCheckingDependency True when checking a dependency script's cache.
 * @property {boolean} hasMissingDeps       True when a dependency has unprocessed files.
 * @property {string}  message              Human-readable summary for the UI.
 */

/**
 * Calculate how many files in the selected date range / spots are already
 * cached, how many need fresh processing, and whether dependencies are met.
 *
 * This is a pure calculation — it reads from the storage layer but never
 * writes to the DOM.
 *
 * @param {string[]}  spotIds        IDs of the selected recording spots.
 * @param {string}    startDate      ISO date string "YYYY-MM-DD".
 * @param {string}    endDate        ISO date string "YYYY-MM-DD".
 * @param {object}    currentScript  Script descriptor from `installed.json`.
 * @param {object[]}  spots          Full array of spot objects (from getSpots()).
 * @param {object[]}  externalFiles  Full array of external-file entries.
 * @returns {Promise<CacheOverlapResult>}
 */
export async function calculateCacheOverlap(
    spotIds,
    startDate,
    endDate,
    currentScript,
    spots,
    externalFiles
) {
    const allScripts = await loadInstalledScripts();

    // ------------------------------------------------------------------
    // 1. Collect matching files in the selected range / spots
    // ------------------------------------------------------------------
    const startVal  = parseInt(startDate.replace(/-/g, ''), 10);
    const endVal    = parseInt(endDate.replace(/-/g, ''),   10);
    const validExts = currentScript.inputs?.[0]?.valid_extensions ?? ['.wav'];
    const extPattern = validExts.map(e => e.replace('.', '')).join('|');
    const extRegex   = new RegExp(`\\.(${extPattern})$`, 'i');
    const spotIdSet  = new Set(spotIds);

    const matchingFileNames = [];
    externalFiles.forEach(file => {
        if (!file.name.match(extRegex)) return;
        if (!file.linked_spots || !file.linked_spots.some(id => spotIdSet.has(id))) return;
        const dateMatch = file.name.match(/_(\d{8})_/);
        if (dateMatch) {
            const fileDate = parseInt(dateMatch[1], 10);
            if (fileDate < startVal || fileDate > endVal) return;
        }
        matchingFileNames.push(file.name);
    });

    const matchingFiles = matchingFileNames.length;

    if (matchingFiles === 0) {
        return {
            matchingFiles: 0, cachedFiles: 0, newFiles: 0,
            isCheckingDependency: false, hasMissingDeps: false,
            message: 'No valid audio files found for these spots and dates.',
        };
    }

    // ------------------------------------------------------------------
    // 2. No dependencies — check this script's own cache
    // ------------------------------------------------------------------
    if (!currentScript.depends_on || currentScript.depends_on.length === 0) {
        const processedFiles = await getProcessedFilesCache(currentScript.script_file);
        const processedSet   = new Set(processedFiles);
        const cachedFiles    = matchingFileNames.filter(f => processedSet.has(f)).length;
        const newFiles       = matchingFiles - cachedFiles;

        return {
            matchingFiles, cachedFiles, newFiles,
            isCheckingDependency: false, hasMissingDeps: false,
            message: (
                `${matchingFiles} file(s) in range. ` +
                `${cachedFiles} already processed. ` +
                `${newFiles} require ML processing.`
            ),
        };
    }

    // ------------------------------------------------------------------
    // 3. Has dependencies — check ALL of them
    // ------------------------------------------------------------------
    const missingByDep = [];   // [{depName, missingCount}]
    let worstCached    = matchingFiles; // track the dep with fewest cached

    for (const depId of currentScript.depends_on) {
        // Resolve dependency id → script_file for cache lookup
        const depScript     = allScripts.find(s => s.id === depId);
        const depScriptFile = depScript ? depScript.script_file : depId;
        const depName       = depScript ? depScript.name : depId;

        const processedFiles = await getProcessedFilesCache(depScriptFile);
        const processedSet   = new Set(processedFiles);
        const cached         = matchingFileNames.filter(f => processedSet.has(f)).length;
        const missing        = matchingFiles - cached;

        if (cached < worstCached) worstCached = cached;

        if (missing > 0) {
            missingByDep.push({ depName, depScriptFile, missingCount: missing });
        }
    }

    const cachedFiles    = worstCached;
    const newFiles       = matchingFiles - cachedFiles;
    const hasMissingDeps = missingByDep.length > 0;

    // ------------------------------------------------------------------
    // 4. Build message
    // ------------------------------------------------------------------
    let message;
    if (hasMissingDeps) {
        const parts = missingByDep.map(d =>
            `${d.missingCount} file(s) not yet processed by [${d.depName}]`
        );
        message = `Missing dependencies: ${parts.join('; ')}. Run those scripts first.`;
    } else {
        message = (
            `Dependencies met. All ${matchingFiles} file(s) have been processed ` +
            `by upstream scripts. Ready to run.`
        );
    }

    return {
        matchingFiles,
        cachedFiles,
        newFiles,
        isCheckingDependency: true,
        hasMissingDeps,
        message,
    };
}

// ---------------------------------------------------------------------------
// Job assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a job JSON object from the analysis form state.
 *
 * Pure function — no I/O, no DOM.  Returns a plain object ready to be
 * passed to `queueJob()`.
 *
 * @param {string}   jobName         Human-readable job name (sanitised by caller).
 * @param {object}   currentScript   Script descriptor from `installed.json`.
 * @param {string[]} spotIds         Selected spot IDs.
 * @param {string}   startDate       ISO date "YYYY-MM-DD".
 * @param {string}   endDate         ISO date "YYYY-MM-DD".
 * @param {object}   dynamicParams   Key/value pairs from the dynamic parameter form.
 * @param {object[]} spots           Full spot array (for name & audio path lookups).
 * @param {object[]} externalFiles   Full external-file array.
 * @returns {object}  Raw job descriptor (no id or timestamps yet — those are
 *                    added by `saveJobRequest` in the storage layer).
 */
export function buildJobData(
    jobName,
    currentScript,
    spotIds,
    startDate,
    endDate,
    dynamicParams,
    spots,
    externalFiles
) {
    const params = { ...dynamicParams };

    // Resolve inputs from the selected spots + their external files.
    //   - Regular copies + spot audio  → directories (relative to the project
    //     storage root).  The watcher scans these recursively.
    //   - Reference files              → explicit absolute file paths.  These
    //     live OUTSIDE the spot dirs, so the watcher passes each one through
    //     as an INPUT_FILE_LIST entry rather than collapsing it to a directory.
    // Track {path: spotName} so we can build dataset_spots aligned with datasets.
    const pathToSpot = new Map();   // relative-path → canonical spot name
    const referenceFiles = [];      // [{ path, spot }] — spot travels with each file

    externalFiles.forEach(file => {
        if (!file.local_path || !file.linked_spots) return;
        const matchId = spotIds.find(id => file.linked_spots.includes(id));
        if (!matchId) return;

        const s = spots.find(sp => sp.spotId === matchId);
        const spotName = s ? s.name.replace(/\s+/g, '').toUpperCase() : matchId;

        if (file.is_reference) {
            referenceFiles.push({ path: file.local_path, spot: spotName });
        } else {
            pathToSpot.set(file.local_path, spotName);
        }
    });

    spotIds.forEach(spotId => {
        const spot = spots.find(s => s.spotId === spotId);
        if (spot?.audio_local_filename) {
            const spotName = spot.name.replace(/\s+/g, '').toUpperCase();
            pathToSpot.set(spot.audio_local_filename, spotName);
        }
    });

    /**
     * Collapse file paths to their containing directories and build an
     * aligned spot-name array (dataset_spots).
     */
    function toDirsWithSpots(pathMap) {
        const dirMap = new Map();   // dir → spotName
        for (const [p, spotName] of pathMap) {
            const norm = p.replace(/\\/g, '/');
            let dir = norm;
            if (/\.(wav|mp3|m4a|flac)$/i.test(norm)) {
                const parts = norm.split('/');
                parts.pop();
                dir = parts.join('/');
            }
            if (dir.length > 0 && !dirMap.has(dir)) {
                dirMap.set(dir, spotName);
            }
        }
        return { dirs: [...dirMap.keys()], spots: [...dirMap.values()] };
    }

    const { dirs: datasetDirs, spots: datasetSpots } = toDirsWithSpots(pathToSpot);
    const inputFiles = referenceFiles;

    // Build spot-name string for CLI --spots flag.
    // The UI-selected spot name IS the canonical name — BirdNET will write it
    // into the aggregate via --dataset-spots, so the filter step matches.
    if (spotIds.length > 0) {
        const spotNames = spotIds.map(id => {
            const s = spots.find(spot => spot.spotId === id);
            return s ? s.name.replace(/\s+/g, '').toUpperCase() : id;
        });
        params.spots      = spotNames.join(',');
        params.start_date = startDate.replace(/-/g, '');
        params.end_date   = endDate.replace(/-/g, '');
    }

    return {
        job_name:     jobName,
        script_name:  currentScript.script_file,
        datasets:     datasetDirs,
        dataset_spots: datasetSpots,   // aligned 1:1 with datasets — canonical UI spot name per dir
        input_files:  inputFiles,
        parameters:   params,
    };
}

// ---------------------------------------------------------------------------
// Job queuing
// ---------------------------------------------------------------------------

/**
 * Persist a job descriptor to the local queue folder so that the watcher
 * process can pick it up.
 *
 * Delegates entirely to `saveJobRequest()` in the storage layer, which
 * stamps the job with an id, project_id, status, and created_at timestamp.
 *
 * @param {object} jobData  Raw job descriptor from `buildJobData()`.
 * @returns {Promise<object>}  Finalised job object as saved to disk.
 */
export async function queueJob(jobData) {
    return saveJobRequest(jobData);
}
