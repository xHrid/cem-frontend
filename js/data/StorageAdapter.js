/**
 * StorageAdapter.js — Storage Facade
 *
 * Pattern : Facade
 *           Presents a single, uniform interface over two very different
 *           storage back-ends:
 *             1. Native File System Access API  (desktop Chrome / Edge)
 *             2. IndexedDB                       (mobile, Firefox, Safari fallback)
 *
 * Consumers call the exported functions without knowing which backend is active.
 * All path arguments are forward-slash separated relative strings, e.g.
 *   'ProjectA_abc123/spots/MySpot/images/MySpot_cover.jpg'
 *
 * Bug fixes over original storage_adapter.js
 * -------------------------------------------
 *  1. DB singleton — openDB() no longer reopens the IDB connection on every
 *     operation. The resolved IDBDatabase is cached in _dbInstance.
 *  2. Blob-URL leak — getFileUrl() previously returned freshly created Object
 *     URLs without tracking them. All URLs are now registered in _blobUrls so
 *     revokeObjectUrls() can release them (important on low-memory devices).
 *  3. isInitialized() — callers can check whether initStorage() has completed
 *     before attempting reads/writes.
 */

// ---------------------------------------------------------------------------
// Back-end capability detection
// ---------------------------------------------------------------------------

/** True on Android / iOS devices where showDirectoryPicker should be skipped. */
const isMobile = navigator.userAgentData?.mobile
    ?? /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

/**
 * True when the browser exposes the File System Access API and we are not on
 * a mobile device (where the picker UX is unusable or unavailable).
 */
const HAS_NATIVE_FS = 'showDirectoryPicker' in globalThis && !isMobile;

// ---------------------------------------------------------------------------
// IndexedDB constants & singleton
// ---------------------------------------------------------------------------

const DB_NAME  = 'CEM_Toolkit_DB';
const DB_STORE = 'files';

/**
 * Cached IDBDatabase connection.
 * Populated once by the first call to _openDB() and reused thereafter.
 * @type {IDBDatabase|null}
 */
let _dbInstance = null;

/**
 * Opens (or returns the cached) IndexedDB connection.
 * Bug fix: original called indexedDB.open() on EVERY IDB operation,
 * causing unnecessary overhead and occasional race conditions.
 *
 * @returns {Promise<IDBDatabase>}
 */
function _openDB() {
    if (_dbInstance) return Promise.resolve(_dbInstance);

    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);

        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(DB_STORE)) {
                db.createObjectStore(DB_STORE);
            }
        };

        req.onsuccess = () => {
            _dbInstance = req.result;

            // If the connection is closed externally (e.g. browser upgrade),
            // clear the cache so the next call re-opens cleanly.
            _dbInstance.onclose = () => { _dbInstance = null; };

            resolve(_dbInstance);
        };

        req.onerror = () => reject(req.error);
    });
}

/** Write a Blob/value into IndexedDB under the given key. */
async function _idbSave(key, blob) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        const req = tx.objectStore(DB_STORE).put(blob, key);

        // Surface quota errors with an actionable message instead of the raw,
        // cryptic DOMException. Both the request and the transaction can carry
        // the QuotaExceededError depending on the browser, so handle both.
        const fail = (err) => reject(_mapStorageError(err));
        req.onerror = () => fail(req.error);
        tx.onabort  = () => fail(tx.error);
        tx.onerror  = () => fail(tx.error);
        tx.oncomplete = () => resolve();
    });
}

/**
 * Translate a raw IndexedDB error into a clearer, user-facing Error.
 * A QuotaExceededError on mobile means the browser's per-site storage budget
 * is full (or the app wasn't granted persistent storage).
 *
 * @param {DOMException|Error|null} err
 * @returns {Error}
 */
function _mapStorageError(err) {
    const name = err?.name || '';
    if (name === 'QuotaExceededError' || /quota/i.test(err?.message || '')) {
        return new Error(
            'Device storage is full. Free up space (or remove old projects/media), ' +
            'then try again. On mobile, keeping this site in the browser also helps.'
        );
    }
    return err instanceof Error ? err : new Error(String(err || 'Storage write failed'));
}

/**
 * Ask the browser to make storage persistent (not evictable) and, where
 * supported, this also unlocks a larger quota on mobile. Best-effort and
 * silent — never blocks initialisation.
 *
 * @returns {Promise<void>}
 */
