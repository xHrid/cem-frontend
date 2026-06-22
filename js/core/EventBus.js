export const EVENTS = Object.freeze({
    STORAGE_READY: 'storage-ready',
    DATA_UPDATED: 'data-updated',
    PROJECT_CHANGED: 'project-changed',
    SYNC_PROGRESS: 'sync-progress',
    SYNC_BATCH_COMPLETE: 'sync-batch-complete',
    MASTER_SYNC_CONFLICT: 'master-sync-conflict',
    WATCHER_STATUS_CHANGED: 'watcher-status-changed',
    SPOTS_DISPLAY_TOGGLE: 'spots-display-toggle',
    TOAST_SHOW: 'toast-show',
    PROJECT_SHARED: 'project-shared',
    PROJECT_IMPORTED: 'project-imported',
    SHARED_PROJECT_SYNCED: 'shared-project-synced',
    MEDIA_SAVED: 'media-saved',
    SYNC_STATUS: 'sync-status',
    SYNC_IMPORTED_MEDIA_ENABLED: 'sync-imported-media-enabled',
});

const DEV = (typeof localStorage !== 'undefined' && localStorage.getItem('debug') === '1');

const EventBus = (() => {
    const _subscribers = new Map();

    function _getOrCreate(eventType) {
        if (!_subscribers.has(eventType)) _subscribers.set(eventType, new Set());
        return _subscribers.get(eventType);
    }

    function on(eventType, callback) {
        if (typeof callback !== 'function') {
            console.warn(`[EventBus] on("${eventType}"): callback must be a function.`);
            return () => {};
        }
        _getOrCreate(eventType).add(callback);
        return () => off(eventType, callback);
    }

    function off(eventType, callback) {
        const set = _subscribers.get(eventType);
        if (set) set.delete(callback);
    }

    function emit(eventType, data) {
        const envelope = Object.freeze({ type: eventType, data, timestamp: new Date().toISOString() });
        if (DEV) ;

        const specific = _subscribers.get(eventType);
        if (specific) {
            for (const cb of specific) {
                try { cb(envelope); } catch (err) {
                    console.error(`[EventBus] Error in subscriber for "${eventType}":`, err);
                }
            }
        }

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

    return Object.freeze({ on, off, emit });
})();

export default EventBus;
