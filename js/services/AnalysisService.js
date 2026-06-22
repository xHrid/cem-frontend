import {
    getWatcherStatus,
    getInstalledScripts,
    getProcessedFilesCache,
    saveJobRequest,
} from '../data/Repository.js';

export function getWatcherOnlineStatus(statusData) {
    const offlineResult = {
        isOnline: false,
        isBusy:   false,
        color:    'red',
        text:     'Watcher Offline',
    };

    if (!statusData) return offlineResult;

    const lastActiveMs = typeof statusData.last_active_ts === 'number'
        ? statusData.last_active_ts * 1000
        : new Date(statusData.last_active_ts).getTime();

    const ageSeconds = (Date.now() - lastActiveMs) / 1000;

    // The watcher now refreshes the heartbeat every ~10s while a job runs, so a
    // short window is enough: a watcher that died mid-job goes stale within
    // ~90s, while a legitimately long job keeps itself fresh and never flips to
    // "Offline (stale)". (Pre-fix this was a flat 1800s, which both hid a dead
    // watcher for 30 min and wrongly stale-d jobs running longer than 30 min.)
    const maxAge = {
        processing_job:             90,
        installing_dependencies:   600,
    }[statusData.status] ?? 15;

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

export async function loadInstalledScripts() {
    try {
        return await getInstalledScripts();
    } catch (err) {
        console.error('[AnalysisService] Failed to load installed scripts:', err);
        return [];
    }
}

export async function calculateCacheOverlap(
    spotIds,
    startDate,
    endDate,
    currentScript,
    spots,
    externalFiles
) {
    const allScripts = await loadInstalledScripts();

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

    const missingByDep = [];
    let worstCached    = matchingFiles;

    for (const depId of currentScript.depends_on) {
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

    const pathToSpot = new Map();
    const referenceFiles = [];

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

    function toDirsWithSpots(pathMap) {
        const dirMap = new Map();
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
        dataset_spots: datasetSpots,
        input_files:  inputFiles,
        parameters:   params,
    };
}

export async function queueJob(jobData) {
    return saveJobRequest(jobData);
}
