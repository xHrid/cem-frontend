/**
 * ServerService.js — "Connect to Server" compute backend
 *
 * Talks to the CEM FastAPI server:
 *
 *      1. POST /api/v1/scripts                    -> create job + run script (script name in body)
 *      2. GET  /api/v1/jobs/{id}/results          -> list produced files
 *         GET  /api/v1/jobs/{id}/file?path=...    -> download each one
 *
 * Files are uploaded separately via ServerUploadService (project upload system).
 * This service only triggers analysis and downloads results.
 *
 * Downloaded results are written into the SAME local storage layout the watcher
 * uses, so JobsDashboard renders server jobs with zero changes.
 *
 * Public exports:
 *   isConfigured        — true when Config.server has a baseUrl
 *   getServerConfig     — { baseUrl }
 *   checkServerHealth   — GET /health -> { online, steps }
 *   getServerSteps      — GET /steps  -> UI-ready script descriptor array
 *   runJobOnServer      — full run -> download orchestration
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

function _base() {
    return (Config.server?.baseUrl || '').replace(/\/+$/, '');
}

function _url(path) {
    return _base() + path;
}

function _airflowUrl() {
    return (Config.airflow?.triggerUrl || '').replace(/\/+$/, '') || '';
}

function _generateJobId() {
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(6)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    return `job_${hex}`;
}

export function isConfigured() {
    return Boolean(_base());
}

export function getServerConfig() {
    return { baseUrl: _base(), airflowUrl: _airflowUrl() };
}

// ---------------------------------------------------------------------------
// Low-level fetch wrappers
// ---------------------------------------------------------------------------

async function _fetch(url, opts = {}, timeoutMs = 30000) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
        const headers = { 'ngrok-skip-browser-warning': 'true', ...(opts.headers || {}) };
        resp = await fetch(url, { ...opts, headers, signal: ctrl.signal });
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Request timed out: ${url}`);
        throw new Error(`Network error reaching server (${e.message}). ` +
            `Check the URL, that the server is running, HTTPS, and CORS.`);
    } finally {
        clearTimeout(timer);
    }
    if (!resp.ok) {
        let detail = `${resp.status} ${resp.statusText}`;
        try {
            const body = await resp.clone().json();
            const msg = body?.detail || body?.message;
            if (msg) detail += ` — ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
        } catch { /* non-JSON body */ }
        throw new Error(detail);
    }
    return resp;
}

const _json = (url, opts, t) => _fetch(url, opts, t).then(r => r.json());

// ---------------------------------------------------------------------------
// Health + step catalogue
// ---------------------------------------------------------------------------

export async function checkServerHealth() {
    if (!_base()) return { online: false, steps: [], error: 'No server URL configured.' };
    try {
        const data = await _json(_url('/health'), {}, 8000);
        return { online: data?.status === 'ok', steps: data?.steps || [] };
    } catch (e) {
        return { online: false, steps: [], error: e.message };
    }
}

const _SCRIPT_FILE = {
    birdnet:                  'birdnet_predictions.py',
    acoustic_indices:         'acoustic_indices.py',
    heatmaps:                 'activity_heatmaps.py',
    temporal_stickiness:      'temporal_stickiness.py',
    spatial_stickiness:       'spatial_stickiness.py',
    migratory_classification: 'migratory_classification.py',
    solar_correlation:        'solar_correlation.py',
    daily_timeseries:         'daily_call_timeseries.py',
};

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
// Local job-record + result persistence
// ---------------------------------------------------------------------------

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Airflow helpers
// ---------------------------------------------------------------------------