async function _requestPersistentStorage() {
    try {
        if (navigator.storage?.persist && navigator.storage?.persisted) {
            const already = await navigator.storage.persisted();
            if (!already) {
                const granted = await navigator.storage.persist();
                console.log(`[StorageAdapter] Persistent storage ${granted ? 'granted' : 'denied'}.`);
            }
        }
    } catch (e) {
        console.warn('[StorageAdapter] persist() request failed:', e.message);
    }
}

/** Retrieve a value from IndexedDB by key. Returns undefined if absent. */
async function _idbGet(key) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** FileSystemDirectoryHandle for the user-selected root folder (native FS only). */
let _rootHandle  = null;

/**
 * True when Native FS is unavailable or the user cancelled the picker, and we
 * have fallen back to IndexedDB as the virtual filesystem.
 */
let _memoryMode  = false;

/**
 * True once initStorage() has completed successfully.
 * Bug fix: added to satisfy callers that need to guard against premature reads.
 */
let _initialized = false;

/**
 * Registry of all Object URLs created by getFileUrl().
 * Bug fix: original never tracked these, causing memory/handle leaks.
 * @type {string[]}
 */
const _blobUrls  = [];

// ---------------------------------------------------------------------------
// Public API — initialisation
// ---------------------------------------------------------------------------

/**
 * Initialise storage.
 *
 * On capable desktop browsers this opens the native directory picker so the
 * user can choose their project root on the local filesystem.  On mobile (or
 * after a failed picker) it silently falls back to IndexedDB.
 *
 * Must be called (and awaited) before any other export.
 *
 * @returns {Promise<{type: 'native'|'idb', name: string, handle?: FileSystemDirectoryHandle}>}
 * @throws  {DOMException} AbortError if the user cancels the native picker.
 */
export async function initStorage() {
    // Best-effort: lock storage as persistent (and raise the mobile quota).
    await _requestPersistentStorage();

    if (HAS_NATIVE_FS) {
        try {
            _rootHandle  = await window.showDirectoryPicker();
            _memoryMode  = false;
            _initialized = true;
            return { type: 'native', handle: _rootHandle, name: _rootHandle.name };
        } catch (e) {
            // Rethrow user cancellations so the caller can handle them separately.
            if (e.name === 'AbortError') throw e;
            console.warn('StorageAdapter: Native FS failed, falling back to IDB.', e);
        }
    }

    _memoryMode  = true;
    _initialized = true;
    console.log('StorageAdapter: Using IndexedDB (Virtual FS).');
    return { type: 'idb', name: 'Browser Storage' };
}

/**
 * Returns true once initStorage() has completed successfully.
 * Consumers can guard reads/writes with this check.
 *
 * @returns {boolean}
 */
export function isInitialized() {
    return _initialized;
}

/**
 * Report how much of the browser's storage budget is in use.
 *
 * Backed by the Storage API (navigator.storage.estimate). The quota is the
 * browser's per-origin budget — on Chromium/Firefox this is typically a large
 * fraction of free disk (gigabytes); on iOS Safari it is smaller. Returns null
 * fields when the API is unavailable (e.g. older Safari).
 *
 * @returns {Promise<{usage:number|null, quota:number|null, percent:number|null, persisted:boolean}>}
 */
