/**
 * EventBus.js — Application-wide event system
 *
 * Pattern : Observer / Publish-Subscribe
 *           Combined with the Module Pattern to produce a
 *           frozen singleton that replaces all scattered
 *           `window.dispatchEvent(new Event(...))` / `window.addEventListener`
 *           calls across the codebase.
 *
 * Usage:
 *   import EventBus, { EVENTS } from './core/EventBus.js';
 *   EventBus.on(EVENTS.DATA_UPDATED, ({ data }) => renderMap(data));
 *   EventBus.emit(EVENTS.DATA_UPDATED, { spots: [...] });
 */

// ---------------------------------------------------------------------------
// Named event-type constants
// Centralising these here prevents typos and makes rename-refactors trivial.
// ---------------------------------------------------------------------------

export const EVENTS = Object.freeze({
    /** IndexedDB / native-FS adapter is open and ready. */
    STORAGE_READY: 'storage-ready',

    /** masterData has changed (spots/routes/sites/files written or pulled). */
    DATA_UPDATED: 'data-updated',

    /** Active project switched OR projects list mutated. */
    PROJECT_CHANGED: 'project-changed',

    /** Single-file Drive upload progress tick from media_sync. */
    SYNC_PROGRESS: 'sync-progress',

    /** A batch of Drive uploads has finished. */
    SYNC_BATCH_COMPLETE: 'sync-batch-complete',

    /** Remote master_data.json differs from local; UI should prompt resolution. */
    MASTER_SYNC_CONFLICT: 'master-sync-conflict',

    /** watcher.py heartbeat status has changed (running / stale / absent). */
    WATCHER_STATUS_CHANGED: 'watcher-status-changed',

    /** Map layer toggled: show or hide observation spots. */
    SPOTS_DISPLAY_TOGGLE: 'spots-display-toggle',

    /** Request a transient toast notification. data: { message, type? } */
    TOAST_SHOW: 'toast-show',

    /** Project successfully shared with collaborators. data: { projectId, emails } */
    PROJECT_SHARED: 'project-shared',

    /** A shared project was imported into local state. data: { projectId, sourceFolderId } */
    PROJECT_IMPORTED: 'project-imported',

    /** An imported shared project was synced with its source. data: { projectId } */
    SHARED_PROJECT_SYNCED: 'shared-project-synced',

    /** A media file was saved locally and should be synced. data: { projectId, relPath, isExternal } */
    MEDIA_SAVED: 'media-saved',

    /** SyncEngine state changed. data: { status: 'idle'|'syncing'|'offline'|'error', importedMedia: boolean, pending?: number } */
    SYNC_STATUS: 'sync-status',

    /** User enabled imported-media sync — scan & push external files now. */
    SYNC_IMPORTED_MEDIA_ENABLED: 'sync-imported-media-enabled',
});

// ---------------------------------------------------------------------------
// Dev-mode flag
// Set localStorage.debug = '1' in the browser console to enable event logging.
// ---------------------------------------------------------------------------
const DEV = (typeof localStorage !== 'undefined' && localStorage.getItem('debug') === '1');

// ---------------------------------------------------------------------------
// Singleton EventBus (Module Pattern — IIFE returns a frozen object)
// ---------------------------------------------------------------------------

const EventBus = (() => {
    /**
     * Internal subscriber registry.
     * Shape: Map<eventType: string, Set<callback: Function>>
     * The wildcard key '*' holds subscribers that receive every event.
     */
    const _subscribers = new Map();

    /**
     * Retrieve or lazily create the Set for a given event type.
     * @param {string} eventType
     * @returns {Set<Function>}
     */
    function _getOrCreate(eventType) {
        if (!_subscribers.has(eventType)) {
            _subscribers.set(eventType, new Set());
        }
        return _subscribers.get(eventType);
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Subscribe to an event.
     *
     * Guards against duplicate subscriptions — registering the same function
     * reference twice for the same event type is a no-op.
     *
     * @param {string}   eventType  One of EVENTS.* or '*' for all events.
     * @param {Function} callback   Invoked with `{ type, data, timestamp }`.
     * @returns {Function}          Unsubscribe helper: call it to remove the listener.
     */
    function on(eventType, callback) {
        if (typeof callback !== 'function') {
            console.warn(`[EventBus] on("${eventType}"): callback must be a function.`);
            return () => {};
        }
        _getOrCreate(eventType).add(callback);
        if (DEV) {
            console.debug(`[EventBus] on("${eventType}") — subscribers: ${_getOrCreate(eventType).size}`);
        }
        // Return a convenience unsubscribe handle
        return () => off(eventType, callback);
    }

    /**
     * Unsubscribe a previously registered callback.
     *
     * Silent no-op if the callback was never registered.
     *
     * @param {string}   eventType
     * @param {Function} callback
     */
    function off(eventType, callback) {
        const set = _subscribers.get(eventType);
        if (!set) return;
        set.delete(callback);
        if (DEV) {
            console.debug(`[EventBus] off("${eventType}") — subscribers: ${set.size}`);
        }
    }

    /**
     * Publish an event.
     *
     * All subscribers for `eventType` are invoked first, then all wildcard ('*')
     * subscribers. Each callback receives a single envelope object:
     *   { type: string, data: any, timestamp: string }
     *
     * Errors thrown inside callbacks are caught and logged so one bad handler
     * can never silence subsequent handlers.
     *
     * @param {string} eventType  One of EVENTS.*
     * @param {*}      [data]     Arbitrary payload passed through to subscribers.
     */
    function emit(eventType, data) {
        const envelope = Object.freeze({
            type: eventType,
            data,
            timestamp: new Date().toISOString(),
        });

        if (DEV) {
            console.debug(`[EventBus] emit("${eventType}")`, data ?? '');
        }

        // Notify specific-type subscribers
        const specific = _subscribers.get(eventType);
        if (specific) {
            for (const cb of specific) {
                try { cb(envelope); } catch (err) {
                    console.error(`[EventBus] Error in subscriber for "${eventType}":`, err);
                }
            }
        }

        // Notify wildcard subscribers (skip duplicates if a fn subscribed to both)
        const wildcards = _subscribers.get('*');
        if (wildcards) {
            for (const cb of wildcards) {
                if (specific?.has(cb)) continue;
                try { cb(envelope); } catch (err) {
                    console.error(`[EventBus] Error in wildcard subscriber:`, err);
                }
            }
        }
    }

    // Return the public surface and immediately freeze it so no external code
    // can mutate or monkey-patch the bus.
    return Object.freeze({ on, off, emit });
})();

export default EventBus;
