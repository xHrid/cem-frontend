import * as MasterData from '../data/MasterData.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import { enumerateFileRefs } from './ProjectFilesSync.js';
import { getProjectFolderName } from '../data/projectUtils.js';

function _isProtected(p) {
    return p === 'master_data.json' || p === 'watcher.py' || p.startsWith('system/');
}

function _collectReferenced() {
    const state   = MasterData.getLocalState();
    const refs    = new Set();
    const folders = new Set();

    for (const proj of (state.projects || [])) {
        folders.add(getProjectFolderName(proj));

        for (const r of enumerateFileRefs(proj)) {
            if (r.relPath) refs.add(r.relPath);
        }
        for (const f of (proj.external_files || [])) {
            if (f.local_path && !f.is_reference) refs.add(f.local_path);
        }
    }
    return { refs, folders };
}

export async function garbageCollectStorage() {
    const { refs, folders } = _collectReferenced();
    const keys = await StorageAdapter.listAllFileKeys();

    let deleted = 0;
    for (const key of keys) {
        if (_isProtected(key)) continue;
        if (refs.has(key))     continue;

        const topFolder = key.split('/')[0];
        if (folders.has(topFolder) && (key.includes('/jobs/') || key.includes('/system/'))) continue;

        try {
            if (await StorageAdapter.deleteFile(key)) deleted++;
        } catch { }
    }

    if (deleted > 0) ;
    return deleted;
}

function _fmtBytes(n) {
    if (n == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export async function refreshStorageBadge() {
    const el = document.getElementById('folder-status');
    if (!el || /Local Folder/.test(el.textContent)) return;
    try {
        const est = await StorageAdapter.getStorageEstimate();
        if (est.usage != null && est.quota != null) {
            el.textContent = `💾 Browser Storage — ${_fmtBytes(est.usage)} of ${_fmtBytes(est.quota)} used (${est.percent}%)`;
        }
    } catch { }
}

export async function gcAndRefresh() {
    const n = await garbageCollectStorage();
    await refreshStorageBadge();
    return n;
}
