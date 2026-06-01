/**
 * SyncDashboard.js — Sync Manager modal and live sync UI
 *
 * Pattern : Module Pattern
 *           All state (_modal reference, batch lists) is private to this
 *           module.  Only the exported surface (initSyncDashboard, openSyncModal,
 *           renderSyncDashboard) is visible to callers.
 *
 * Extracted from ui.js which had sync modal creation, event listeners, and
 * rendering all inlined.
 *
 * Key changes over ui.js
 * ----------------------
 *  1. Dead `renderSyncRows()` function removed entirely — superseded by
 *     `renderSyncDashboard()` which groups files and adds mini per-row buttons.
 *  2. `alert()` calls replaced with `showToast()`.
 *  3. EventBus used instead of raw window.addEventListener for SYNC_PROGRESS
 *     and SYNC_BATCH_COMPLETE.
 *  4. `updateSyncIndicators()` integrated as a private helper; the global
 *     sidebar button label refresh is called automatically after batch complete.
 *
 * Dependencies
 * ------------
 *   EventBus, EVENTS  — ../core/EventBus.js
 *   SyncService       — ../services/SyncService.js
 *   MasterData        — ../data/MasterData.js   (getLocalState)
 *   showToast         — ./Toast.js
 */

import EventBus, { EVENTS }          from '../core/EventBus.js';
import {
    generateSyncReport,
    getAllProjectsSyncStatus,
    syncUp,
    syncDown,
    syncBatch,
} from '../services/SyncService.js';
import { getLocalState }              from '../data/MasterData.js';
import { showToast }                  from './Toast.js';

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

/**
 * Cached reference to the dynamically created sync modal element.
 * Null until openSyncModal() is called for the first time.
 * @type {HTMLElement|null}
 */
let _modal = null;

// ---------------------------------------------------------------------------
// EventBus wiring
// ---------------------------------------------------------------------------

/**
 * Subscribe to SYNC_PROGRESS and SYNC_BATCH_COMPLETE so the modal updates
 * automatically during a background batch operation.
 *
 * Must be called once (from App.js after DOMContentLoaded).
 */
export function initSyncDashboard() {
    // ── Progress tick — update progress bar if modal is open ─────────────────
    EventBus.on(EVENTS.SYNC_PROGRESS, ({ data }) => {
        const { percent, currentFile, fails } = data;
        const bar   = document.getElementById('sync-progress-bar');
        const label = document.getElementById('sync-progress-label');

        if (bar)   bar.style.width = `${percent}%`;
        if (label) label.textContent =
            `Processing: ${currentFile.split('/').pop()} (${fails} errors)`;
    });

    // ── Batch complete — hide progress bar, refresh list, update sidebar btn ─
    EventBus.on(EVENTS.SYNC_BATCH_COMPLETE, async ({ data }) => {
        const progressContainer = document.getElementById('sync-progress-container');
        const toolbar           = document.getElementById('sync-toolbar');

        if (progressContainer) progressContainer.style.display = 'none';
        if (toolbar) {
            toolbar.style.pointerEvents = 'auto';
            toolbar.style.opacity       = '1';
        }

        showToast(`Batch ${data.direction} complete.`, 'success');

        // Refresh sidebar button label
        await _updateSyncIndicators();

        // Refresh modal file list if it is currently visible
        if (_modal && _modal.style.display !== 'none') {
            const projectSelect  = document.getElementById('sync-project-select');
            const state          = getLocalState();
            const activeProjId   = projectSelect ? projectSelect.value : state.currentProjectId;
            const newReport      = await generateSyncReport(activeProjId);
            renderSyncDashboard(newReport);
        }
    });

    // ── Also refresh the sidebar button on data changes ───────────────────────
    EventBus.on(EVENTS.DATA_UPDATED,   () => _updateSyncIndicators());
    EventBus.on(EVENTS.STORAGE_READY,  () => _updateSyncIndicators());
}

// ---------------------------------------------------------------------------
// Sidebar sync-status indicator
// ---------------------------------------------------------------------------

/**
 * Refresh the "Sync Manager" sidebar button label and colour based on whether
 * all projects are fully synced.  Also updates the global-sync-status span
 * and the project dropdown inside the modal if it is open.
 *
 * @private
 */
