/**
 * App.js — Application bootstrap and UI coordinator
 *
 * Pattern : Mediator
 *
 * The Mediator sits between all participating modules (Auth, Storage, Sync)
 * so they never reference each other directly.  This file:
 *
 *   1. Renders the auth/storage control panel HTML into #auth-section.
 *   2. Wires DOM events (button clicks) to service calls.
 *   3. Subscribes to EventBus events and updates the UI accordingly.
 *   4. Exports `initApp()` — the single entry-point called by app.js on load.
 *
 * Deliberately contains NO business logic.  All data work lives in the
 * service and data layers that this file coordinates.
 *
 * Import map (all paths relative to js/core/):
 *   AuthService    → ../services/AuthService.js
 *   StorageAdapter → ../data/StorageAdapter.js
 *   SyncService    → ../services/SyncService.js
 *   EventBus       → ./EventBus.js
 *   Config         → ./Config.js
 *
 * NOTE: Until those service modules are created the imports below reference
 * their planned locations.  Adjust paths if the directory layout changes.
 */

import EventBus, { EVENTS } from './EventBus.js';
import Config               from './Config.js';

// ---------------------------------------------------------------------------
// Service imports — thin adapters over the existing JS modules.
// These files do not yet exist; they will be created in the next refactor
// iteration.  The paths below match the agreed directory structure.
// ---------------------------------------------------------------------------
import { initAuth, requestLogin }      from '../services/AuthService.js';
import { initStorage, checkFileExists, saveFile, getStorageEstimate } from '../data/StorageAdapter.js';
import { ensureMasterJson }            from '../data/MasterData.js';
import { initSyncEngine, onAuthReady } from '../services/SyncEngine.js';
import { initSyncPanel }               from '../ui/SyncPanel.js';
import { initSharedMediaSync }         from '../services/SharedMediaSync.js';

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Build and inject the auth/storage control panel HTML into #auth-section.
 * The markup is identical to the original initApp() in storage.js so that
 * existing CSS selectors and IDs continue to work without changes.
 *
 * @param {HTMLElement} authSection  The container element.
 */
