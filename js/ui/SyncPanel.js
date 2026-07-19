import EventBus, { EVENTS } from '../core/EventBus.js';
import {
    getSyncState,
    flush,
} from '../services/SyncEngine.js';
import {
    getMediaSyncStatus,
    getProjectSyncReport,
    resyncProject,
    repairDriveIds,
    enqueueMedia,
} from '../services/SharedMediaSync.js';
import * as MasterData from '../data/MasterData.js';
import { showToast } from './Toast.js';

const STATUS_META = {
    idle:    { icon: '✅', text: 'Synced',      color: '#0F9D58' },
    syncing: { icon: '🔄', text: 'Syncing…',    color: '#4285F4' },
    offline: { icon: '⚪', text: 'Offline',     color: 'var(--text-muted)' },
    error:   { icon: '⚠️', text: 'Sync error',  color: '#d9534f' },
    paused:  { icon: '⏸️', text: 'Sync paused', color: '#c8662a' },
};

const FILE_META = {
    synced:   { label: 'Synced',     color: '#0F9D58', icon: '✅' },
    id_drift: { label: 'ID drift',   color: '#c8662a', icon: '🔧' },
    stale:    { label: 'Stale',      color: '#d9534f', icon: '♻️' },
    unsynced: { label: 'Not synced', color: '#4285F4', icon: '☁️' },
    missing:  { label: 'Missing',    color: '#b00020', icon: '⛔' },
    unknown:  { label: 'Unknown',    color: 'var(--text-muted)', icon: '❓' },
};

const PROBLEM = new Set(['id_drift', 'stale', 'unsynced', 'missing']);

let _dialog = null;
let _filter = 'problems';
let _problemCount = 0;

export function initSyncPanel() {
    EventBus.on(EVENTS.SYNC_STATUS, ({ data }) => _renderPill(data.status, data.lastSyncAt));

    let _mediaPillTimer = null;
    EventBus.on(EVENTS.MEDIA_SAVED, () => {
        clearTimeout(_mediaPillTimer);
        _mediaPillTimer = setTimeout(() => {
            const st = getSyncState();
            _renderPill(st.status, st.lastSyncAt);
        }, 500);
    });
    EventBus.on(EVENTS.SYNC_BATCH_COMPLETE, () => {
        const st = getSyncState();
        _renderPill(st.status, st.lastSyncAt);
        if (_dialog && _dialog.style.display !== 'none') _refresh();
    });

    document.addEventListener('click', (e) => {
        if (e.target.closest?.('#btn-sync-pill')) _openPanel();
    });

    setInterval(() => {
        const st = getSyncState();
        _renderPill(st.status, st.lastSyncAt);
    }, 5 * 1000);

    const st = getSyncState();
    _renderPill(st.status, st.lastSyncAt);
}

function _relTime(ts) {
    if (!ts) return '';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 45)   return 'just now';
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}

function _renderPill(status, lastSyncAt) {
    const pill = document.getElementById('btn-sync-pill');
    if (!pill) return;

    const media = getMediaSyncStatus();
    const mediaBusy = media.pending > 0 || media.active > 0;

    const m = STATUS_META[status] || STATUS_META.idle;
    let label = m.text;
    let color = m.color;
    let icon  = m.icon;

    if (status === 'idle' && mediaBusy) {
        icon  = '☁️';
        label = `Uploading ${media.pending + media.active} file${(media.pending + media.active) > 1 ? 's' : ''}…`;
        color = '#4285F4';
    } else if (status === 'idle' && _problemCount > 0) {
        icon  = '⚠️';
        label = `${_problemCount} file${_problemCount > 1 ? 's' : ''} need sync`;
        color = '#c8662a';
    } else if (status === 'idle' && lastSyncAt) {
        label = `Synced · ${_relTime(lastSyncAt)}`;
    }

    pill.textContent = `${icon} ${label}`;
    pill.style.color = color;
}

function _chip(label, n, color) {
    return `<span style="display:inline-flex; gap:5px; align-items:center; padding:3px 9px; border-radius:12px;
        background:var(--surface-2, #f2f2f2); font-size:0.78rem; margin:0 6px 6px 0;">
        <b style="color:${color};">${n}</b> ${label}</span>`;
}