async function _updateSyncIndicators() {
    const syncManagerBtn = document.getElementById('btn-sync-manager');
    if (syncManagerBtn) syncManagerBtn.textContent = 'Checking Sync...';

    try {
        const statuses  = await getAllProjectsSyncStatus();
        const allSynced = Object.values(statuses).every(s => s === true);

        if (syncManagerBtn) {
            syncManagerBtn.textContent = allSynced ? '✅ Sync Manager' : '⚠️ Sync Manager';
            syncManagerBtn.style.color = allSynced ? 'green' : '#b8860b';
        }

        // Update the global indicator and project dropdown if the modal is open.
        const globalIndicator = document.getElementById('global-sync-status');
        if (globalIndicator) {
            globalIndicator.textContent = allSynced ? '✅' : '⚠️';
            globalIndicator.title       = allSynced
                ? 'All projects synced'
                : 'Some projects have unsynced files';

            const projectSelect = document.getElementById('sync-project-select');
            const state         = getLocalState();

            if (projectSelect && state.projects) {
                const currentVal           = projectSelect.value;
                projectSelect.innerHTML    = '';
                state.projects.forEach(p => {
                    const icon = statuses[p.id] ? '✅' : '⚠️';
                    const opt  = document.createElement('option');
                    opt.value       = p.id;
                    opt.textContent = `${icon} ${p.name}`;
                    if (p.id === currentVal) opt.selected = true;
                    projectSelect.appendChild(opt);
                });
            }
        }
    } catch (e) {
        console.warn('[SyncDashboard] Sync check failed', e);
        if (document.getElementById('btn-sync-manager')) {
            document.getElementById('btn-sync-manager').textContent = 'Sync Manager';
        }
    }
}

// ---------------------------------------------------------------------------
// Modal lifecycle
// ---------------------------------------------------------------------------

/**
 * Open the Sync Manager modal, creating it on first call.
 *
 * On subsequent calls the modal is already in the DOM — we just show it and
 * refresh the file list.
 */
export async function openSyncModal() {
    // ── Create the modal once ─────────────────────────────────────────────────
    if (!_modal) {
        _modal = document.createElement('div');
        _modal.id        = 'sync-modal';
        _modal.className = 'import-popup-overlay';
        _modal.style.display = 'flex';

        _modal.innerHTML = `
            <div class="import-popup-content" style="max-width: 800px; max-height:85vh; display:flex; flex-direction:column;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                    <h3>☁️ Sync Manager</h3>
                    <button id="close-sync" style="background:transparent; border:none; font-size:1.2rem; cursor:pointer;">✖</button>
                </div>

                <div id="sync-toolbar" style="display:flex; gap:10px; margin-bottom:15px; padding:10px; background:var(--bg-surface-alt); border-radius:8px;">
                    <div style="flex:1;">
                        <strong>Status:</strong> <span id="sync-status-text">Scanning...</span>
                    </div>
                    <button id="btn-push-all" class="sync-action-btn" disabled>⬆ Push All (<span id="count-push">0</span>)</button>
                    <button id="btn-pull-all" class="sync-action-btn" disabled>⬇ Pull All (<span id="count-pull">0</span>)</button>
                </div>

                <div id="sync-progress-container" style="display:none; margin-bottom:10px;">
                    <div style="background:var(--bg-surface-hover); height:10px; border-radius:5px; overflow:hidden;">
                        <div id="sync-progress-bar" style="width:0%; background:#4CAF50; height:100%; transition:width 0.3s;"></div>
                    </div>
                    <div id="sync-progress-label" style="font-size:0.8rem; text-align:center; margin-top:5px;">Processing...</div>
                </div>

                <div id="sync-list" style="flex:1; overflow-y:auto; padding-right:5px;"></div>
            </div>
        `;

        document.body.appendChild(_modal);

        // Close button
        document.getElementById('close-sync').addEventListener('click', () => {
            _modal.style.display = 'none';
        });

        // Inject the project-selector header row (inserted after the title bar)
        _injectHeaderControls();

    } else {
        // ── Re-opening an existing modal — reset scanning state ───────────────
        _modal.style.display = 'flex';
        const syncList = document.getElementById('sync-list');
        if (syncList) {
            syncList.innerHTML = "<p style='text-align:center; padding:20px;'>Scanning files...</p>";
        }
        const progressContainer = document.getElementById('sync-progress-container');
        if (progressContainer) progressContainer.style.display = 'none';
    }

    // ── Populate project dropdown & run initial sync report ──────────────────
    await _populateProjectDropdown();

    const state    = getLocalState();
    const report   = await generateSyncReport(state.currentProjectId);
    renderSyncDashboard(report);
}

/**
 * Insert the global-status icon + project-selector row into the modal content,
 * just below the title bar.  Idempotent — skipped if already injected.
 *
 * @private
 */
function _injectHeaderControls() {
    if (document.getElementById('sync-header-controls')) return;

    const header       = document.createElement('div');
    header.id          = 'sync-header-controls';
    header.style.cssText = 'margin-bottom:15px; padding:10px; background:var(--bg-surface-alt); border-radius:8px; display:flex; align-items:center; gap:10px;';

    header.innerHTML = `
        <span id="global-sync-status" style="font-size:1.2rem;">Checking...</span>
        <select id="sync-project-select" style="flex:1; margin:0;"></select>
    `;

    // Insert after the title bar (first child of the content div)
    const content  = _modal.querySelector('.import-popup-content');
    const titleRow = content.children[0];
    titleRow.after(header);

    // Project selector change → re-render the file list for the chosen project
    document.getElementById('sync-project-select').addEventListener('change', async (e) => {
        const report = await generateSyncReport(e.target.value);
        renderSyncDashboard(report);
    });
}