function _renderAuthPanel(authSection) {
    authSection.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:5px; margin-bottom:15px;">
            <button id="btn-select-storage" style="width:100%; background:#FF9800; color:white;">
                📂 Initialize Storage
            </button>
            <div id="folder-status" style="font-size:0.8rem; color:var(--text-muted); text-align:center; display:none;"></div>
            <div id="drive-controls" style="display:none; flex-direction:column; gap:5px; margin-top:5px;">
                <div style="display:flex; flex-direction:column; align-items:center;">
                    <button id="btn-login" style="width:100%; background:#4285F4; color:white;">Login to Drive</button>
                    <span style="font-size:0.72rem; color:var(--ink-soft); margin-top:2px;">Login to enable Drive sync — optional</span>
                </div>
                <button id="btn-sync-pill" title="Sync status — click for options"
                    style="width:100%; background:var(--bg-surface-alt); border:1px solid var(--border-color); border-radius:6px; padding:6px; cursor:pointer; display:none; font-weight:500;">
                    ⚪ Offline
                </button>
            </div>
        </div>
    `;
}

/**
 * Handle a successful storage initialisation.
 * Updates the status badge, reveals the Drive control panel, and emits
 * the canonical EventBus events so every other module can react.
 *
 * @param {{ type: string, name: string }} storageInfo  Returned by StorageAdapter.initStorage().
 */
function _onStorageReady(storageInfo) {
    const btnSelectStorage = document.getElementById('btn-select-storage');
    const folderStatus     = document.getElementById('folder-status');
    const driveControls    = document.getElementById('drive-controls');

    if (btnSelectStorage) btnSelectStorage.style.display = 'none';

    if (folderStatus) {
        folderStatus.textContent = storageInfo.type === 'native'
            ? `📂 Local Folder: ${storageInfo.name}`
            : `💾 Browser Storage (IndexedDB)`;
        folderStatus.style.display = 'block';

        // For browser storage, show how much of the quota is used so the user
        // has visibility long before they ever hit a "storage full" wall.
        if (storageInfo.type !== 'native') {
            getStorageEstimate().then((est) => {
                if (est.usage == null || est.quota == null) return;
                const used = _fmtBytes(est.usage);
                const cap  = _fmtBytes(est.quota);
                folderStatus.textContent = `💾 Browser Storage — ${used} of ${cap} used (${est.percent}%)`;
                if (est.percent != null && est.percent >= 90) {
                    EventBus.emit(EVENTS.TOAST_SHOW, {
                        message: `Storage is ${est.percent}% full. Remove old projects/media or free device space soon.`,
                        type: 'failed',
                    });
                }
            });
        }
    }

    // Only show Drive login when a Google client ID is configured
    if (driveControls && Config.google.clientId) {
        driveControls.style.display = 'flex';
    }

    // Enable all previously-disabled UI controls
    _enableAppControls();

    // Notify all subscribers (map, UI, sync) that storage is open
    EventBus.emit(EVENTS.STORAGE_READY, storageInfo);
    EventBus.emit(EVENTS.DATA_UPDATED,  null);
}

/**
 * Remove the disabled overlay and re-enable every button/input/select
 * inside #app-controls.  Called once storage is successfully initialised.
 */
function _enableAppControls() {
    const wrapper = document.getElementById('app-controls');
    if (!wrapper) return;
    wrapper.classList.remove('app-controls-disabled');
    wrapper.querySelectorAll('button, select, input').forEach(el => {
        el.disabled = false;
    });
}

/**
 * Human-readable byte size (e.g. 1.4 GB).
 * @param {number} n
 * @returns {string}
 */
function _fmtBytes(n) {
    if (!n && n !== 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Ensure the watcher.py script exists in local storage.
 *
 * On a fresh install the user's storage folder won't contain the Python
 * job-processor script.  This function checks for its existence and, when
 * missing, fetches the bundled copy from the web-server root and writes it
 * into the storage root so that the user can launch it from there.
 *
 * Pattern: Lazy Initialisation
 *
 * @returns {Promise<void>}
 */
async function _ensureWatcherScript() {
    try {
        const exists = await checkFileExists('watcher.py');
        if (!exists) {
            const response = await fetch('./watcher.py');
            if (!response.ok) throw new Error(`Server returned ${response.status}`);
            const pythonCode = await response.text();
            const blob = new Blob([pythonCode], { type: 'text/plain' });
            await saveFile(blob, 'watcher.py', []);
            console.log('[App] watcher.py injected into storage.');
        }
    } catch (e) {
        console.warn('[App] Could not inject watcher.py:', e);
    }
}

/**
 * Click-handler for #btn-select-storage.
 * Delegates to StorageAdapter and updates the UI on success.
 */
async function _handleSelectStorage() {
    try {
        const storageInfo = await initStorage();
        await ensureMasterJson();
        await _ensureWatcherScript();
        _onStorageReady(storageInfo);
    } catch (error) {
        // AbortError means the user dismissed the directory picker — not a real error
        if (error.name !== 'AbortError') {
            console.error('[App] Storage initialisation failed:', error);
            EventBus.emit(EVENTS.TOAST_SHOW, {
                message: `Storage initialisation failed: ${error.message}`,
                type: 'error',
            });
        }
    }
}

/**
 * Callback passed to AuthService.initAuth().
 * Called once the OAuth token has been successfully acquired.
 * Reveals sync buttons and kicks off a background remote-update check.
 */
function _onAuthSuccess() {
    const btnLogin = document.getElementById('btn-login');
    const syncPill = document.getElementById('btn-sync-pill');

    if (btnLogin) btnLogin.style.display = 'none';
    if (syncPill) syncPill.style.display = 'block';

    // Now that we have a token, run the initial pull / conflict check.
    onAuthReady();
}

/**
 * Wire all button click-handlers after the panel HTML has been injected.
 */
function _bindUIEvents() {
    document.getElementById('btn-select-storage')
        ?.addEventListener('click', _handleSelectStorage);

    document.getElementById('btn-login')
        ?.addEventListener('click', () => requestLogin());

    // Sync is automatic (SyncEngine). The #btn-sync-pill click is handled by
    // SyncPanel via event delegation — no binding needed here.
}

// ---------------------------------------------------------------------------
// Public bootstrap
// ---------------------------------------------------------------------------

/**
 * Initialise auth once the Google Identity Services library is present.
 *
 * The GIS script (accounts.google.com/gsi/client) loads `async defer`, so it
 * may not be ready when bootstrap runs at DOMContentLoaded. Poll briefly for
 * `globalThis.google` before calling initAuth, instead of bailing on the first
 * miss (which left tokenClient null -> "Auth not initialized" on first login).
 *
 * @param {Function} onSuccess
 * @param {number} [tries=50]  ~10s at 200ms steps.
 */
function _initAuthWhenReady(onSuccess, tries = 50) {
    if (!Config.google.clientId) {
        console.warn('[App] No google.clientId configured — Drive features disabled.');
        return;
    }
    if (globalThis.google?.accounts?.oauth2) {
        initAuth(onSuccess);
        return;
    }
    if (tries <= 0) {
        console.error('[App] Google Identity Services failed to load — check network / adblock / CSP for accounts.google.com.');
        return;
    }
    setTimeout(() => _initAuthWhenReady(onSuccess, tries - 1), 200);
}

/**
 * initApp — Application entry point.
 *
 * Called by app.js on window load.  Renders the UI panel, wires events, and
 * initialises the auth layer.  Order of operations matters:
 *
 *   1. Render HTML  → DOM nodes exist before we query them.
 *   2. Bind events  → Handlers are attached before the user can click.
 *   3. Init auth    → Google Identity Services library bootstrapped last;
 *                     its callback fires asynchronously when/if the user logs in.
 */
export function initApp() {
    const authSection = document.getElementById('auth-section');
    if (!authSection) {
        console.warn('[App] #auth-section not found in DOM — aborting initApp.');
        return;
    }

    _renderAuthPanel(authSection);
    _bindUIEvents();

    // Initialise Google Identity Services OAuth client once the GIS library is
    // loaded (its <script> is async defer, so it may lag bootstrap).
    // _onAuthSuccess fires asynchronously once a token is obtained.
    _initAuthWhenReady(_onAuthSuccess);

    // Central sync orchestrator: auto-pushes JSON on change/interval/close,
    // runs the initial conflict check, and owns shared-project sync.
    initSyncEngine();

    // Minimal sync UI: status pill + imported-media toggle.
    initSyncPanel();

    // Media upload queue for in-app captures (+ imported media when enabled).
    initSharedMediaSync();

    console.log('[App] Bootstrap complete.');
}
