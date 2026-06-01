/**
 * SyncEngine.js — Single orchestrator for all Drive synchronisation
 *
 * Pattern : Mediator + Debounced writer
 *
 * Why this exists
 * ---------------
 * Sync used to be spread across three user-facing buttons ("Check Remote
 * Updates", "Media Sync", per-project "Sync") plus fire-and-forget pushes
 * scattered through Repository. That was hard to reason about and easy to
 * misfire. This engine centralises the policy:
 *
 *   WHAT syncs automatically (no user action):
 *     - master_data.json + the active project_data.json   (cheap, always)
 *     - in-app captured media: spot photos, audio, site KML (via SharedMediaSync)
 *
 *   WHAT is opt-in (one global toggle, default OFF):
 *     - imported / external media (the "Import Media" files — can be GBs)
 *
 * WHEN it syncs (API-frugal — no aggressive polling, no server pings):
 *     - on STORAGE_READY + auth  → one pull/conflict check
 *     - on DATA_UPDATED          → debounced JSON push (coalesces bursts)
 *     - every INTERVAL_MS        → flush only if something is dirty
 *     - on tab hide / pagehide   → best-effort flush so nothing is lost on close
 *
 * Conflicts (local vs Drive master differ) are delegated to
 * SyncService.checkForRemoteUpdates → MASTER_SYNC_CONFLICT → the conflict modal
 * wired in ProjectUI.js. The engine never resolves silently.
 *
 * Public exports:
 *   initSyncEngine(), flush(), getSyncState(),
 *   isImportedMediaSyncEnabled(), setImportedMediaSync()
 */

import EventBus, { EVENTS } from '../core/EventBus.js';
import { getAccessToken } from './AuthService.js';
import { pushMasterToDrive } from '../data/Repository.js';
import { checkForRemoteUpdates } from './SyncService.js';
import { getLocalState } from '../data/MasterData.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Coalesce rapid edits — push at most once per this window after the last change. */
const PUSH_DEBOUNCE_MS = 4000;

/** Background safety flush — only does work when the dirty flag is set. */
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** localStorage key for the single "sync imported media" preference. */
const IMPORTED_MEDIA_KEY = 'cem-sync-imported-media';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _started   = false;
let _dirty     = false;          // unpushed JSON changes exist
let _status    = 'idle';         // 'idle' | 'syncing' | 'offline' | 'error'
let _debounce  = null;
let _interval  = null;

// Shared-project sync: avoid re-pulling the same project repeatedly on every
// PROJECT_CHANGED (which also fires after our own sync emits it).
let _lastSharedSyncId = null;
let _sharedSyncBusy   = false;

// ---------------------------------------------------------------------------
// Settings — single global toggle for imported/external media
// ---------------------------------------------------------------------------

/**
 * @returns {boolean} Whether imported/external media auto-syncs to Drive.
 */
export function isImportedMediaSyncEnabled() {
    return localStorage.getItem(IMPORTED_MEDIA_KEY) === '1';
}

/**
 * Set the global imported-media sync preference.
 * Turning it ON triggers a one-off catch-up scan so existing external files
 * get pushed.
 *
 * @param {boolean} on
 */
