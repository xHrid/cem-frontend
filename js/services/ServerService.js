/**
 * ServerService.js — "Connect to Server" compute backend
 *
 * Pattern : Module Pattern (IIFE-free ES module; private helpers are simply
 *           non-exported functions).
 *
 * This is the browser-side counterpart to watcher.py. Instead of writing a job
 * descriptor into jobs/queue/ and waiting for a local python watcher to pick it
 * up, server mode talks directly to the Dockerised FastAPI (STACD/Airflow model):
 *
 *      1. POST /api/v1/datasets/audio                -> mint a job_id + upload WAVs
 *      2. POST /api/v1/jobs/{id}/datasets/{kind}     -> upload aggregate / processed list
 *      3. POST /api/v1/jobs/{algo}  body:{job_id}     -> run step SYNCHRONOUSLY (blocks)
 *      4. GET  /api/v1/jobs/{id}/results             -> list produced files
 *         GET  /api/v1/jobs/{id}/file?path=...       -> download each one
 *
 * Downloaded results are written into the SAME local storage layout the watcher
 * uses (<project>/jobs/results/<jobId>/...), and the job descriptor is parked in
 * jobs/completed | jobs/failed, so JobsDashboard renders server jobs with zero
 * changes. For a BirdNET run we persist the server aggregate to
 * <project>/system/database/birdnet_results_server.csv (separate from the local
 * aggregate) and update the server-specific processed cache — so dedup and later
 * analysis steps keep working correctly.
 *
 * The server is stateless per job, so an analysis step has no aggregate of its
 * own. We satisfy its BirdNET dependency by uploading the locally-cached
 * aggregate (kind=aggregate) — the same CSV the watcher would have produced.
 *
 * Server URL + API key are read from Config.server (see Config.js).
 *
 * Public exports:
 *   isConfigured        — true when Config.server has a baseUrl
 *   getServerConfig     — { baseUrl }
 *   checkServerHealth   — GET /health -> { online, steps }
 *   getServerSteps      — GET /steps  -> UI-ready script descriptor array
 *   runJobOnServer      — full upload -> run -> poll -> download orchestration
 */

import Config                    from '../core/Config.js';
import EventBus, { EVENTS }      from '../core/EventBus.js';
import * as StorageAdapter       from '../data/StorageAdapter.js';
import * as MasterData           from '../data/MasterData.js';
import { getProjectFolderName }  from '../data/projectUtils.js';
import { buildJobData }          from './AnalysisService.js';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Trailing-slash-stripped base URL, or '' if unset. */
function _base() {
    return (Config.server?.baseUrl || '').replace(/\/+$/, '');
}

/** Full URL for an API path (which must start with '/'). */
function _url(path) {
    return _base() + path;
}

/**
 * True when a server URL is present in Config.
 * @returns {boolean}
 */
export function isConfigured() {
    return Boolean(_base());
}

/**
 * @returns {{ baseUrl: string }}
 */
export function getServerConfig() {
    return { baseUrl: _base() };
}

// ---------------------------------------------------------------------------
// Low-level fetch wrappers
// ---------------------------------------------------------------------------

/**
 * fetch() with an abort-based timeout. Rejects with a readable Error on
 * network failure / timeout / non-2xx.
 *
 * @param {string} url
 * @param {RequestInit} [opts]
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<Response>}
 * @private
 */
