import EventBus, { EVENTS } from '../core/EventBus.js';
import {
    getSyncState,
    flush,
} from '../services/SyncEngine.js';
import { getMediaSyncStatus } from '../services/SharedMediaSync.js';
import { showToast } from './Toast.js';

const STATUS_META = {
    idle:    { icon: '✅', text: 'Synced',      color: '#0F9D58' },
    syncing: { icon: '🔄', text: 'Syncing…',    color: '#4285F4' },
    offline: { icon: '⚪', text: 'Offline',     color: 'var(--text-muted)' },
    error:   { icon: '⚠️', text: 'Sync error',  color: '#d9534f' },
    paused:  { icon: '⏸️', text: 'Sync paused', color: '#c8662a' },
};

let _dialog = null;

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
    } else if (status === 'idle' && lastSyncAt) {
        label = `Synced · ${_relTime(lastSyncAt)}`;
    }

    pill.textContent = `${icon} ${label}`;
    pill.style.color = color;
}

function _buildDialog() {
    const dlg = document.createElement('div');
    dlg.id = 'sync-panel-dialog';
    dlg.className = 'import-popup-overlay';
    dlg.style.cssText = 'display:flex; position:fixed; inset:0; align-items:center; justify-content:center; z-index:1000;';

    dlg.innerHTML = `
        <div class="import-popup-content" style="max-width:420px; width:90%;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <h3 style="margin:0;">☁️ Sync</h3>
                <button id="sync-panel-close" style="background:none; border:none; font-size:1.2rem; cursor:pointer;">✖</button>
            </div>

            <p style="font-size:0.9rem; margin:0 0 10px;">
                Status: <strong id="sync-panel-status">—</strong>
            </p>
            <p style="font-size:0.8rem; color:var(--text-muted); margin:0 0 14px;">
                Spots, routes, sites, their photos/audio/KML and project data sync
                automatically — on every change, periodically, and when you close
                the app. Externally imported media is never uploaded or shared.
            </p>

            <div class="button-group" style="margin-top:16px; display:flex; gap:8px; flex-wrap:wrap;">
                <button id="sync-now-btn" class="popup-btn" style="flex:1;">🔄 Sync now</button>
                <button id="gc-now-btn" class="popup-btn cancel-btn" style="flex:1;">🧹 Clean up storage</button>
            </div>
        </div>
    `;

    document.body.appendChild(dlg);

    dlg.querySelector('#sync-panel-close').addEventListener('click', () => { dlg.style.display = 'none'; });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.style.display = 'none'; });

    dlg.querySelector('#sync-now-btn').addEventListener('click', async () => {
        await flush('manual');
        showToast('Sync triggered.', 'success');
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
            btn.disabled = false; btn.textContent = '🧹 Clean up storage';
        }
    });

    return dlg;
}

async function _openPanel() {
    if (!_dialog) _dialog = _buildDialog();
    _dialog.style.display = 'flex';

    const st = getSyncState();
    const statusEl = _dialog.querySelector('#sync-panel-status');
    const m = STATUS_META[st.status] || STATUS_META.idle;
    if (statusEl) statusEl.textContent = `${m.icon} ${m.text}`;
}
