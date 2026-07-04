import EventBus, { EVENTS } from '../core/EventBus.js';
import { getAccessToken } from './AuthService.js';
import { pushMasterToDrive } from '../data/Repository.js';
import { checkForRemoteUpdates } from './SyncService.js';
import { getLocalState, rehydrate, saveMasterData } from '../data/MasterData.js';

const PUSH_DEBOUNCE_MS = 4000;

const INTERVAL_MS = 5 * 60 * 1000;

const POLL_MS = 2 * 60 * 1000;

const LEADER_LOCK = 'cem-sync-leader';
const CHANNEL     = 'cem-sync';

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

let _isLeader = false;
let _channel  = null;
const _tabId  = crypto.randomUUID();

let _lastDirtyAt        = 0;
let _lastFlushRequestAt = 0;

export function getSyncState() {
    return { status: _status, dirty: _dirty, lastSyncAt: _lastSyncAt, paused: _paused, isLeader: _isLeader };
}

export function isSyncLeader() {
    return _isLeader;
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
    _lastDirtyAt = Date.now();
    if (_debounce) clearTimeout(_debounce);
    _debounce = setTimeout(() => { _debounce = null; flush('auto'); }, PUSH_DEBOUNCE_MS);
}

// Only the leader tab talks to Drive. Non-leader tabs fold the persisted
// state into memory (another tab may have written it) and hand the flush to
// the leader; their dirty flag stays set until the leader confirms a sync.
export async function flush(reason = 'manual') {
    if (reason === 'manual') _paused = false;
    if (_paused) return;
    if (!getAccessToken()) { _setStatus('offline'); return; }
    if (!_dirty && reason !== 'manual') return;

    if (!_isLeader) {
        await rehydrate();
        _lastFlushRequestAt = Date.now();
        _channel?.postMessage({ t: 'flush-request', from: _tabId });
        return;
    }

    _dirty = false;
    _setStatus('syncing');

    try {
        const changed = await rehydrate();
        if (changed) await saveMasterData();
        await pushMasterToDrive();

        const active = _activeProject();
        if (active?.shared?.isImported && active.shared.permission === 'writer') {
            const { pushToSharedProject } = await import('./SharingService.js');
            await pushToSharedProject(active.id);
        }

        _markSynced();
        _setStatus('idle');
        _channel?.postMessage({ t: 'synced', from: _tabId });
    } catch (err) {
        console.error('[SyncEngine] flush failed:', err);
        _dirty = true;
        _setStatus('error');
    }
}

export function onAuthReady() {
    if (_paused) return;
    if (!getAccessToken()) { _setStatus('offline'); return; }
    if (_isLeader) {
        checkForRemoteUpdates(false).catch(err =>
            console.warn('[SyncEngine] initial conflict check failed:', err.message)
        );
    }
    _markSynced();
    _setStatus('idle');
}

function _activeProject() {
    const state = getLocalState();
    return state.projects?.find(p => p.id === state.currentProjectId) || null;
}

async function _syncActiveSharedProject(force = false) {
    if (_paused || !getAccessToken() || _sharedSyncBusy || !_isLeader) return;

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

function _onBecameLeader() {
    _isLeader = true;
    _emitStatus();
    if (_dirty && getAccessToken()) flush('leader-takeover');
}

function _electLeader() {
    if (navigator.locks?.request) {
        // Whoever holds the lock is the leader; the promise below never
        // resolves, so the lock releases only when the tab dies and the
        // next waiter is promoted automatically.
        navigator.locks.request(LEADER_LOCK, { mode: 'exclusive' }, () => {
            _onBecameLeader();
            return new Promise(() => { });
        }).catch(err => console.warn('[SyncEngine] leader lock failed:', err.message));
        return;
    }

    if (!_channel) { _isLeader = true; return; }

    // BroadcastChannel fallback: claim, and become leader unless an existing
    // leader answers. Re-claim periodically in case the leader tab died.
    let claimTimer = null;
    const claim = () => {
        if (_isLeader) return;
        _channel.postMessage({ t: 'claim', from: _tabId });
        clearTimeout(claimTimer);
        claimTimer = setTimeout(() => { if (!_leaderSeen) _onBecameLeader(); _leaderSeen = false; }, 800);
    };
    let _leaderSeen = false;
    _channel.addEventListener('message', (e) => {
        const msg = e.data || {};
        if (msg.t === 'claim' && _isLeader) _channel.postMessage({ t: 'leader-here', from: _tabId });
        if (msg.t === 'leader-here') _leaderSeen = true;
    });
    claim();
    setInterval(claim, 15000);
}

function _bindChannel() {
    if (!('BroadcastChannel' in globalThis)) return;
    _channel = new BroadcastChannel(CHANNEL);
    _channel.addEventListener('message', async (e) => {
        const msg = e.data || {};
        if (msg.t === 'flush-request' && _isLeader) {
            await rehydrate();
            _markDirty();
        }
        if (msg.t === 'synced' && !_isLeader) {
            // Keep dirty if we mutated after the last hand-off; the next
            // debounced flush re-delegates those changes to the leader.
            if (_lastDirtyAt <= _lastFlushRequestAt) _dirty = false;
            await rehydrate();
            _markSynced();
            _setStatus('idle');
            EventBus.emit(EVENTS.PROJECT_CHANGED);
        }
    });
}

export function initSyncEngine() {
    if (_started) return;
    _started = true;

    _bindChannel();
    _electLeader();

    EventBus.on(EVENTS.DATA_UPDATED, () => _markDirty());

    EventBus.on(EVENTS.PROJECT_CHANGED, () => _syncActiveSharedProject());

    EventBus.on(EVENTS.STORAGE_READY, () => setTimeout(onAuthReady, 1500));

    _interval = setInterval(() => flush('interval'), INTERVAL_MS);

    _poll = setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        _syncActiveSharedProject(true);
        if (_isLeader && getAccessToken() && !_paused) {
            checkForRemoteUpdates(false).catch(err =>
                console.warn('[SyncEngine] remote poll failed:', err.message)
            );
        }
    }, POLL_MS);

    window.addEventListener('online', () => flush('online'));

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
