/**
 * SyncPanel.js — Minimal sync UI: a status pill + a small control panel
 *
 * Replaces the three old buttons ("Check Remote Updates", "Media Sync",
 * per-project "Sync") and the heavy SyncDashboard. Everything syncs
 * automatically via SyncEngine; this UI only:
 *
 *   1. Shows a live status pill (Synced / Syncing / Offline / Error).
 *   2. Exposes the ONE user control: the global "sync imported media" toggle.
 *   3. Offers a manual "Push imported media now" action (for when the toggle
 *      is off but the user wants to upload the heavy external files on demand),
 *      plus a "Sync now" button to force an immediate flush.
 *
 * The pill button (#btn-sync-pill) is rendered by App.js into the auth panel;
 * we wire it via event delegation so initialisation order does not matter.
 */

import EventBus, { EVENTS } from '../core/EventBus.js';
import {
    getSyncState,
    isImportedMediaSyncEnabled,
    setImportedMediaSync,
    flush,
} from '../services/SyncEngine.js';
import { generateSyncReport, syncBatch } from '../services/SyncService.js';
import { getLocalState } from '../data/MasterData.js';
import { showToast } from './Toast.js';

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

const STATUS_META = {
    idle:    { icon: '✅', text: 'Synced',      color: '#0F9D58' },
    syncing: { icon: '🔄', text: 'Syncing…',    color: '#4285F4' },
    offline: { icon: '⚪', text: 'Offline',     color: 'var(--text-muted)' },
    error:   { icon: '⚠️', text: 'Sync error',  color: '#d9534f' },
};

/** @type {HTMLElement|null} */
let _dialog = null;

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

export function initSyncPanel() {
    // Keep the pill in sync with engine status.
    EventBus.on(EVENTS.SYNC_STATUS, ({ data }) => _renderPill(data.status));

    // Delegated click — works regardless of when the pill is injected.
    document.addEventListener('click', (e) => {
        if (e.target.closest?.('#btn-sync-pill')) _openPanel();
    });

    _renderPill(getSyncState().status);
}

// ---------------------------------------------------------------------------
// Pill
// ---------------------------------------------------------------------------

function _renderPill(status) {
    const pill = document.getElementById('btn-sync-pill');
    if (!pill) return;
    const m = STATUS_META[status] || STATUS_META.idle;
    pill.textContent = `${m.icon} ${m.text}`;
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
                Spots, routes, sites and project data sync automatically — on every
                change, periodically, and when you close the app.
            </p>

            <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:0.9rem; margin-bottom:6px;">
                <input type="checkbox" id="sync-imported-media-toggle" style="margin-top:3px;" />
                <span>
                    <strong>Sync imported media</strong><br>
                    <span style="font-size:0.8rem; color:var(--text-muted);">
                        Upload large external "Import Media" files to Drive. Off by
                        default to avoid pushing gigabytes you may not want online.
                    </span>
                </span>
            </label>

            <div class="button-group" style="margin-top:16px; display:flex; gap:8px; flex-wrap:wrap;">
                <button id="sync-push-imported-btn" class="popup-btn" style="flex:1;">⬆ Push imported media now</button>
                <button id="sync-now-btn" class="popup-btn" style="flex:1;">🔄 Sync now</button>
            </div>
        </div>
    `;

    document.body.appendChild(dlg);

    dlg.querySelector('#sync-panel-close').addEventListener('click', () => { dlg.style.display = 'none'; });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.style.display = 'none'; });

    // Global imported-media toggle
    const toggle = dlg.querySelector('#sync-imported-media-toggle');
    toggle.addEventListener('change', () => {
        setImportedMediaSync(toggle.checked);
        showToast(
            toggle.checked
                ? 'Imported media will now sync to Drive.'
                : 'Imported media sync turned off.',
            'info'
        );
    });

    // Manual push of imported/external media
    dlg.querySelector('#sync-push-imported-btn').addEventListener('click', _pushImportedMedia);

    // Force an immediate JSON/contribution flush
    dlg.querySelector('#sync-now-btn').addEventListener('click', async () => {
        await flush('manual');
        showToast('Sync triggered.', 'success');
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

    const toggle = _dialog.querySelector('#sync-imported-media-toggle');
    if (toggle) toggle.checked = isImportedMediaSyncEnabled();
}

/**
 * Scan the active project for imported/external media that is local-only and
 * push it to Drive on demand (independent of the auto toggle).
 */
async function _pushImportedMedia() {
    const btn = _dialog?.querySelector('#sync-push-imported-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }

    try {
        const state = getLocalState();
        const projectId = state.currentProjectId;
        const report = await generateSyncReport(projectId);

        // External/imported files live under .../external_data/ and are local-only.
        const pending = report.filter(
            r => r.isLocal && !r.isDrive && r.name.includes('/external_data/')
        );

        if (pending.length === 0) {
            showToast('No imported media pending upload.', 'info');
            return;
        }

        if (btn) btn.textContent = `Pushing ${pending.length}…`;
        const res = await syncBatch(pending, 'push', undefined, projectId);
        showToast(`Pushed ${res.success} imported file(s)${res.failed ? `, ${res.failed} failed` : ''}.`,
            res.failed ? 'failed' : 'success');
    } catch (err) {
        console.error('[SyncPanel] Push imported media failed:', err);
        showToast(`Push failed: ${err.message}`, 'failed');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '⬆ Push imported media now'; }
    }
}