function _rowHtml(r) {
    const meta = FILE_META[r.status] || FILE_META.unknown;
    const local = r.local ? '✓' : '✗';
    const drive = r.status === 'unknown' ? '?' : (r.onDrive ? '✓' : '✗');
    let action = '';
    if (r.status === 'unsynced' || r.status === 'stale') {
        action = `<button class="sync-row-btn" data-act="sync" data-rel="${encodeURIComponent(r.relPath)}"
            style="font-size:0.72rem; padding:3px 9px; border:none; border-radius:5px; background:#4285F4; color:#fff; cursor:pointer;">Sync</button>`;
    } else if (r.status === 'id_drift') {
        action = `<button class="sync-row-btn" data-act="repair"
            style="font-size:0.72rem; padding:3px 9px; border:none; border-radius:5px; background:#c8662a; color:#fff; cursor:pointer;">Repair</button>`;
    } else if (r.status === 'missing') {
        action = `<span title="No local copy and not on Drive - re-import it or ask the project owner to re-sync"
            style="font-size:0.72rem; color:var(--text-muted); cursor:help;">unrecoverable</span>`;
    }
    return `<tr style="border-bottom:1px solid var(--border-color, #eee);">
        <td style="padding:5px 6px; max-width:190px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${r.relPath}">${r.name}</td>
        <td style="padding:5px 6px; color:var(--text-muted); font-size:0.78rem;">${r.context || r.kind}</td>
        <td style="padding:5px 6px; text-align:center;">${local}</td>
        <td style="padding:5px 6px; text-align:center;">${drive}</td>
        <td style="padding:5px 6px; white-space:nowrap;"><span style="color:${meta.color};">${meta.icon} ${meta.label}</span></td>
        <td style="padding:5px 6px; text-align:right;">${action}</td>
    </tr>`;
}

function _buildDialog() {
    const dlg = document.createElement('div');
    dlg.id = 'sync-panel-dialog';
    dlg.className = 'import-popup-overlay';
    dlg.style.cssText = 'display:flex; position:fixed; inset:0; align-items:center; justify-content:center; z-index:1000;';

    dlg.innerHTML = `
        <div class="import-popup-content" style="max-width:720px; width:94%; max-height:86vh; display:flex; flex-direction:column;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <h3 style="margin:0;">☁️ Sync dashboard</h3>
                <button id="sync-panel-close" style="background:none; border:none; font-size:1.2rem; cursor:pointer;">✖</button>
            </div>

            <div id="sync-chips" style="margin-bottom:8px;"></div>

            <div style="display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap; align-items:center;">
                <div class="sync-filter-tabs" style="display:flex; gap:4px;">
                    <button class="sync-filter" data-f="problems" style="font-size:0.76rem; padding:3px 10px; border-radius:6px; border:1px solid var(--border-color,#ddd); background:none; cursor:pointer;">Problems</button>
                    <button class="sync-filter" data-f="all" style="font-size:0.76rem; padding:3px 10px; border-radius:6px; border:1px solid var(--border-color,#ddd); background:none; cursor:pointer;">All</button>
                    <button class="sync-filter" data-f="missing" style="font-size:0.76rem; padding:3px 10px; border-radius:6px; border:1px solid var(--border-color,#ddd); background:none; cursor:pointer;">Missing</button>
                </div>
                <span style="flex:1;"></span>
                <button id="sync-refresh" class="popup-btn" style="font-size:0.76rem; padding:4px 10px;">↻ Refresh</button>
            </div>

            <div id="sync-table-wrap" style="overflow:auto; flex:1; min-height:120px; border:1px solid var(--border-color,#eee); border-radius:6px;">
                <p style="padding:20px; text-align:center; color:var(--text-muted);">Loading…</p>
            </div>

            <div class="button-group" style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
                <button id="sync-all-btn" class="popup-btn" style="flex:1; min-width:130px;">☁️ Sync all fixable</button>
                <button id="repair-ids-btn" class="popup-btn" style="flex:1; min-width:110px;">🔧 Repair IDs</button>
                <button id="sync-now-btn" class="popup-btn cancel-btn" style="flex:1; min-width:100px;">🔄 Sync now</button>
                <button id="gc-now-btn" class="popup-btn cancel-btn" style="flex:1; min-width:110px;">🧹 Clean up</button>
            </div>
        </div>
    `;

    document.body.appendChild(dlg);

    dlg.querySelector('#sync-panel-close').addEventListener('click', () => { dlg.style.display = 'none'; });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.style.display = 'none'; });

    dlg.querySelectorAll('.sync-filter').forEach(btn => {
        btn.addEventListener('click', () => { _filter = btn.dataset.f; _refresh(); });
    });

    dlg.querySelector('#sync-refresh').addEventListener('click', () => _refresh());

    dlg.querySelector('#sync-table-wrap').addEventListener('click', async (e) => {
        const btn = e.target.closest('.sync-row-btn');
        if (!btn) return;
        const project = MasterData.getActiveProject();
        if (!project) return;
        btn.disabled = true;
        try {
            if (btn.dataset.act === 'sync') {
                enqueueMedia(project.id, [decodeURIComponent(btn.dataset.rel)]);
                showToast('Queued for upload.', 'success');
            } else if (btn.dataset.act === 'repair') {
                await repairDriveIds(project.id);
                showToast('Drive IDs repaired.', 'success');
            }
        } catch (err) {
            showToast(`Failed: ${err.message}`, 'failed');
        }
        setTimeout(() => _refresh(), 800);
    });

    dlg.querySelector('#sync-all-btn').addEventListener('click', async (e) => {
        const project = MasterData.getActiveProject();
        if (!project) return;
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Working…';
        try {
            const r = await resyncProject(project.id);
            showToast(`Repaired ${r.healed}, queued ${r.enqueued} for upload.`, 'success');
        } catch (err) {
            showToast(`Failed: ${err.message}`, 'failed');
        } finally {
            btn.disabled = false; btn.textContent = '☁️ Sync all fixable';
            _refresh();
        }
    });

    dlg.querySelector('#repair-ids-btn').addEventListener('click', async (e) => {
        const project = MasterData.getActiveProject();
        if (!project) return;
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Working…';
        try {
            const r = await repairDriveIds(project.id);
            showToast(`Repaired ${r.healed} ID(s), cleared ${r.cleared} dead.`, 'success');
        } catch (err) {
            showToast(`Failed: ${err.message}`, 'failed');
        } finally {
            btn.disabled = false; btn.textContent = '🔧 Repair IDs';
            _refresh();
        }
    });

    dlg.querySelector('#sync-now-btn').addEventListener('click', async () => {
        await flush('manual');
        showToast('Sync triggered.', 'success');
        setTimeout(() => _refresh(), 800);
    });

    dlg.querySelector('#gc-now-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Cleaning…';
        try {
            const { gcAndRefresh } = await import('../services/StorageGC.js');
            const n = await gcAndRefresh();
            showToast(n > 0 ? `Cleaned ${n} unused file(s).` : 'Storage already clean.', 'success');
        } catch (err) {
            showToast(`Cleanup failed: ${err.message}`, 'failed');
        } finally {
            btn.disabled = false; btn.textContent = '🧹 Clean up';
        }
    });

    return dlg;
}