async function _fetch(url, opts = {}, timeoutMs = 30000) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
        // ngrok's free tier serves an HTML browser-warning interstitial (HTTP
        // 200, no CORS headers) instead of proxying to the server — which the
        // browser then blocks as "No Access-Control-Allow-Origin". Sending this
        // header on every request tells ngrok to skip the interstitial and pass
        // straight through. It is harmless on non-ngrok backends.
        const headers = { 'ngrok-skip-browser-warning': 'true', ...(opts.headers || {}) };
        resp = await fetch(url, { ...opts, headers, signal: ctrl.signal });
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Request timed out: ${url}`);
        // TypeError here usually means CORS / mixed-content / server unreachable
        throw new Error(`Network error reaching server (${e.message}). ` +
            `Check the URL, that the server is running, HTTPS, and CORS.`);
    } finally {
        clearTimeout(timer);
    }
    if (!resp.ok) {
        let detail = `${resp.status} ${resp.statusText}`;
        try {
            const body = await resp.clone().json();
            if (body?.detail) detail += ` — ${typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)}`;
        } catch { /* non-JSON body */ }
        throw new Error(detail);
    }
    return resp;
}

const _json = (url, opts, t) => _fetch(url, opts, t).then(r => r.json());

// ---------------------------------------------------------------------------
// Health + step catalogue
// ---------------------------------------------------------------------------

/**
 * Probe the server's /health endpoint (no auth required).
 *
 * @returns {Promise<{ online: boolean, steps: string[], error?: string }>}
 */
export async function checkServerHealth() {
    if (!_base()) return { online: false, steps: [], error: 'No server URL configured.' };
    try {
        const data = await _json(_url('/health'), {}, 8000);
        return { online: data?.status === 'ok', steps: data?.steps || [] };
    } catch (e) {
        return { online: false, steps: [], error: e.message };
    }
}

// API step id -> pipeline script filename (fallback when manifest omits it).
const _SCRIPT_FILE = {
    birdnet:                  'birdnet_predictions.py',
    heatmaps:                 'activity_heatmaps.py',
    temporal_stickiness:      'temporal_stickiness.py',
    spatial_stickiness:       'spatial_stickiness.py',
    migratory_classification: 'migratory_classification.py',
    solar_correlation:        'solar_correlation.py',
    daily_timeseries:         'daily_call_timeseries.py',
};

/**
 * Fetch the runnable step catalogue from the server (full manifest) and shape
 * it into the same descriptor objects AnalysisUI expects from installed.json.
 *
 * The server now returns parameters[], inputs[], aggregate_file etc. from the
 * manifest — the UI renders every script's tunables with their defaults.
 *
 * @returns {Promise<object[]>}
 */
export async function getServerSteps() {
    const steps = await _json(_url('/api/v1/steps'), {}, 10000);
    return Object.entries(steps).map(([id, meta]) => ({
        id,
        name:           meta.name || id,
        script_file:    _SCRIPT_FILE[id] || `${id}.py`,
        description:    meta.description || '',
        depends_on:     meta.depends_on || [],
        aggregate_file: meta.aggregate_file || '',
        inputs:         meta.inputs && meta.inputs.length
            ? meta.inputs
            : [{ type: 'spot_date_range', label: 'Select spots and date range', valid_extensions: ['.wav'] }],
        parameters:     meta.parameters || [],
    }));
}

// ---------------------------------------------------------------------------
// Local-storage input collection
// ---------------------------------------------------------------------------

/**
 * Load the server-specific processed-files cache for a script.
 * @param {string} projectFolder
 * @param {string} scriptFile   e.g. "birdnet_predictions.py"
 * @returns {Promise<Set<string>>}
 * @private
 */
async function _loadServerProcessedCache(projectFolder, scriptFile) {
    const path = `${projectFolder}/system/database/processed_${scriptFile}_server.txt`;
    try {
        const blob = await StorageAdapter.getFileBlob(path);
        if (!blob) return new Set();
        const text = await blob.text();
        return new Set(text.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    } catch {
        return new Set();
    }
}

/**
 * Collect the audio files that match the selected spots and date range,
 * PRE-FILTERING out files already in the server processed cache.
 *
 * Server mode only supports copied imports (no reference files — those live
 * on disk and can't be read from the browser). References are skipped with
 * a warning.
 *
 * @returns {Promise<{ audio: {path:string,name:string}[],
 *                      references: {path:string,name:string,spot:string}[],
 *                      skippedProcessed: number }>}
 * @private
 */
async function _collectAudioInputs(projectFolder, spotIds, startDate, endDate, currentScript, spots, externalFiles) {
    const validExts = currentScript.inputs?.[0]?.valid_extensions ?? ['.wav'];
    const extRegex  = new RegExp(`\\.(${validExts.map(e => e.replace('.', '')).join('|')})$`, 'i');
    const startVal  = parseInt(startDate.replace(/-/g, ''), 10);
    const endVal    = parseInt(endDate.replace(/-/g, ''), 10);
    const spotIdSet = new Set(spotIds);

    // Pre-filter: load server-specific processed cache
    const processedSet = await _loadServerProcessedCache(projectFolder, currentScript.script_file);

    const audio = [];
    const references = [];
    let skippedProcessed = 0;

    externalFiles.forEach(file => {
        if (!file.local_path || !file.name) return;
        if (!extRegex.test(file.name)) return;
        if (!file.linked_spots || !file.linked_spots.some(id => spotIdSet.has(id))) return;

        // Date filter (filenames carry _YYYYMMDD_); keep files with no date stamp.
        const m = file.name.match(/_(\d{8})_/);
        if (m) {
            const d = parseInt(m[1], 10);
            if (d < startVal || d > endVal) return;
        }

        const matchId  = spotIds.find(id => file.linked_spots.includes(id));
        const spot     = spots.find(sp => sp.spotId === matchId);
        const spotName = spot ? spot.name.replace(/\s+/g, '').toUpperCase() : (matchId || '');

        if (file.is_reference) {
            references.push({ path: file.local_path, name: file.name, spot: spotName });
        } else {
            // Skip files already processed on the server
            if (processedSet.has(file.name)) {
                skippedProcessed++;
                return;
            }
            audio.push({ path: file.local_path, name: file.name, spot: spotName });
        }
    });

    return { audio, references, skippedProcessed };
}

// ---------------------------------------------------------------------------
// Local job-record + result persistence (mirrors the watcher's status folders)
// ---------------------------------------------------------------------------

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Write the job descriptor JSON into jobs/<status>/<jobId>.json. */
async function _writeJobRecord(projectFolder, jobId, record, status) {
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    await StorageAdapter.saveFile(blob, `${jobId}.json`, [projectFolder, 'jobs', status]);
}

/** Move the job descriptor between status folders. */
async function _moveJobRecord(projectFolder, jobId, record, fromStatus, toStatus) {
    await _writeJobRecord(projectFolder, jobId, record, toStatus);
    await StorageAdapter.deleteFile(`${projectFolder}/jobs/${fromStatus}/${jobId}.json`);
}

/**
 * Merge new filenames into a processed-files cache.
 * @param {string} projectFolder
 * @param {string} scriptFile  e.g. "birdnet_predictions.py"
 * @param {string[]} names     filenames to append
 * @param {boolean} [server=false]  true → server-specific cache (_server suffix)
 */
async function _appendProcessedCache(projectFolder, scriptFile, names, server = false) {
    if (!names.length) return;
    const suffix   = server ? '_server' : '';
    const fileName = `processed_${scriptFile}${suffix}.txt`;
    const path     = `${projectFolder}/system/database/${fileName}`;
    let existing = [];
    try {
        const blob = await StorageAdapter.getFileBlob(path);
        if (blob) existing = (await blob.text()).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch { /* none yet */ }
    const merged = Array.from(new Set([...existing, ...names]));
    const blob   = new Blob([merged.join('\n') + '\n'], { type: 'text/plain' });
    await StorageAdapter.saveFile(blob, fileName, [projectFolder, 'system', 'database']);
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

/**
 * Run one analysis step on the lab server end-to-end.
 *
 * @param {object}   opts
 * @param {string}   opts.jobName
 * @param {object}   opts.currentScript    Script descriptor (id, script_file, depends_on, …).
 * @param {string[]} opts.spotIds
 * @param {string}   opts.startDate        'YYYY-MM-DD'
 * @param {string}   opts.endDate          'YYYY-MM-DD'
 * @param {object}   opts.dynamicParams    e.g. { snr_db: '18' }
 * @param {object[]} opts.spots
 * @param {object[]} opts.externalFiles
 * @param {boolean}  [opts.useProjectFiles=false]  When true, skip per-job uploads
 *                   and tell the server to use files from the project folder
 *                   (uploaded via the separate Upload step).
 * @param {(msg:string)=>void} [opts.onProgress]   UI status callback.
 * @returns {Promise<{ jobId: string, status: 'completed', files: number }>}
 * @throws  {Error} with a user-facing message on any failure (the local job
 *                  record is moved to jobs/failed before throwing).
 */
export async function runJobOnServer(opts) {
    const {
        jobName, currentScript, spotIds, startDate, endDate,
        dynamicParams, spots, externalFiles,
        useProjectFiles = false, onProgress = () => {},
    } = opts;

    if (!isConfigured()) {
        throw new Error('Server is not configured. Set Config.server.baseUrl.');
    }

    const project = MasterData.getActiveProject();
    if (!project) throw new Error('No active project. Initialise storage first.');
    const projectFolder = getProjectFolderName(project);

    const stepId    = currentScript.id;
    const isBirdnet = stepId === 'birdnet';
    const localJobId = crypto.randomUUID();

    // Assemble the descriptor — for server mode we exclude input_files
    // (references) since the server never analyses referenced audio.
    const jobData = buildJobData(
        jobName, currentScript, spotIds, startDate, endDate,
        dynamicParams, spots, externalFiles,
    );
    // Clean out reference data from the server job record
    delete jobData.input_files;

    const record = {
        ...jobData,
        job_id:     localJobId,
        job_name:   jobName || `Job ${localJobId.substring(0, 8)}`,
        project_id: project.id,
        mode:       'server',
        status:     'processing',
        created_at: new Date().toISOString(),
        server: { base_url: _base(), job_id: null, task_id: null },
    };

    // Park it in jobs/processing immediately so it shows up in the dashboard.
    await _writeJobRecord(projectFolder, localJobId, record, 'processing');
    EventBus.emit(EVENTS.DATA_UPDATED, null);

    try {
        // ── 1. Upload audio (birdnet) or aggregate (analysis) ────────────
        let serverJobId;
        const processedNames = [];
        let _uploadedAudio = [];

        if (useProjectFiles) {
            // ── PROJECT-FILES MODE: files already uploaded via Upload step ──
            // Create a job that references the project folder on the server.
            //    POST /api/v1/projects/{name}/jobs  → mints a job_id using
            //    the pre-uploaded project files.
            onProgress('Creating job from project files…');
            const createResp = await _json(
                _url(`/api/v1/projects/${encodeURIComponent(projectFolder)}/jobs`),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ step: stepId }),
                },
                30000,
            );
            serverJobId = createResp.job_id;
            record.server.job_id = serverJobId;
            await _writeJobRecord(projectFolder, localJobId, record, 'processing');

        } else if (isBirdnet) {
            // ── LEGACY PER-JOB UPLOAD: BirdNET ─────────────────────────────
            const { audio, references, skippedProcessed } = await _collectAudioInputs(
                projectFolder, spotIds, startDate, endDate, currentScript, spots, externalFiles);
            _uploadedAudio = audio;

            if (references.length) {
                console.warn(
                    `[ServerService] Skipping ${references.length} referenced file(s) — ` +
                    `server mode supports copied imports only.`);
                onProgress(
                    `Skipping ${references.length} referenced file(s) (server = copies only).`);
            }
            if (skippedProcessed > 0) {
                onProgress(`Filtered out ${skippedProcessed} already-processed file(s).`);
            }

            if (audio.length === 0) {
                throw new Error(
                    references.length
                        ? 'All matching files were imported by reference, which the server ' +
                          'cannot analyse. Re-import them as copies and try again.'
                        : skippedProcessed > 0
                            ? 'All matching files have already been processed on the server.'
                            : 'No audio files found for the selected spots and dates.');
            }

            onProgress(`Uploading ${audio.length} audio file(s)…`);
            const fd = new FormData();
            for (const a of audio) {
                const blob = await StorageAdapter.getFileBlob(a.path);
                if (!blob) throw new Error(`Could not read local file: ${a.name}`);
                fd.append('files', blob, a.name);
                processedNames.push(a.name);
            }
            const uploadResp = await _json(
                _url('/api/v1/datasets/audio'),
                { method: 'POST', body: fd },
                20 * 60 * 1000);
            serverJobId = uploadResp.job_id;
            record.server.job_id = serverJobId;
            await _writeJobRecord(projectFolder, localJobId, record, 'processing');

            const serverAggPath = `${projectFolder}/system/database/birdnet_results_server.csv`;
            const serverAggBlob = await StorageAdapter.getFileBlob(serverAggPath);
            if (serverAggBlob) {
                onProgress('Uploading existing server aggregate…');
                const aggFd = new FormData();
                aggFd.append('files', serverAggBlob, 'aggregate.csv');
                await _fetch(
                    _url(`/api/v1/jobs/${serverJobId}/datasets/aggregate`),
                    { method: 'POST', body: aggFd },
                    5 * 60 * 1000);
            }

            const serverProcPath = `${projectFolder}/system/database/processed_${currentScript.script_file}_server.txt`;
            const serverProcBlob = await StorageAdapter.getFileBlob(serverProcPath);
            if (serverProcBlob) {
                const procFd = new FormData();
                procFd.append('files', serverProcBlob, 'processed_files.txt');
                await _fetch(
                    _url(`/api/v1/jobs/${serverJobId}/datasets/processed`),
                    { method: 'POST', body: procFd },
                    60 * 1000);
            }
        } else {
            // ── LEGACY PER-JOB UPLOAD: Analysis step ───────────────────────
            onProgress('Uploading BirdNET aggregate…');
            const serverAggPath = `${projectFolder}/system/database/birdnet_results_server.csv`;
            const localAggPath  = `${projectFolder}/system/database/birdnet_results.csv`;
            let aggBlob = await StorageAdapter.getFileBlob(serverAggPath);
            if (!aggBlob) aggBlob = await StorageAdapter.getFileBlob(localAggPath);
            if (!aggBlob) {
                throw new Error('No BirdNET aggregate found. Run BirdNET ' +
                    '(locally or on the server) before this analysis.');
            }

            const fd = new FormData();
            fd.append('files', aggBlob, 'aggregate.csv');
            const dummyFd = new FormData();
            dummyFd.append('files', new Blob([''], { type: 'audio/wav' }), '_placeholder.wav');
            const uploadResp = await _json(
                _url('/api/v1/datasets/audio'),
                { method: 'POST', body: dummyFd },
                30 * 1000);
            serverJobId = uploadResp.job_id;
            record.server.job_id = serverJobId;
            await _writeJobRecord(projectFolder, localJobId, record, 'processing');

            await _fetch(
                _url(`/api/v1/jobs/${serverJobId}/datasets/aggregate`),
                { method: 'POST', body: fd },
                5 * 60 * 1000);
        }

        // ── 2. Run the step (SYNCHRONOUS — blocks until done) ────────────
        //    POST /api/v1/jobs/{stepId}  (job_id in body)
        onProgress('Running analysis on server…');
        const runBody = { job_id: serverJobId };

        // Required fields — spots as array, dates, spots_geo with lat/lon.
        const spotNames = spotIds.map(id => {
            const s = spots.find(sp => sp.spotId === id);
            return s ? s.name.replace(/\s+/g, '').toUpperCase() : null;
        }).filter(Boolean);
        runBody.spots      = spotNames;
        runBody.start_date = jobData.parameters?.start_date || startDate;
        runBody.end_date   = jobData.parameters?.end_date   || endDate;

        // Build spot geo from the project's spot data (latitude/longitude).
        // All spots with valid coordinates are included; the centroid of all
        // spots is used for geometry if individual coords are missing.
        const spotsGeo = spotIds.map(id => {
            const s = spots.find(sp => sp.spotId === id);
            if (!s || s.latitude == null || s.longitude == null) return null;
            const name = s.name.replace(/\s+/g, '').toUpperCase();
            return { name, lat: s.latitude, lon: s.longitude };
        }).filter(Boolean);
        runBody.spots_geo = spotsGeo;

        // Forward ALL dynamic params from the UI (manifest-driven)
        for (const [key, val] of Object.entries(dynamicParams)) {
            if (val != null && val !== '') {
                runBody[key] = val;
            }
        }

        // Send per-file spot mapping so BirdNET writes UI spot names into the
        // aggregate CSV (not filename-parsed prefixes).
        if (_uploadedAudio.length) {
            const audioSpots = {};
            for (const a of _uploadedAudio) {
                if (a.spot) audioSpots[a.name] = a.spot;
            }
            if (Object.keys(audioSpots).length) runBody.audio_spots = audioSpots;
        }

        const result = await _json(
            _url(`/api/v1/jobs/${stepId}`),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(runBody),
            },
            60 * 60 * 1000);  // 1h timeout for synchronous run

        const taskId = result.task_id;
        record.server.task_id = taskId;

        // ── 3. Check result status ───────────────────────────────────────
        if (result.status === 'skipped' || result.status === 'failed') {
            record.status = 'failed';
            record.error  = result.message || 'Server task failed.';
            record.finished_at = new Date().toISOString();
            await _moveJobRecord(projectFolder, localJobId, record, 'processing', 'failed');
            EventBus.emit(EVENTS.DATA_UPDATED, null);
            throw new Error(record.error);
        }

        // ── 4. Download results ──────────────────────────────────────────
        onProgress('Downloading results…');
        const { results = [] } = await _json(
            _url(`/api/v1/jobs/${serverJobId}/results`),
            {}, 30000);

        let saved = 0;
        let aggregateBlob = null;
        let processedBlob = null;
        for (const rel of results) {
            const resp = await _fetch(
                _url(`/api/v1/jobs/${serverJobId}/file?path=${encodeURIComponent(rel)}`),
                {}, 5 * 60 * 1000);
            const blob = await resp.blob();
            const base = rel.split('/').pop();
            await StorageAdapter.saveFile(blob, base, [projectFolder, 'jobs', 'results', localJobId]);
            saved++;
            // Capture aggregate and processed files for local persistence
            if (isBirdnet && /aggregate\.csv$/i.test(rel)) aggregateBlob = blob;
            if (isBirdnet && /processed_files\.txt$/i.test(rel)) processedBlob = blob;
        }

        // ── 5. For BirdNET: persist server aggregate + processed cache ───
        if (isBirdnet) {
            // Save to SERVER-specific aggregate path (separate from local)
            if (aggregateBlob) {
                await StorageAdapter.saveFile(
                    aggregateBlob, 'birdnet_results_server.csv',
                    [projectFolder, 'system', 'database']);
            }
            // Update server-specific processed cache
            if (processedBlob) {
                // The server returns the full merged processed list — save it directly
                await StorageAdapter.saveFile(
                    processedBlob, `processed_${currentScript.script_file}_server.txt`,
                    [projectFolder, 'system', 'database']);
            } else {
                // Fallback: append the names we uploaded
                await _appendProcessedCache(projectFolder, currentScript.script_file, processedNames, true);
            }
        }

        // ── 6. Mark completed ────────────────────────────────────────────
        record.status      = 'completed';
        record.finished_at = new Date().toISOString();
        record.result_count = saved;
        await _moveJobRecord(projectFolder, localJobId, record, 'processing', 'completed');
        EventBus.emit(EVENTS.DATA_UPDATED, null);

        onProgress(`Done — ${saved} file(s) downloaded.`);
        return { jobId: localJobId, status: 'completed', files: saved };

    } catch (e) {
        // Best-effort move to failed so the job doesn't get stuck "processing".
        try {
            record.status = 'failed';
            record.error  = record.error || e.message;
            record.finished_at = record.finished_at || new Date().toISOString();
            await _moveJobRecord(projectFolder, localJobId, record, 'processing', 'failed');
            EventBus.emit(EVENTS.DATA_UPDATED, null);
        } catch { /* record may already be moved */ }
        throw e;
    }
}
