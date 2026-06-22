import EventBus, { EVENTS } from '../core/EventBus.js';
import { getAccessToken } from './AuthService.js';
import { pushMasterToDrive } from '../data/Repository.js';
import { checkForRemoteUpdates } from './SyncService.js';
import { getLocalState } from '../data/MasterData.js';

const PUSH_DEBOUNCE_MS = 4000;

const INTERVAL_MS = 5 * 60 * 1000;

const POLL_MS = 2 * 60 * 1000;

let _started   = false;
let _dirty     = false;
let _status    = 'idle';
let _lastSyncAt = null;
let _paused    = false;
let _debounce  = null;
let _interval  = null;
let _poll      = null;

let _lastSharedSyncId = null;
let _sharedSyncBusy   = false;

export function getSyncState() {
    return { status: _status, dirty: _dirty, lastSyncAt: _lastSyncAt, paused: _paused };
}

export function pauseSync() {
    _paused = true;
    _setStatus('paused');
}

export function resumeSync() {
    if (!_paused) return;
    _paused = false;
    _setStatus('idle');
}

export function isSyncPaused() {
    return _paused;
}

function _markSynced() {
    _lastSyncAt = Date.now();
    _emitStatus();
}

function _setStatus(s) {
    if (_status === s) return;
    _status = s;
    _emitStatus();
}

function _emitStatus() {
    EventBus.emit(EVENTS.SYNC_STATUS, {
        status: _status,
        dirty: _dirty,
        lastSyncAt: _lastSyncAt,
    });
}

function _markDirty() {
    _dirty = true;
    if (_debounce) clearTimeout(_debounce);
    _debounce = setTimeout(() => { _debounce = null; flush('auto'); }, PUSH_DEBOUNCE_MS);
}

export async function flush(reason = 'manual') {
    if (reason === 'manual') _paused = false;
    if (_paused) return;
    if (!getAccessToken()) { _setStatus('offline'); return; }
    if (!_dirty && reason !== 'manual') return;

    _dirty = false;
    _setStatus('syncing');

    try {
        await pushMasterToDrive();

        const active = _activeProject();
        if (active?.shared?.isImported && active.shared.permission === 'writer') {
            const { pushToSharedProject } = await import('./SharingService.js');
            await pushToSharedProject(active.id);
        }

        _markSynced();
        _setStatus('idle');
    } catch (err) {
        console.error('[SyncEngine] flush failed:', err);
        _dirty = true;
        _setStatus('error');
    }
}

export function onAuthReady() {
    if (_paused) return;
    if (!getAccessToken()) { _setStatus('offline'); return; }
    checkForRemoteUpdates(false).catch(err =>
        console.warn('[SyncEngine] initial conflict check failed:', err.message)
    );
    _markSynced();
    _setStatus('idle');
}

function _activeProject() {
    const state = getLocalState();
    return state.projects?.find(p => p.id === state.currentProjectId) || null;
}

async function _syncActiveSharedProject(force = false) {
    if (_paused || !getAccessToken() || _sharedSyncBusy) return;

    const active = _activeProject();
    if (!active) return;

    const isImported    = !!active.shared?.isImported;
    const isOwnerShared = !!active.sharing?.isShared;
    if (!isImported && !isOwnerShared) return;

    if (!force && _lastSharedSyncId === active.id) return;
    _lastSharedSyncId = active.id;

    _sharedSyncBusy = true;
    try {
        const SharingService = await import('./SharingService.js');
        if (isImported) {
            await SharingService.syncImportedProject(active.id);
        } else if (isOwnerShared) {
            await SharingService.pullEditorContributions(active.id);
        }
        _markSynced();
    } catch (err) {
        console.warn('[SyncEngine] Shared-project sync failed:', err.message);
    } finally {
        _sharedSyncBusy = false;
    }
}

function _flushOnClose() {
    if (!getAccessToken() || !_dirty) return;
    flush('close');
}

export function initSyncEngine() {
    if (_started) return;
    _started = true;

    EventBus.on(EVENTS.DATA_UPDATED, () => _markDirty());

    EventBus.on(EVENTS.PROJECT_CHANGED, () => _syncActiveSharedProject());

    EventBus.on(EVENTS.STORAGE_READY, () => setTimeout(onAuthReady, 1500));

    _interval = setInterval(() => flush('interval'), INTERVAL_MS);

    _poll = setInterval(() => {
        if (document.visibilityState === 'visible') _syncActiveSharedProject(true);
    }, POLL_MS);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            _flushOnClose();
        } else {
            _syncActiveSharedProject(true);
        }
    });
    window.addEventListener('pagehide', _flushOnClose);

    _emitStatus();
}