async function _refresh() {
    if (!_dialog) return;
    const wrap = _dialog.querySelector('#sync-table-wrap');
    const chips = _dialog.querySelector('#sync-chips');

    _dialog.querySelectorAll('.sync-filter').forEach(b => {
        b.style.background = b.dataset.f === _filter ? 'var(--forest, #2e7d32)' : 'none';
        b.style.color = b.dataset.f === _filter ? '#fff' : '';
    });

    const project = MasterData.getActiveProject();
    if (!project) { wrap.innerHTML = `<p style="padding:20px; text-align:center; color:var(--text-muted);">No active project.</p>`; return; }

    let report;
    try {
        report = await getProjectSyncReport(project.id);
    } catch (err) {
        wrap.innerHTML = `<p style="padding:20px; text-align:center; color:#d9534f;">Could not read sync state: ${err.message}</p>`;
        return;
    }
    if (!report) { wrap.innerHTML = `<p style="padding:20px; text-align:center; color:var(--text-muted);">No media in this project.</p>`; return; }

    const c = report.counts;
    _problemCount = c.id_drift + c.stale + c.unsynced + c.missing;
    const media = getMediaSyncStatus();

    if (!report.driveOk) {
        chips.innerHTML = `<span style="color:#c8662a; font-size:0.82rem;">⚠️ Drive not reachable - connect/log in to verify sync state.</span>`;
    } else {
        chips.innerHTML =
            _chip('Synced', c.synced, '#0F9D58') +
            (media.pending + media.active > 0 ? _chip('Uploading', media.pending + media.active, '#4285F4') : '') +
            _chip('Not synced', c.unsynced, '#4285F4') +
            _chip('Stale', c.stale, '#d9534f') +
            _chip('ID drift', c.id_drift, '#c8662a') +
            _chip('Missing', c.missing, '#b00020');
    }

    let rows = report.rows;
    if (_filter === 'problems') rows = rows.filter(r => PROBLEM.has(r.status));
    else if (_filter === 'missing') rows = rows.filter(r => r.status === 'missing');

    if (rows.length === 0) {
        wrap.innerHTML = `<p style="padding:20px; text-align:center; color:var(--text-muted);">Nothing here ${_filter === 'problems' ? '- everything is synced 🎉' : ''}</p>`;
        return;
    }

    rows.sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name));

    wrap.innerHTML = `
        <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
            <thead><tr style="position:sticky; top:0; background:var(--surface-2,#f7f7f7);">
                <th style="padding:6px; text-align:left;">File</th>
                <th style="padding:6px; text-align:left;">Where</th>
                <th style="padding:6px;">Local</th>
                <th style="padding:6px;">Drive</th>
                <th style="padding:6px; text-align:left;">Status</th>
                <th style="padding:6px;"></th>
            </tr></thead>
            <tbody>${rows.map(_rowHtml).join('')}</tbody>
        </table>`;
}

async function _openPanel() {
    if (!_dialog) _dialog = _buildDialog();
    _dialog.style.display = 'flex';
    await _refresh();
}
