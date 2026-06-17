/**
 * ServerUploadService.js — Project-level file upload to the lab server
 *
 * Decouples file upload from job execution. Files are uploaded ONCE per
 * project and reused across multiple analysis runs. The server creates a
 * project folder (keyed by project folder name) that mirrors the local
 * file structure.
 *
 * File categories:
 *   audio      — WAV/MP3/etc. recordings. Shown as a count, not a full list.
 *   aggregate  — aggregate.csv (BirdNET results).
 *   processed  — processed.csv (already-processed file list).
 *
 * API contract (to be implemented on backend):
 *   GET  /api/v1/projects/{name}/status   → { audio_count, has_aggregate, has_processed, audio_files[] }
 *   POST /api/v1/projects/{name}/upload/audio      → FormData(files[])
 *   POST /api/v1/projects/{name}/upload/aggregate   → FormData(file)
 *   POST /api/v1/projects/{name}/upload/processed   → FormData(file)
 *
 * The server deduplicates audio by filename — uploading the same file
 * again is a no-op (server keeps existing copy).
 *
 * Public exports:
 *   checkProjectFiles   — GET status of uploaded files for a project
 *   uploadAudioFiles    — upload audio files (dedup by name)
 *   uploadAggregate     — upload/replace aggregate.csv
 *   uploadProcessed     — upload/replace processed.csv
 */

import Config from '../core/Config.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import * as MasterData from '../data/MasterData.js';
import { getProjectFolderName } from '../data/projectUtils.js';

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

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
            if (body?.detail) detail += ` — ${typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)}`;
        } catch { /* non-JSON body */ }
        throw new Error(detail);
    }
    return resp;
}

const _json = (url, opts, t) => _fetch(url, opts, t).then(r => r.json());

/**
 * Get the active project's folder name.
 * @returns {string}
 * @throws if no active project
 */