async function _triggerAirflow(body) {
    const url = _airflowUrl();
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Airflow trigger failed: ${resp.status}${text ? ' — ' + text : ''}`);
    }
}

async function _pollJobCompletion(jobId, onProgress) {
    const POLL_MS = 5000;
    const MAX_MS  = 60 * 60 * 1000;          // 1 hour
    const start   = Date.now();

    while (Date.now() - start < MAX_MS) {
        await _sleep(POLL_MS);
        let data;
        try {
            data = await _json(_url(`/api/v1/jobs/${jobId}`), {}, 10000);
        } catch (e) {
            // 404 → Airflow hasn't called the server yet
            if (e.message.includes('404')) {
                onProgress('Waiting for pipeline to start…');
                continue;
            }
            throw e;
        }
        const tasks = data.tasks || [];
        if (!tasks.length) { onProgress('Job created — waiting for task…'); continue; }
        const task = tasks[tasks.length - 1];
        if (task.status === 'success' || task.status === 'failed') {
            return { jobData: data, task };
        }
        onProgress(`Server processing… (${task.status})`);
    }
    throw new Error('Timed out waiting for pipeline (1 hour).');
}

async function _writeJobRecord(projectFolder, jobId, record, status) {
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    await StorageAdapter.saveFile(blob, `${jobId}.json`, [projectFolder, 'jobs', status]);
}

async function _moveJobRecord(projectFolder, jobId, record, fromStatus, toStatus) {
    await _writeJobRecord(projectFolder, jobId, record, toStatus);
    await StorageAdapter.deleteFile(`${projectFolder}/jobs/${fromStatus}/${jobId}.json`);
}

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
 * Run one analysis step end-to-end.
 *
 * Two modes determined by Config.airflow.triggerUrl:
 *
 *   Airflow mode  — POST body to Airflow trigger URL → poll server
 *                   GET /jobs/{id} until task completes → download results.
 *   Direct mode   — POST /api/v1/scripts synchronously → download results.
 *
 * In both modes the frontend generates the job_id and passes it in the body
 * so the server uses it (no ID mismatch between local record & server).
 *
 * @param {object}   opts
 * @param {string}   opts.jobName
 * @param {object}   opts.currentScript    Script descriptor (id, script_file, …).
 * @param {string[]} opts.spotIds
 * @param {string}   opts.startDate        'YYYY-MM-DD'
 * @param {string}   opts.endDate          'YYYY-MM-DD'
 * @param {object}   opts.dynamicParams    e.g. { snr_db: '18' }
 * @param {object[]} opts.spots
 * @param {object[]} opts.externalFiles
 * @param {(msg:string)=>void} [opts.onProgress]
 * @returns {Promise<{ jobId: string, status: 'completed', files: number }>}
 */
export async function runJobOnServer(opts) {
    const {
        jobName, currentScript, spotIds, startDate, endDate,
        dynamicParams, spots, externalFiles,
        onProgress = () => {},
    } = opts;

    if (!isConfigured()) {
        throw new Error('Server is not configured. Set Config.server.baseUrl.');
    }

    const project = MasterData.getActiveProject();
    if (!project) throw new Error('No active project. Initialise storage first.');
    const projectFolder = getProjectFolderName(project);

    const stepId     = currentScript.id;
    const isBirdnet  = stepId === 'birdnet';
    const useAirflow = Boolean(_airflowUrl());
    const jobId      = _generateJobId();

    const jobData = buildJobData(
        jobName, currentScript, spotIds, startDate, endDate,
        dynamicParams, spots, externalFiles,
    );
    delete jobData.input_files;

    const record = {
        ...jobData,
        job_id:     jobId,
        job_name:   jobName || `Job ${jobId}`,
        project_id: project.id,
        mode:       useAirflow ? 'airflow' : 'server',
        status:     'processing',
        created_at: new Date().toISOString(),
        server: { base_url: _base(), job_id: jobId, task_id: null },
    };

    await _writeJobRecord(projectFolder, jobId, record, 'processing');
    EventBus.emit(EVENTS.DATA_UPDATED, null);

    try {
        // ── 1. Build request body ──────────────────────────────────────
        onProgress('Preparing analysis…');

        const _spotNames = spotIds.map(id => {
            const s = spots.find(sp => sp.spotId === id);
            return s ? s.name.replace(/\s+/g, '').toUpperCase() : null;
        }).filter(Boolean);
        const _spotsGeo = spotIds.map(id => {
            const s = spots.find(sp => sp.spotId === id);
            if (!s || s.latitude == null || s.longitude == null) return null;
            return { name: s.name.replace(/\s+/g, '').toUpperCase(), lat: s.latitude, lon: s.longitude };
        }).filter(Boolean);

        const runBody = {
            project:    projectFolder,
            spots:      _spotNames,
            start_date: jobData.parameters?.start_date || startDate,
            end_date:   jobData.parameters?.end_date   || endDate,
            spots_geo:  _spotsGeo,
            job_id:     jobId,
            script:     stepId,
        };
        for (const [key, val] of Object.entries(dynamicParams)) {
            if (val != null && val !== '') runBody[key] = val;
        }

        // ── 2. Trigger + await completion ──────────────────────────────
        let taskId = null;

        if (useAirflow) {
            // ── Airflow mode: trigger DAG, then poll server ────────────
            onProgress('Triggering Airflow pipeline…');
            await _triggerAirflow(runBody);

            onProgress('Pipeline triggered — polling for results…');
            const { task } = await _pollJobCompletion(jobId, onProgress);
            taskId = task.task_id;
            record.server.task_id = taskId;

            if (task.status === 'failed') {
                let logText = '';
                try {
                    const logResp = await _fetch(
                        _url(`/api/v1/jobs/${jobId}/tasks/${taskId}/log`), {}, 10000);
                    logText = await logResp.text();
                } catch { /* not critical */ }
                record.status = 'failed';
                record.error  = task.error || 'Pipeline failed on server.';
                if (logText) record.run_log = logText;
                record.finished_at = new Date().toISOString();
                await _moveJobRecord(projectFolder, jobId, record, 'processing', 'failed');
                EventBus.emit(EVENTS.DATA_UPDATED, null);
                throw new Error(record.error);
            }
        } else {
            // ── Direct mode: POST /scripts synchronously ───────────────
            onProgress('Running analysis on server…');
            const scriptCtrl  = new AbortController();
            const scriptTimer = setTimeout(() => scriptCtrl.abort(), 60 * 60 * 1000);
            let scriptResp;
            try {
                scriptResp = await fetch(_url('/api/v1/scripts'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
                    body: JSON.stringify(runBody),
                    signal: scriptCtrl.signal,
                });
            } catch (e) {
                if (e.name === 'AbortError') throw new Error('Script request timed out (1 h).');
                throw new Error(`Network error reaching server: ${e.message}`);
            } finally {
                clearTimeout(scriptTimer);
            }
            const result = await scriptResp.json();
            taskId = result.task_id;
            record.server.task_id = taskId;
            await _writeJobRecord(projectFolder, jobId, record, 'processing');

            if (!scriptResp.ok || result.status === 'skipped' || result.status === 'failed') {
                let logText = '';
                if (taskId) {
                    try {
                        const logResp = await _fetch(
                            _url(`/api/v1/jobs/${jobId}/tasks/${taskId}/log`), {}, 10000);
                        logText = await logResp.text();
                    } catch { /* not critical */ }
                }
                record.status = 'failed';
                record.error  = result.message || result.detail || `Server returned ${scriptResp.status}`;
                if (logText) record.run_log = logText;
                record.finished_at = new Date().toISOString();
                await _moveJobRecord(projectFolder, jobId, record, 'processing', 'failed');
                EventBus.emit(EVENTS.DATA_UPDATED, null);
                throw new Error(record.error);
            }
        }

        // ── 3. Download results ────────────────────────────────────────
        onProgress('Downloading results…');
        const { results = [] } = await _json(
            _url(`/api/v1/jobs/${jobId}/results`), {}, 30000);

        let saved = 0;
        let aggregateBlob = null;
        let processedBlob = null;
        for (const rel of results) {
            const resp = await _fetch(
                _url(`/api/v1/jobs/${jobId}/file?path=${encodeURIComponent(rel)}`),
                {}, 5 * 60 * 1000);
            const blob = await resp.blob();
            const base = rel.split('/').pop();
            await StorageAdapter.saveFile(blob, base, [projectFolder, 'jobs', 'results', jobId]);
            saved++;
            if (isBirdnet && /aggregate\.csv$/i.test(rel)) aggregateBlob = blob;
            if (isBirdnet && /processed_files\.txt$/i.test(rel)) processedBlob = blob;
        }

        // ── 4. BirdNET: persist aggregate + processed cache ────────────
        if (isBirdnet) {
            if (aggregateBlob) {
                await StorageAdapter.saveFile(
                    aggregateBlob, 'birdnet_results_server.csv',
                    [projectFolder, 'system', 'database']);
            }
            if (processedBlob) {
                await StorageAdapter.saveFile(
                    processedBlob, `processed_${currentScript.script_file}_server.txt`,
                    [projectFolder, 'system', 'database']);
            }
        }

        // ── 5. Mark completed ──────────────────────────────────────────
        record.status      = 'completed';
        record.finished_at = new Date().toISOString();
        record.result_count = saved;
        await _moveJobRecord(projectFolder, jobId, record, 'processing', 'completed');

        try {
            const { recordCompletedJobs } = await import('./ProjectFilesSync.js');
            await recordCompletedJobs(project);
        } catch (e) { console.warn('[ServerService] recordCompletedJobs:', e.message); }

        EventBus.emit(EVENTS.DATA_UPDATED, null);

        onProgress(`Done — ${saved} file(s) downloaded.`);
        return { jobId, status: 'completed', files: saved };

    } catch (e) {
        try {
            record.status = 'failed';
            record.error  = record.error || e.message;
            record.finished_at = record.finished_at || new Date().toISOString();
            await _moveJobRecord(projectFolder, jobId, record, 'processing', 'failed');
            EventBus.emit(EVENTS.DATA_UPDATED, null);
        } catch { /* record may already be moved */ }
        throw e;
    }
}