/**
 * Fetch all project sync statuses and populate the #sync-project-select
 * dropdown, selecting the currently active project.
 *
 * @private
 */
async function _populateProjectDropdown() {
    const projectSelect   = document.getElementById('sync-project-select');
    const globalIndicator = document.getElementById('global-sync-status');
    const state           = getLocalState();

    if (!projectSelect || !globalIndicator) return;

    globalIndicator.textContent  = '⏳';
    projectSelect.innerHTML      = '<option>Loading...</option>';

    const statuses  = await getAllProjectsSyncStatus();
    const allSynced = Object.values(statuses).every(s => s === true);

    globalIndicator.textContent = allSynced ? '✅' : '⚠️';
    globalIndicator.title       = allSynced
        ? 'All projects synced'
        : 'Some projects have unsynced files';

    projectSelect.innerHTML = '';
    (state.projects || []).forEach(p => {
        const icon = statuses[p.id] ? '✅' : '⚠️';
        const opt  = document.createElement('option');
        opt.value       = p.id;
        opt.textContent = `${icon} ${p.name}`;
        if (p.id === state.currentProjectId) opt.selected = true;
        projectSelect.appendChild(opt);
    });
}

// ---------------------------------------------------------------------------
// File list rendering
// ---------------------------------------------------------------------------

/**
 * Render the grouped file list inside #sync-list.
 *
 * Files are grouped into three categories:
 *   Metadata  — master_data.json
 *   Sites     — files under <project>/sites/
 *   Spots     — files grouped by spot folder name
 *
 * Each row shows a per-file sync status badge and a single-item push/pull button.
 * Batch push/pull buttons (count-push, count-pull) are also updated.
 *
 * @param {Array<{name:string, isLocal:boolean, isDrive:boolean, driveId:string|null}>} report
 */
export function renderSyncDashboard(report) {
    const container = document.getElementById('sync-list');
    if (!container) return;

    container.innerHTML = '';

    // ── Group items ───────────────────────────────────────────────────────────
    const groups   = { Metadata: [], Sites: [], Spots: {} };
    const pushList = [];
    const pullList = [];

    report.forEach(item => {
        const parts = item.name.split('/');
        // parts[0] = ProjectFolder, parts[1] = 'spots'|'sites', parts[2] = SpotName

        if (item.name === 'master_data.json') {
            groups.Metadata.push(item);
        } else if (parts[1] === 'sites') {
            groups.Sites.push(item);
        } else if (parts[1] === 'spots') {
            const spotName = parts[2] || 'Unknown';
            if (!groups.Spots[spotName]) groups.Spots[spotName] = [];
            groups.Spots[spotName].push(item);
        }

        if (item.isLocal && !item.isDrive) pushList.push(item);
        if (!item.isLocal && item.isDrive)  pullList.push(item);
    });

    // ── Update batch button counts ────────────────────────────────────────────
    const countPushEl = document.getElementById('count-push');
    const countPullEl = document.getElementById('count-pull');
    const btnPush     = document.getElementById('btn-push-all');
    const btnPull     = document.getElementById('btn-pull-all');
    const statusText  = document.getElementById('sync-status-text');

    if (countPushEl) countPushEl.textContent = pushList.length;
    if (countPullEl) countPullEl.textContent = pullList.length;
    if (btnPush)     btnPush.disabled = pushList.length === 0;
    if (btnPull)     btnPull.disabled = pullList.length === 0;
    if (statusText)  statusText.textContent = 'Ready';

    if (btnPush) btnPush.onclick = () => _runBatchSync(pushList, 'push');
    if (btnPull) btnPull.onclick = () => _runBatchSync(pullList, 'pull');

    // ── Render groups (single innerHTML write instead of += in a loop) ────────
    const html = [];

    if (groups.Metadata.length > 0) {
        html.push(`<div class="sync-group-header">📂 System Files</div>`);
        for (const item of groups.Metadata) html.push(_createRow(item));
    }

    if (groups.Sites.length > 0) {
        html.push(`<div class="sync-group-header">🗺️ Sites</div>`);
        for (const item of groups.Sites) html.push(_createRow(item));
    }

    for (const spotName of Object.keys(groups.Spots).sort()) {
        const items     = groups.Spots[spotName];
        const allSynced = items.every(i => i.isLocal && i.isDrive);
        const color     = allSynced ? '#4CAF50' : '#333';

        html.push(`
            <div class="sync-group-header" style="border-left: 4px solid ${color}">
                📍 ${spotName.replace(/_/g, ' ')}
            </div>
        `);
        for (const item of items) html.push(_createRow(item));
    }

    container.innerHTML = html.join('');

    // ── Attach per-row mini-button handlers via event delegation ─────────────
    container.querySelectorAll('.mini-sync-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const el     = e.currentTarget;
            const action = el.dataset.action;
            const name   = el.dataset.name;
            const id     = el.dataset.id;

            el.disabled   = true;
            el.innerHTML  = '⏳';

            try {
                if (action === 'push') await syncUp(name);
                if (action === 'pull') await syncDown(id, name);

                // Determine the currently selected project for the refresh
                const select       = document.getElementById('sync-project-select');
                const state        = getLocalState();
                const activeProjId = select ? select.value : state.currentProjectId;
                const newReport    = await generateSyncReport(activeProjId);
                renderSyncDashboard(newReport);
            } catch (err) {
                showToast(`Sync failed: ${err.message}`, 'failed');
                el.innerHTML = '❌';
            }
        });
    });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the HTML string for a single sync-list row.
 *
 * @param {{ name:string, isLocal:boolean, isDrive:boolean, driveId:string|null }} item
 * @returns {string}  HTML fragment string.
 * @private
 */