function _projectFolder() {
    const project = MasterData.getActiveProject();
    if (!project) throw new Error('No active project.');
    return getProjectFolderName(project);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check what files already exist on the server for the active project.
 *
 * @returns {Promise<{
 *   audio_count: number,
 *   audio_files: string[],
 *   has_aggregate: boolean,
 *   has_processed: boolean,
 *   aggregate_modified?: string,
 *   processed_modified?: string,
 * }>}
 */
export async function checkProjectFiles() {
    const name = _projectFolder();
    try {
        return await _json(
            _url(`/api/v1/projects/${encodeURIComponent(name)}/status`),
            {},
            15000,
        );
    } catch (e) {
        // 404 = project folder doesn't exist yet — that's fine
        if (e.message.includes('404')) {
            return {
                audio_count: 0,
                audio_files: [],
                has_aggregate: false,
                has_processed: false,
            };
        }
        throw e;
    }
}

/**
 * Upload audio files to the project folder on the server.
 * Server deduplicates by filename — re-uploading is safe (no-op for existing).
 *
 * @param {Array<{path: string, name: string, spot?: string}>} audioFiles
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<{uploaded: number, skipped: number}>}
 */
export async function uploadAudioFiles(audioFiles, onProgress = () => {}) {
    const name = _projectFolder();

    if (!audioFiles.length) return { uploaded: 0, skipped: 0 };

    // Get existing files for dedup
    const status = await checkProjectFiles();
    const existingSet = new Set(status.audio_files || []);

    const toUpload = audioFiles.filter(f => !existingSet.has(f.name));
    const skipped = audioFiles.length - toUpload.length;

    if (skipped > 0) {
        onProgress(`${skipped} file(s) already on server, skipping.`);
    }

    if (toUpload.length === 0) {
        return { uploaded: 0, skipped };
    }

    // Upload in batches to avoid huge single requests
    const BATCH_SIZE = 50;
    let uploaded = 0;

    for (let i = 0; i < toUpload.length; i += BATCH_SIZE) {
        const batch = toUpload.slice(i, i + BATCH_SIZE);
        onProgress(`Uploading audio ${i + 1}–${Math.min(i + BATCH_SIZE, toUpload.length)} of ${toUpload.length}…`);

        const fd = new FormData();
        for (const a of batch) {
            const blob = await StorageAdapter.getFileBlob(a.path);
            if (!blob) {
                console.warn(`[ServerUpload] Could not read: ${a.name}`);
                continue;
            }
            fd.append('files', blob, a.name);
        }

        // Include spot mapping metadata
        const spotMap = {};
        batch.forEach(a => { if (a.spot) spotMap[a.name] = a.spot; });
        if (Object.keys(spotMap).length) {
            fd.append('audio_spots', JSON.stringify(spotMap));
        }

        await _fetch(
            _url(`/api/v1/projects/${encodeURIComponent(name)}/upload/audio`),
            { method: 'POST', body: fd },
            20 * 60 * 1000,
        );
        uploaded += batch.length;
    }

    return { uploaded, skipped };
}

/**
 * Upload (or replace) the aggregate CSV for the project.
 *
 * Prefers the server-specific aggregate; falls back to local.
 *
 * @param {boolean} [force=false]  If true, overrides even if server has one.
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<{uploaded: boolean}>}
 */
export async function uploadAggregate(force = false, onProgress = () => {}) {
    const projectFolder = _projectFolder();
    const name = projectFolder;

    if (!force) {
        const status = await checkProjectFiles();
        if (status.has_aggregate) {
            onProgress('Aggregate already on server.');
            return { uploaded: false };
        }
    }

    // Prefer server-specific aggregate, fall back to local
    const serverAggPath = `${projectFolder}/system/database/birdnet_results_server.csv`;
    const localAggPath = `${projectFolder}/system/database/birdnet_results.csv`;
    let blob = await StorageAdapter.getFileBlob(serverAggPath);
    if (!blob) blob = await StorageAdapter.getFileBlob(localAggPath);

    if (!blob) {
        throw new Error('No aggregate CSV found locally. Run BirdNET first.');
    }

    onProgress('Uploading aggregate.csv…');
    const fd = new FormData();
    fd.append('file', blob, 'aggregate.csv');

    await _fetch(
        _url(`/api/v1/projects/${encodeURIComponent(name)}/upload/aggregate`),
        { method: 'POST', body: fd },
        5 * 60 * 1000,
    );

    return { uploaded: true };
}

/**
 * Upload (or replace) the processed file list for the project.
 *
 * @param {string} scriptFile  e.g. "birdnet_predictions.py"
 * @param {boolean} [force=false]
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<{uploaded: boolean}>}
 */
export async function uploadProcessed(scriptFile, force = false, onProgress = () => {}) {
    const projectFolder = _projectFolder();
    const name = projectFolder;

    if (!force) {
        const status = await checkProjectFiles();
        if (status.has_processed) {
            onProgress('Processed list already on server.');
            return { uploaded: false };
        }
    }

    const serverPath = `${projectFolder}/system/database/processed_${scriptFile}_server.txt`;
    const localPath = `${projectFolder}/system/database/processed_${scriptFile}.txt`;
    let blob = await StorageAdapter.getFileBlob(serverPath);
    if (!blob) blob = await StorageAdapter.getFileBlob(localPath);

    if (!blob) {
        // No processed list yet — that's OK for first run
        onProgress('No processed list found locally (first run).');
        return { uploaded: false };
    }

    onProgress('Uploading processed list…');
    const fd = new FormData();
    fd.append('file', blob, 'processed_files.txt');

    await _fetch(
        _url(`/api/v1/projects/${encodeURIComponent(name)}/upload/processed`),
        { method: 'POST', body: fd },
        60 * 1000,
    );

    return { uploaded: true };
}

/**
 * Convenience: get the active project folder name (for external callers).
 * @returns {string}
 */
export function getActiveProjectFolder() {
    return _projectFolder();
}