export async function getStorageEstimate() {
    const out = { usage: null, quota: null, percent: null, persisted: false };
    try {
        if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted();
        if (navigator.storage?.estimate) {
            const { usage, quota } = await navigator.storage.estimate();
            out.usage = usage ?? null;
            out.quota = quota ?? null;
            if (usage != null && quota) out.percent = Math.round((usage / quota) * 100);
        }
    } catch (e) {
        console.warn('[StorageAdapter] estimate failed:', e.message);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Public API — master data JSON
// ---------------------------------------------------------------------------

/**
 * Read master_data.json from the root of the storage backend.
 *
 * @returns {Promise<object|null>} Parsed JSON, or null if no file exists yet.
 */
export async function getMasterData() {
    if (!_memoryMode && _rootHandle) {
        try {
            const fh   = await _rootHandle.getFileHandle('master_data.json');
            const file = await fh.getFile();
            return JSON.parse(await file.text());
        } catch {
            return null;
        }
    }

    const blob = await _idbGet('master_data.json');
    if (!blob) return null;
    return JSON.parse(await blob.text());
}

/**
 * Persist an object as master_data.json.
 *
 * @param {object} data  The full masterData state to serialise.
 */
export async function saveMasterData(data) {
    const blob = new Blob(
        [JSON.stringify(data, null, 2)],
        { type: 'application/json' }
    );

    if (!_memoryMode && _rootHandle) {
        const fh       = await _rootHandle.getFileHandle('master_data.json', { create: true });
        const writable = await fh.createWritable();
        await writable.write(blob);
        await writable.close();
    } else {
        await _idbSave('master_data.json', blob);
    }
}

// ---------------------------------------------------------------------------
// Public API — file operations
// ---------------------------------------------------------------------------

/**
 * Save a Blob to the storage backend.
 *
 * @param {Blob}     blob       File contents.
 * @param {string}   filename   File name (no path separators).
 * @param {string[]} pathParts  Directory segments from the project root,
 *                              e.g. ['ProjectA_abc123', 'spots', 'MySpot', 'images'].
 * @returns {Promise<string>}   The canonical relative path used as the storage key.
 */
export async function saveFile(blob, filename, pathParts) {
    // ── Defensive path sanitisation ─────────────────────────────────────
    // Flatten any element that contains backslashes (leaked Windows paths)
    // and reject elements that look like drive letters (C:, E:, etc.)
    // to prevent the File System Access API from silently stripping
    // illegal characters and creating garbled folder names.
    const safeParts = pathParts.flatMap(p => {
        // Normalise backslashes → forward slashes, then split
        const segments = p.replace(/\\/g, '/').split('/').filter(Boolean);
        return segments;
    }).filter(seg => {
        // Drop segments that are bare drive letters like "E:" or "C:"
        if (/^[A-Za-z]:$/.test(seg)) {
            console.warn('[StorageAdapter] Dropped drive-letter segment:', seg);
            return false;
        }
        return true;
    });

    const fullPath = [...safeParts, filename].join('/');

    if (!_memoryMode && _rootHandle) {
        let currentDir = _rootHandle;
        for (const folder of safeParts) {
            currentDir = await currentDir.getDirectoryHandle(folder, { create: true });
        }
        const fh       = await currentDir.getFileHandle(filename, { create: true });
        const writable = await fh.createWritable();
        await writable.write(blob);
        await writable.close();
        return fullPath;
    }

    await _idbSave(fullPath, blob);
    return fullPath;
}

/**
 * Resolve a stored file path to an Object URL suitable for <img>, <audio>, etc.
 *
 * Bug fix: every URL is now registered in _blobUrls so revokeObjectUrls() can
 * release them. Callers should call revokeObjectUrls() when the media is no
 * longer needed (e.g. on view teardown).
 *
 * @param {string|null} relativePath  Storage key / relative path.
 * @returns {Promise<string|null>}    Object URL, or null if the file is absent.
 */
export async function getFileUrl(relativePath) {
    if (!relativePath) return null;

    let objectUrl = null;

    if (!_memoryMode && _rootHandle) {
        try {
            const parts    = relativePath.split('/');
            const filename = parts.pop();
            let currentDir = _rootHandle;
            for (const folder of parts) {
                currentDir = await currentDir.getDirectoryHandle(folder);
            }
            const fh   = await currentDir.getFileHandle(filename);
            const file = await fh.getFile();
            objectUrl  = URL.createObjectURL(file);
        } catch {
            return null;
        }
    } else {
        try {
            const blob = await _idbGet(relativePath);
            if (blob) objectUrl = URL.createObjectURL(blob);
        } catch {
            return null;
        }
    }

    // Register for later cleanup (bug fix).
    if (objectUrl) _blobUrls.push(objectUrl);

    return objectUrl;
}

/**
 * Retrieve the raw Blob for a stored file (no Object URL side-effects).
 *
 * @param {string|null} relativePath
 * @returns {Promise<Blob|File|null>}
 */
export async function getFileBlob(relativePath) {
    if (!relativePath) return null;

    if (!_memoryMode && _rootHandle) {
        try {
            const parts    = relativePath.split('/');
            const filename = parts.pop();
            let currentDir = _rootHandle;
            for (const folder of parts) {
                currentDir = await currentDir.getDirectoryHandle(folder);
            }
            const fh = await currentDir.getFileHandle(filename);
            return await fh.getFile();
        } catch {
            return null;
        }
    }

    return (await _idbGet(relativePath)) ?? null;
}

/**
 * Check whether a file exists in the storage backend without reading its contents.
 *
 * @param {string} relativePath
 * @returns {Promise<boolean>}
 */
export async function checkFileExists(relativePath) {
    if (!_memoryMode && _rootHandle) {
        try {
            const parts    = relativePath.split('/');
            const filename = parts.pop();
            let currentDir = _rootHandle;
            for (const folder of parts) {
                currentDir = await currentDir.getDirectoryHandle(folder);
            }
            await currentDir.getFileHandle(filename);
            return true;
        } catch {
            return false;
        }
    }

    const blob = await _idbGet(relativePath);
    return blob !== undefined && blob !== null;
}

/**
 * List the file names (not subdirectory names) directly inside a given folder.
 *
 * Returns an empty array instead of throwing if the folder does not exist yet
 * (common on first run before any data has been written to that path).
 *
 * @param {string[]} pathParts  Directory segments from the project root.
 * @returns {Promise<string[]>} Bare file names in that directory.
 */
export async function listDirectoryFiles(pathParts) {
    if (!_memoryMode && _rootHandle) {
        try {
            let currentDir = _rootHandle;
            for (const folder of pathParts) {
                currentDir = await currentDir.getDirectoryHandle(folder);
            }
            const files = [];
            for await (const [name, handle] of currentDir.entries()) {
                if (handle.kind === 'file') files.push(name);
            }
            return files;
        } catch {
            // Folder doesn't exist yet — safe to return empty.
            return [];
        }
    }

    // IDB path: scan all keys for a matching prefix at exactly one depth level.
    const db = await _openDB();
    return new Promise((resolve) => {
        const tx  = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).getAllKeys();
        req.onsuccess = () => {
            const prefix = pathParts.join('/') + '/';
            const files  = req.result
                .filter(k =>
                    k.startsWith(prefix) &&
                    !k.substring(prefix.length).includes('/')
                )
                .map(k => k.substring(prefix.length));
            resolve(files);
        };
        req.onerror = () => resolve([]);
    });
}

/**
 * List EVERY stored file path in the active backend (recursively for native FS,
 * all keys for IndexedDB). Used by the storage garbage collector to find files
 * no project references anymore.
 *
 * @returns {Promise<string[]>}  All relative file paths / keys.
 */
export async function listAllFileKeys() {
    if (!_memoryMode && _rootHandle) {
        const out = [];
        await _walkNative(_rootHandle, '', out);
        return out;
    }
    const db = await _openDB();
    return new Promise((resolve) => {
        const tx  = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).getAllKeys();
        req.onsuccess = () => resolve(req.result.map(String));
        req.onerror   = () => resolve([]);
    });
}