function _createRow(item) {
    let statusHtml = '';
    let actionBtn  = '';

    if (item.isLocal && item.isDrive) {
        statusHtml = `<span style="color:green">✅ Synced</span>`;
    } else if (item.isLocal && !item.isDrive) {
        statusHtml = `<span style="color:orange">🏠 Local Only</span>`;
        actionBtn  = `<button class="mini-sync-btn" data-action="push" data-name="${item.name}">⬆</button>`;
    } else if (!item.isLocal && item.isDrive) {
        statusHtml = `<span style="color:blue">☁️ Drive Only</span>`;
        actionBtn  = `<button class="mini-sync-btn" data-action="pull" data-id="${item.driveId}" data-name="${item.name}">⬇</button>`;
    }

    const displayName = item.name.split('/').pop();

    return `
        <div class="sync-row">
            <div class="sync-file-name" title="${item.name}">${displayName}</div>
            <div class="sync-status">${statusHtml}</div>
            <div class="sync-action">${actionBtn}</div>
        </div>
    `;
}

/**
 * Confirm and execute a batch push or pull operation.
 * Locks the toolbar during the operation; EventBus SYNC_BATCH_COMPLETE
 * unlocks it and refreshes the list automatically.
 *
 * @param {Array}            items      Files to sync.
 * @param {'push'|'pull'}    direction  Sync direction.
 * @private
 */
async function _runBatchSync(items, direction) {
    // Non-blocking confirmation instead of blocking confirm()
    const confirmed = await new Promise(resolve => {
        const msg = `${direction === 'push' ? '⬆ Push' : '⬇ Pull'} ${items.length} file(s)?`;
        const statusText = document.getElementById('sync-status-text');
        const btnPush    = document.getElementById('btn-push-all');
        const btnPull    = document.getElementById('btn-pull-all');

        if (statusText) statusText.innerHTML =
            `${msg} <button id="sync-confirm-yes" class="mini-sync-btn" style="border-radius:4px;width:auto;padding:2px 8px;">Yes</button>` +
            ` <button id="sync-confirm-no" class="mini-sync-btn" style="border-radius:4px;width:auto;padding:2px 8px;">No</button>`;

        document.getElementById('sync-confirm-yes')?.addEventListener('click', () => {
            if (statusText) statusText.textContent = 'Syncing...';
            resolve(true);
        });
        document.getElementById('sync-confirm-no')?.addEventListener('click', () => {
            if (statusText) statusText.textContent = 'Ready';
            resolve(false);
        });
    });
    if (!confirmed) return;

    const progressContainer = document.getElementById('sync-progress-container');
    const toolbar           = document.getElementById('sync-toolbar');

    if (toolbar) {
        toolbar.style.pointerEvents = 'none';
        toolbar.style.opacity       = '0.5';
    }
    if (progressContainer) progressContainer.style.display = 'block';

    try {
        // Pass active project ID so syncBatch can route imported project media correctly
        const state = getLocalState();
        const activeProjectId = state.currentProjectId;
        await syncBatch(items, direction, undefined, activeProjectId);
        // SYNC_BATCH_COMPLETE event will unlock toolbar and refresh the list.
    } catch (err) {
        showToast(err.message, 'failed');
        if (toolbar) {
            toolbar.style.pointerEvents = 'auto';
            toolbar.style.opacity       = '1';
        }
        if (progressContainer) progressContainer.style.display = 'none';
    }
}
