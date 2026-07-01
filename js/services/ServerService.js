import Config                    from '../core/Config.js';
import EventBus, { EVENTS }      from '../core/EventBus.js';
import * as StorageAdapter       from '../data/StorageAdapter.js';
import * as MasterData           from '../data/MasterData.js';
import { getProjectFolderName }  from '../data/projectUtils.js';
import { buildJobData }          from './AnalysisService.js';
import { uploadSelectedAudio }   from './ServerUploadService.js';
import { authHeaders }           from './AuthService.js';

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

async function _fetch(url, opts = {}, timeoutMs = 30000) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
        const headers = { 'ngrok-skip-browser-warning': 'true', ...authHeaders(), ...(opts.headers || {}) };
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
        } catch { }
        throw new Error(detail);
    }
    return resp;
}

const _json = (url, opts, t) => _fetch(url, opts, t).then(r => r.json());

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

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function _pollAirflow(poll, onProgress) {
    const POLL_MS = poll.interval_ms || 5000;
    const MAX_MS  = 60 * 60 * 1000;
    const start   = Date.now();
    const pollUrl = poll.path ? _url(poll.path) : poll.url;

    while (Date.now() - start < MAX_MS) {
        await _sleep(POLL_MS);
        let state = '';
        try {
            const data = await _json(pollUrl, {}, 10000);
            state = (data.state || '').toLowerCase();
        } catch (e) {
            onProgress('Waiting for Airflow…');
            continue;
        }
        if (state === 'success' || state === 'failed') return state;
        onProgress(`Airflow: ${state || 'running'}…`);
    }
    throw new Error('Timed out waiting for Airflow (1 hour).');
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
    } catch { }
    const merged = Array.from(new Set([...existing, ...names]));
    const blob   = new Blob([merged.join('\n') + '\n'], { type: 'text/plain' });
    await StorageAdapter.saveFile(blob, fileName, [projectFolder, 'system', 'database']);
}

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
        mode:       'server',
        status:     'processing',
        created_at: new Date().toISOString(),
        server: { base_url: _base(), job_id: jobId, task_id: null },
    };

    await _writeJobRecord(projectFolder, jobId, record, 'processing');
    EventBus.emit(EVENTS.DATA_UPDATED, null);

    try {
        onProgress('Uploading required audio…');
        await uploadSelectedAudio(
            {
                spotIds, startDate, endDate,
                validExts: currentScript.inputs?.[0]?.valid_extensions,
                spots, externalFiles,
            },
            onProgress,
        );

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

        onProgress('Running analysis on server…');
        let taskId = null;

        const dispatchCtrl  = new AbortController();
        const dispatchTimer = setTimeout(() => dispatchCtrl.abort(), 60 * 60 * 1000);
        let resp, result;
        try {
            resp = await fetch(_url('/api/v1/analyze'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true', ...authHeaders() },
                body: JSON.stringify(runBody),
                signal: dispatchCtrl.signal,
            });
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('Analysis request timed out (1 h).');
            throw new Error(`Network error reaching server: ${e.message}`);
        } finally {
            clearTimeout(dispatchTimer);
        }
        result = await resp.json().catch(() => ({}));

        const _failJob = async (message, tid) => {
            let logText = '';
            if (tid) {
                try {
                    const logResp = await _fetch(
                        _url(`/api/v1/jobs/${jobId}/tasks/${tid}/log`), {}, 10000);
                    logText = await logResp.text();
                } catch { }
            }
            record.status      = 'failed';
            record.error       = message;
            if (logText) record.run_log = logText;
            record.finished_at = new Date().toISOString();
            await _moveJobRecord(projectFolder, jobId, record, 'processing', 'failed');
            EventBus.emit(EVENTS.DATA_UPDATED, null);
            throw new Error(message);
        };

        if (result.status === 'queued') {
            record.mode = 'airflow';
            record.server.dag_run_id = result.dag_run_id || null;
            await _writeJobRecord(projectFolder, jobId, record, 'processing');

            if (!result.poll?.path && !result.poll?.url) {
                await _failJob('Server did not return Airflow polling info.', null);
            }

            onProgress('Pipeline triggered — polling Airflow…');
            const airflowState = await _pollAirflow(result.poll, onProgress);

            let jobData = {};
            try { jobData = await _json(_url(`/api/v1/jobs/${jobId}`), {}, 10000); }
            catch { }
            const task = (jobData.tasks || []).slice(-1)[0] || null;
            taskId = task?.task_id || null;
            record.server.task_id = taskId;

            if (airflowState === 'failed' || task?.status === 'failed') {
                await _failJob(
                    task?.error || jobData.status_detail?.message ||
                        'Pipeline failed (Airflow reported failure).',
                    taskId);
            }
        } else {
            taskId = result.task_id || null;
            record.server.task_id = taskId;
            await _writeJobRecord(projectFolder, jobId, record, 'processing');

            if (!resp.ok || result.status === 'skipped' || result.status === 'failed') {
                await _failJob(
                    result.message || result.detail || `Server returned ${resp.status}`,
                    taskId);
            }
        }

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
        } catch { }
        throw e;
    }
}
