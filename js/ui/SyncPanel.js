/**
 * SyncPanel.js — Minimal sync UI: a status pill + a small control panel
 *
 * Replaces the three old buttons ("Check Remote Updates", "Media Sync",
 * per-project "Sync") and the heavy SyncDashboard. Everything syncs
 * automatically via SyncEngine; this UI only:
 *
 *   1. Shows a live status pill (Synced / Syncing / Offline / Error).
 *   2. Offers a "Sync now" button to force an immediate flush.
 *
 * External/imported media is never uploaded or shared, so there is no media
 * toggle or manual push control here anymore.
 *
 * The pill button (#btn-sync-pill) is rendered by App.js into the auth panel;
 * we wire it via event delegation so initialisation order does not matter.
 */

import EventBus, { EVENTS } from '../core/EventBus.js';
import {
    getSyncState,
    flush,
} from '../services/SyncEngine.js';
import { showToast } from './Toast.js';

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

const STATUS_META = {
    idle:    { icon: '✅', text: 'Synced',      color: '#0F9D58' },
    syncing: { icon: '🔄', text: 'Syncing…',    color: '#4285F4' },
    offline: { icon: '⚪', text: 'Offline',     color: 'var(--text-muted)' },
    error:   { icon: '⚠️', text: 'Sync error',  color: '#d9534f' },
    paused:  { icon: '⏸️', text: 'Sync paused', color: '#c8662a' },
};

/** @type {HTMLElement|null} */
let _dialog = null;

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

export function initSyncPanel() {
    // Keep the pill in sync with engine status.
    EventBus.on(EVENTS.SYNC_STATUS, ({ data }) => _renderPill(data.status, data.lastSyncAt));

    // Delegated click — works regardless of when the pill is injected.
    document.addEventListener('click', (e) => {
        if (e.target.closest?.('#btn-sync-pill')) _openPanel();
    });

    // Refresh the relative "X ago" label on a slow tick (not a live clock).
    setInterval(() => {
        const st = getSyncState();
        if (st.status === 'idle') _renderPill(st.status, st.lastSyncAt);
    }, 30 * 1000);

    const st = getSyncState();
    _renderPill(st.status, st.lastSyncAt);
}

// ---------------------------------------------------------------------------
// Pill
// ---------------------------------------------------------------------------

/**
 * Coarse relative time, e.g. "just now", "3m ago", "2h ago". Avoids a ticking
 * clock — granularity is minutes/hours.
 * @param {number|null} ts  epoch ms
 * @returns {string}
 */
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
    const m = STATUS_META[status] || STATUS_META.idle;
    let label = m.text;
    if (status === 'idle' && lastSyncAt) label = `Synced · ${_relTime(lastSyncAt)}`;
    pill.textContent = `${m.icon} ${label}`;
    pill.style.color = m.color;
}

// ---------------------------------------------------------------------------
// Panel dialog
// ---------------------------------------------------------------------------

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

    // Force an immediate JSON/contribution flush
    dlg.querySelector('#sync-now-btn').addEventListener('click', async () => {
        await flush('manual');
        showToast('Sync triggered.', 'success');
    });

    // Reclaim dead local files (orphaned media / discarded projects).
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

    // Reflect current state
    const st = getSyncState();
    const statusEl = _dialog.querySelector('#sync-panel-status');
    const m = STATUS_META[st.status] || STATUS_META.idle;
    if (statusEl) statusEl.textContent = `${m.icon} ${m.text}`;
}