/** Recursively collect file paths under a native-FS directory handle. */
async function _walkNative(dirHandle, prefix, out) {
    try {
        for await (const [name, handle] of dirHandle.entries()) {
            const path = prefix ? `${prefix}/${name}` : name;
            if (handle.kind === 'file') out.push(path);
            else await _walkNative(handle, path, out);
        }
    } catch { /* unreadable dir — skip */ }
}

// ---------------------------------------------------------------------------
// Public API — file deletion
// ---------------------------------------------------------------------------

/**
 * Delete a file from the storage backend by its relative path.
 *
 * @param {string} relativePath  The storage key / relative path of the file.
 * @returns {Promise<boolean>}   True if the file was found and deleted.
 */
export async function deleteFile(relativePath) {
    if (!relativePath) return false;

    if (!_memoryMode && _rootHandle) {
        try {
            const parts    = relativePath.split('/');
            const filename = parts.pop();
            let currentDir = _rootHandle;
            for (const folder of parts) {
                currentDir = await currentDir.getDirectoryHandle(folder);
            }
            await currentDir.removeEntry(filename);
            return true;
        } catch {
            return false;
        }
    }

    // IDB path: delete the key
    try {
        const db = await _openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).delete(relativePath);
            tx.oncomplete = () => resolve(true);
            tx.onerror    = () => reject(tx.error);
        });
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Public API — memory management
// ---------------------------------------------------------------------------

/**
 * Revoke all Object URLs that were created by getFileUrl().
 *
 * Bug fix: the original module never revoked URLs, causing the browser to hold
 * Blob handles until the page unloaded. Call this whenever a media-heavy view
 * is torn down, or on a periodic GC tick.
 */
export function revokeObjectUrls() {
    _blobUrls.forEach(url => URL.revokeObjectURL(url));
    _blobUrls.length = 0; // Clear the array in-place, preserving the reference.
}
