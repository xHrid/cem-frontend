import Config from '../core/Config.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import * as MasterData from '../data/MasterData.js';
import { getProjectFolderName } from '../data/projectUtils.js';
import { authHeaders } from './AuthService.js';

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
        const headers = { 'ngrok-skip-browser-warning': 'true', ...authHeaders(), ...(opts.headers || {}) };
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

export async function checkFilesForUpload(filesBySpot) {
    const name = _projectFolder();
    const resp = await _json(
        _url('/api/v1/projects/check-files'),
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: name, files: filesBySpot }),
        },
        30000,
    );
    return resp.to_upload || {};
}

// Upload only the raw audio the requested run needs: files in the selected
// spots and date range that the server doesn't already have. The server
// computes any downstream dependencies itself, so nothing else is uploaded.
export async function uploadSelectedAudio(
    { spotIds, startDate, endDate, validExts, spots, externalFiles },
    onProgress = () => {},
) {
    const name = _projectFolder();

    const startVal = startDate ? parseInt(startDate.replace(/-/g, ''), 10) : null;
    const endVal   = endDate ? parseInt(endDate.replace(/-/g, ''), 10) : null;
    const extList  = (validExts && validExts.length ? validExts : ['.wav'])
        .map(e => e.replace('.', '')).join('|');
    const extRegex = new RegExp(`\\.(${extList})$`, 'i');
    const spotIdSet = new Set(spotIds);

    const filesBySpot = {};
    const fileMap = {};
    const add = (spotKey, fname, path) => {
        if (!filesBySpot[spotKey]) { filesBySpot[spotKey] = []; fileMap[spotKey] = []; }
        if (!filesBySpot[spotKey].includes(fname)) {
            filesBySpot[spotKey].push(fname);
            fileMap[spotKey].push({ name: fname, path });
        }
    };
    const inRange = (fname) => {
        const m = fname.match(/_(\d{8})_/);
        if (!m) return true;
        const d = parseInt(m[1], 10);
        if (startVal && d < startVal) return false;
        if (endVal && d > endVal) return false;
        return true;
    };

    for (const spotId of spotIds) {
        const spot = spots.find(s => s.spotId === spotId);
        if (!spot) continue;
        const spotKey = spot.name.replace(/\s+/g, '').toUpperCase();
        if (spot.audio_local_filename) {
            const fname = spot.audio_local_filename.split('/').pop();
            if (extRegex.test(fname) && inRange(fname)) {
                add(spotKey, fname, spot.audio_local_filename);
            }
        }
    }

    for (const ef of externalFiles) {
        if (!extRegex.test(ef.name) || !inRange(ef.name) || !ef.local_path) continue;
        const linked = (ef.linked_spots || []).filter(id => spotIdSet.has(id));
        for (const spotId of linked) {
            const spot = spots.find(s => s.spotId === spotId);
            if (!spot) continue;
            add(spot.name.replace(/\s+/g, '').toUpperCase(), ef.name, ef.local_path);
        }
    }

    const totalBefore = Object.values(filesBySpot).reduce((s, a) => s + a.length, 0);
    if (totalBefore === 0) return { uploaded: 0, skipped: 0, total: 0 };

    onProgress(`Checking ${totalBefore} file(s) against server…`);
    const toUpload = await checkFilesForUpload(filesBySpot);
    const totalNeeded = Object.values(toUpload).reduce((s, a) => s + a.length, 0);
    const skipped = totalBefore - totalNeeded;
    if (totalNeeded === 0) return { uploaded: 0, skipped, total: totalBefore };

    let uploaded = 0;
    const BATCH_SIZE = 50;

    for (const [spotKey, neededNames] of Object.entries(toUpload)) {
        const neededSet = new Set(neededNames);
        const filesToSend = (fileMap[spotKey] || []).filter(f => neededSet.has(f.name));

        for (let i = 0; i < filesToSend.length; i += BATCH_SIZE) {
            const batch = filesToSend.slice(i, i + BATCH_SIZE);
            const pct = Math.round((uploaded / totalNeeded) * 100);
            onProgress(`Uploading ${spotKey}: ${Math.min(uploaded + batch.length, totalNeeded)} of ${totalNeeded}…`, pct);

            const fd = new FormData();
            fd.append('project', name);
            fd.append('spot', spotKey);
            let appended = 0;
            for (const f of batch) {
                const blob = await StorageAdapter.getFileBlob(f.path);
                if (!blob) continue;
                fd.append('files', blob, f.name);
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
    }

    onProgress(`Uploaded ${uploaded} file(s), ${skipped} already on server.`, 100);
    return { uploaded, skipped, total: totalBefore };
}

export function getActiveProjectFolder() {
    return _projectFolder();
}
