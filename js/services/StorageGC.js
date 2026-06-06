/**
 * StorageGC.js — Storage garbage collector
 *
 * Why this exists
 * ---------------
 * Over time local storage accumulates files no project references anymore:
 *  - When a sync conflict is resolved "Drive wins", local projects are replaced
 *    by Drive copies with NEW ids → the old projects' whole folders are orphaned.
 *  - Deleting a spot/route/site/project leaves its media behind.
 *  - Switching Google accounts and pulling a fresh state strands the previous
 *    account's media.
 * These dead bytes inflate the storage estimate (e.g. "315 MB used") and can
 * eventually exhaust the mobile quota. This module sweeps them.
 *
 * Safety: it KEEPS anything that is (a) protected system data, (b) referenced by
 * any current project, or (c) a job artifact of a current project. Everything
 * else — orphaned project folders, unreferenced media — is deleted. It never
 * touches Drive; purely local cleanup. Works for both IndexedDB and native FS.
 */

import * as MasterData from '../data/MasterData.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import { enumerateFileRefs } from './ProjectFilesSync.js';
import { getProjectFolderName } from '../data/projectUtils.js';

/** Paths that must never be swept. */
function _isProtected(p) {
    return p === 'master_data.json' || p === 'watcher.py' || p.startsWith('system/');
}

/**
 * Build the set of paths that are still in use, plus the set of current project
 * folder names (so we can preserve their job artifacts).
 *
 * @returns {{ refs: Set<string>, folders: Set<string> }}
 */
function _collectReferenced() {
    const state   = MasterData.getLocalState();
    const refs    = new Set();
    const folders = new Set();

    for (const proj of (state.projects || [])) {
        folders.add(getProjectFolderName(proj));

        // Media referenced by spots / sites / route annotations / jobs.
        for (const r of enumerateFileRefs(proj)) {
            if (r.relPath) refs.add(r.relPath);
        }
        // Locally-copied external files (references store no local copy).
        for (const f of (proj.external_files || [])) {
            if (f.local_path && !f.is_reference) refs.add(f.local_path);
        }
    }
    return { refs, folders };
}

/**
 * Sweep dead files. Returns the number deleted.
 *
 * @returns {Promise<number>}
 */
export async function garbageCollectStorage() {
    const { refs, folders } = _collectReferenced();
    const keys = await StorageAdapter.listAllFileKeys();

    let deleted = 0;
    for (const key of keys) {
        if (_isProtected(key)) continue;
        if (refs.has(key))     continue;

        // Preserve job JSON/result artifacts of CURRENT projects — they aren't
        // all individually tracked on the project record.
        const topFolder = key.split('/')[0];
        if (folders.has(topFolder) && key.includes('/jobs/')) continue;

        try {
            if (await StorageAdapter.deleteFile(key)) deleted++;
        } catch { /* ignore individual failures */ }
    }

    if (deleted > 0) console.log(`[StorageGC] Reclaimed ${deleted} dead file(s).`);
    return deleted;
}

/** Human-readable byte size. */
function _fmtBytes(n) {
    if (n == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/**
 * Refresh the browser-storage usage badge (#folder-status) after a sweep, so
 * the freed space shows immediately instead of a stale "315 MB used".
 */
export async function refreshStorageBadge() {
    const el = document.getElementById('folder-status');
    if (!el || /Local Folder/.test(el.textContent)) return; // native folder: no quota meter
    try {
        const est = await StorageAdapter.getStorageEstimate();
        if (est.usage != null && est.quota != null) {
            el.textContent = `💾 Browser Storage — ${_fmtBytes(est.usage)} of ${_fmtBytes(est.quota)} used (${est.percent}%)`;
        }
    } catch { /* ignore */ }
}

/** Sweep, then refresh the badge. Convenience for callers. */
export async function gcAndRefresh() {
    const n = await garbageCollectStorage();
    await refreshStorageBadge();
    return n;
}