export function setImportedMediaSync(on) {
    localStorage.setItem(IMPORTED_MEDIA_KEY, on ? '1' : '0');
    _emitStatus();
    if (on) EventBus.emit(EVENTS.SYNC_IMPORTED_MEDIA_ENABLED);
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

/**
 * @returns {{ status: string, importedMedia: boolean, dirty: boolean }}
 */
export function getSyncState() {
    return { status: _status, importedMedia: isImportedMediaSyncEnabled(), dirty: _dirty };
}

function _setStatus(s) {
    if (_status === s) return;
    _status = s;
    _emitStatus();
}

function _emitStatus() {
    EventBus.emit(EVENTS.SYNC_STATUS, {
        status: _status,
        importedMedia: isImportedMediaSyncEnabled(),
        dirty: _dirty,
    });
}

// ---------------------------------------------------------------------------
// Core push pipeline
// ---------------------------------------------------------------------------

function _markDirty() {
    _dirty = true;
    if (_debounce) clearTimeout(_debounce);
    _debounce = setTimeout(() => { _debounce = null; flush('auto'); }, PUSH_DEBOUNCE_MS);
}

/**
 * Push the master + active project JSON to Drive if there are pending changes.
 *
 * Safe to call any time. No-ops when logged out (marks status 'offline') or
 * when nothing is dirty and the caller is the interval timer.
 *
 * @param {'auto'|'interval'|'close'|'manual'} [reason]
 * @returns {Promise<void>}
 */
export async function flush(reason = 'manual') {
    if (!getAccessToken()) { _setStatus('offline'); return; }
    if (!_dirty && reason !== 'manual') return;

    // Optimistically clear the flag; restore it on failure so we retry.
    _dirty = false;
    _setStatus('syncing');

    try {
        // Own JSON: master_data.json + active owner project_data.json.
        await pushMasterToDrive();

        // If the active project is an imported EDITOR project, also push our
        // editor_contributions.json so the owner sees our edits. (drive.file
        // can't write the owner's project_data.json directly.)
        const active = _activeProject();
        if (active?.shared?.isImported && active.shared.permission === 'writer') {
            const { pushToSharedProject } = await import('./SharingService.js');
            await pushToSharedProject(active.id);
        }

        _setStatus('idle');
    } catch (err) {
        console.error('[SyncEngine] flush failed:', err);
        _dirty = true;
        _setStatus('error');
    }
}

/**
 * Run the one-off initial pull / conflict check. Safe to call when storage
 * opens AND again after the user logs in (auth happens after STORAGE_READY).
 * No-ops to 'offline' when there is no token.
 */
export function onAuthReady() {
    if (!getAccessToken()) { _setStatus('offline'); return; }
    checkForRemoteUpdates(false).catch(err =>
        console.warn('[SyncEngine] initial conflict check failed:', err.message)
    );
    _setStatus('idle');
}

/** @returns {object|null} The active project, or null. */
function _activeProject() {
    const state = getLocalState();
    return state.projects?.find(p => p.id === state.currentProjectId) || null;
}

/**
 * Pull/push shared-project data when the active project is a collaboration
 * project. Runs once per project switch (guarded), replacing the old manual
 * per-project "Sync" button.
 *
 *  - Imported project (viewer/editor) → pull owner's latest project_data + media.
 *  - Owner's shared project           → pull editor contributions and merge.
 */
async function _syncActiveSharedProject() {
    if (!getAccessToken() || _sharedSyncBusy) return;

    const active = _activeProject();
    if (!active) return;

    const isImported    = !!active.shared?.isImported;
    const isOwnerShared = !!active.sharing?.isShared;
    if (!isImported && !isOwnerShared) return;

    // Once per switch — our own sync re-emits PROJECT_CHANGED.
    if (_lastSharedSyncId === active.id) return;
    _lastSharedSyncId = active.id;

    _sharedSyncBusy = true;
    try {
        const SharingService = await import('./SharingService.js');
        if (isImported) {
            await SharingService.syncImportedProject(active.id);
        } else if (isOwnerShared) {
            await SharingService.pullEditorContributions(active.id);
        }
        console.log('[SyncEngine] Shared-project sync complete for', active.name);
    } catch (err) {
        console.warn('[SyncEngine] Shared-project sync failed:', err.message);
    } finally {
        _sharedSyncBusy = false;
    }
}

/**
 * Best-effort flush when the tab is being hidden or unloaded.
 * `visibilitychange → hidden` is the reliable "app closing / backgrounded"
 * signal (more dependable than `beforeunload`), and still has time to fire the
 * request. We do not await — the browser keeps the in-flight request alive.
 */
function _flushOnClose() {
    if (!getAccessToken() || !_dirty) return;
    flush('close');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Start the engine. Call once at app bootstrap (after EventBus exists).
 */
export function initSyncEngine() {
    if (_started) return;
    _started = true;

    // Any data mutation marks dirty → debounced push.
    EventBus.on(EVENTS.DATA_UPDATED, () => _markDirty());

    // Switching to a collaboration project → pull (and merge) once.
    EventBus.on(EVENTS.PROJECT_CHANGED, () => _syncActiveSharedProject());

    // First storage open + auth → pull / conflict check once (no push spam).
    EventBus.on(EVENTS.STORAGE_READY, () => setTimeout(onAuthReady, 1500));

    // Periodic safety flush — only works when dirty.
    _interval = setInterval(() => flush('interval'), INTERVAL_MS);

    // Flush on close / background so unsynced edits are not lost.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') _flushOnClose();
    });
    window.addEventListener('pagehide', _flushOnClose);

    _emitStatus();
    console.log('[SyncEngine] Initialised — auto-sync on change, interval, and close.');
}
