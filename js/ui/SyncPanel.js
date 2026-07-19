import EventBus, { EVENTS } from '../core/EventBus.js';
import {
    getSyncState,
    syncNow,
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
let _detail = '';

export function initSyncPanel() {
    EventBus.on(EVENTS.SYNC_STATUS, ({ data }) => {
        if (data.status !== 'syncing') _detail = '';
        _renderPill(data.status, data.lastSyncAt);
        _renderDialogStatus();
    });

    EventBus.on(EVENTS.SYNC_PROGRESS, ({ data }) => {
        _detail = data?.detail || '';
        const st = getSyncState();
        _renderPill(st.status, st.lastSyncAt);
        _renderDialogStatus();
    });

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
        _renderDialogStatus();
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

// One honest label for the current state: what is actually happening now, not
// a green tick while uploads are still in flight.
function _statusLabel(status, lastSyncAt) {
    const media = getMediaSyncStatus();
    const mediaBusy = media.pending > 0 || media.active > 0;

    if (status === 'syncing') {
        return { icon: '🔄', label: _detail || 'Syncing…', color: '#4285F4' };
    }
    if (mediaBusy) {
        const n = media.pending + media.active;
        return { icon: '☁️', label: `Uploading ${n} file${n > 1 ? 's' : ''}…`, color: '#4285F4' };
    }
    const m = STATUS_META[status] || STATUS_META.idle;
    if (status === 'idle') {
        return { icon: m.icon, label: lastSyncAt ? `Synced · ${_relTime(lastSyncAt)}` : 'Synced', color: m.color };
    }
    return { icon: m.icon, label: m.text, color: m.color };
}

function _renderPill(status, lastSyncAt) {
    const pill = document.getElementById('btn-sync-pill');
    if (!pill) return;
    const { icon, label, color } = _statusLabel(status, lastSyncAt);
    pill.textContent = `${icon} ${label}`;
    pill.style.color = color;
}

function _renderDialogStatus() {
    if (!_dialog || _dialog.style.display === 'none') return;
    const el = _dialog.querySelector('#sync-panel-status');
    if (!el) return;
    const st = getSyncState();
    const { icon, label } = _statusLabel(st.status, st.lastSyncAt);
    el.textContent = `${icon} ${label}`;
}

function _buildDialog() {
    const dlg = document.createElement('div');
    dlg.id = 'sync-panel-dialog';
    dlg.className = 'import-popup-overlay';
    dlg.style.cssText = 'display:flex; position:fixed; inset:0; align-items:center; justify-content:center; z-index:1000;';

    dlg.innerHTML = `
        <div class="import-popup-content" style="max-width:360px; width:90%;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
                <h3 style="margin:0;">☁️ Sync</h3>
                <button id="sync-panel-close" style="background:none; border:none; font-size:1.2rem; cursor:pointer;">✖</button>
            </div>

            <p style="font-size:0.95rem; margin:0 0 16px;">
                <strong id="sync-panel-status">—</strong>
            </p>

            <div class="button-group" style="display:flex; gap:8px;">
                <button id="sync-now-btn" class="popup-btn" style="flex:1;">🔄 Sync now</button>
                <button id="gc-now-btn" class="popup-btn cancel-btn" style="flex:1;">🧹 Clean up storage</button>
            </div>
        </div>
    `;

    document.body.appendChild(dlg);

    dlg.querySelector('#sync-panel-close').addEventListener('click', () => { dlg.style.display = 'none'; });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.style.display = 'none'; });

    dlg.querySelector('#sync-now-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Syncing…';
        try {
            await syncNow();
            const media = getMediaSyncStatus();
            const pending = media.pending + media.active;
            showToast(
                pending > 0
                    ? `Synced. Uploading ${pending} media file${pending > 1 ? 's' : ''} in the background…`
                    : 'Synced.',
                'success'
            );
        } catch (err) {
            showToast(`Sync failed: ${err.message}`, 'failed');
        } finally {
            btn.disabled = false; btn.textContent = '🔄 Sync now';
            _renderDialogStatus();
        }
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

function _openPanel() {
    if (!_dialog) _dialog = _buildDialog();
    _dialog.style.display = 'flex';
    _renderDialogStatus();
}
