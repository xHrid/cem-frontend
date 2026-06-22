import Config from '../core/Config.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import * as MasterData from '../data/MasterData.js';
import { getProjectFolderName } from '../data/projectUtils.js';

function _base() {
    return (Config.server?.baseUrl || '').replace(/\/+$/, '');
}

function _url(path) {
    return _base() + path;
}

async function _fetch(url, opts = {}, timeoutMs = 30000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
        const headers = { 'ngrok-skip-browser-warning': 'true', ...(opts.headers || {}) };
        resp = await fetch(url, { ...opts, headers, signal: ctrl.signal });
    } catch (e) {
        if (e.name === 'AbortError') throw new Error(`Request timed out: ${url}`);
        throw new Error(`Network error reaching server (${e.message}).`);
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

function _projectFolder() {
    const project = MasterData.getActiveProject();
    if (!project) throw new Error('No active project.');
    return getProjectFolderName(project);
}

export async function checkProjectFiles() {
    const name = _projectFolder();
    try {
        return await _json(
            _url(`/api/v1/projects/status?project=${encodeURIComponent(name)}`),
            {},
            15000,
        );
    } catch (e) {
        if (e.message.includes('404')) {
            return {
                spots: {},
                total_audio: 0,
                has_aggregate: false,
                has_processed: false,
            };
        }
        throw e;
    }
}

export async function uploadAudioFiles(spotName, audioFiles, onProgress = () => {}) {
    const name = _projectFolder();

    if (!audioFiles.length) return { uploaded: 0, skipped: 0 };

    const status = await checkProjectFiles();
    const spotInfo = status.spots?.[spotName] || {};
    const existingSet = new Set(spotInfo.audio_files || []);

    const toUpload = audioFiles.filter(f => !existingSet.has(f.name));
    const skipped = audioFiles.length - toUpload.length;

    if (skipped > 0) {
        onProgress(`${skipped} file(s) already on server, skipping.`);
    }

    if (toUpload.length === 0) {
        return { uploaded: 0, skipped };
    }

    const BATCH_SIZE = 50;
    let uploaded = 0;

    for (let i = 0; i < toUpload.length; i += BATCH_SIZE) {
        const batch = toUpload.slice(i, i + BATCH_SIZE);
        onProgress(`Uploading audio ${i + 1}–${Math.min(i + BATCH_SIZE, toUpload.length)} of ${toUpload.length}…`);

        const fd = new FormData();
        fd.append('project', name);
        fd.append('spot', spotName);
        let appended = 0;
        for (const a of batch) {
            const blob = await StorageAdapter.getFileBlob(a.path);
            if (!blob) {
                console.warn(`[ServerUpload] Could not read: ${a.name}`);
                continue;
            }
            fd.append('files', blob, a.name);
            appended++;
        }

        if (appended === 0) continue;

        await _fetch(
            _url('/api/v1/projects/upload/audio'),
            { method: 'POST', body: fd },
            20 * 60 * 1000,
        );
        uploaded += appended;
    }

    return { uploaded, skipped };
}

export async function uploadAggregate(force = false, onProgress = () => {}) {
    const name = _projectFolder();

    if (!force) {
        const status = await checkProjectFiles();
        if (status.has_aggregate) {
            onProgress('Aggregate already on server.');
            return { uploaded: false };
        }
    }

    const serverAggPath = `${name}/system/database/birdnet_results_server.csv`;
    const localAggPath = `${name}/system/database/birdnet_results.csv`;
    let blob = await StorageAdapter.getFileBlob(serverAggPath);
    if (!blob) blob = await StorageAdapter.getFileBlob(localAggPath);

    if (!blob) {
        throw new Error('No aggregate CSV found locally. Run BirdNET first.');
    }

    onProgress('Uploading aggregate.csv…');
    const fd = new FormData();
    fd.append('project', name);
    fd.append('file', blob, 'aggregate.csv');

    await _fetch(
        _url('/api/v1/projects/upload/aggregate'),
        { method: 'POST', body: fd },
        5 * 60 * 1000,
    );

    return { uploaded: true };
}

export async function uploadProcessed(scriptFile, force = false, onProgress = () => {}) {
    const name = _projectFolder();

    if (!force) {
        const status = await checkProjectFiles();
        if (status.has_processed) {
            onProgress('Processed list already on server.');
            return { uploaded: false };
        }
    }

    const serverPath = `${name}/system/database/processed_${scriptFile}_server.txt`;
    const localPath = `${name}/system/database/processed_${scriptFile}.txt`;
    let blob = await StorageAdapter.getFileBlob(serverPath);
    if (!blob) blob = await StorageAdapter.getFileBlob(localPath);

    if (!blob) {
        onProgress('No processed list found locally (first run).');
        return { uploaded: false };
    }

    onProgress('Uploading processed list…');
    const fd = new FormData();
    fd.append('project', name);
    fd.append('file', blob, 'processed_files.txt');

    await _fetch(
        _url('/api/v1/projects/upload/processed'),
        { method: 'POST', body: fd },
        60 * 1000,
    );

    return { uploaded: true };
}

export function getActiveProjectFolder() {
    return _projectFolder();
}
