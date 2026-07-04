const isMobile = navigator.userAgentData?.mobile
    ?? /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

const HAS_NATIVE_FS = 'showDirectoryPicker' in globalThis && !isMobile;

const DB_NAME  = 'CEM_Toolkit_DB';
const DB_STORE = 'files';

let _dbInstance = null;
let _dbOpening = null;

function _openDB() {
    if (_dbInstance) return Promise.resolve(_dbInstance);
    if (_dbOpening)  return _dbOpening;

    _dbOpening = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);

        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(DB_STORE)) {
                db.createObjectStore(DB_STORE);
            }
        };

        req.onsuccess = () => {
            _dbInstance = req.result;
            _dbInstance.onclose = () => { _dbInstance = null; };
            resolve(_dbInstance);
        };

        req.onerror = () => reject(req.error);
    }).finally(() => { _dbOpening = null; });

    return _dbOpening;
}

async function _idbSave(key, blob) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        const req = tx.objectStore(DB_STORE).put(blob, key);

        const fail = (err) => reject(_mapStorageError(err));
        req.onerror = () => fail(req.error);
        tx.onabort  = () => fail(tx.error);
        tx.onerror  = () => fail(tx.error);
        tx.oncomplete = () => resolve();
    });
}

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

async function _requestPersistentStorage() {
    try {
        if (navigator.storage?.persist && navigator.storage?.persisted) {
            const already = await navigator.storage.persisted();
            if (!already) {
                const granted = await navigator.storage.persist();
            }
        }
    } catch (e) {
        console.warn('[StorageAdapter] persist() request failed:', e.message);
    }
}

async function _idbGet(key) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
        const tx  = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

let _rootHandle  = null;

let _memoryMode  = false;

let _initialized = false;

const _blobUrls  = [];

export async function initStorage() {
    if (HAS_NATIVE_FS) {
        try {
            _rootHandle  = await window.showDirectoryPicker();
            _memoryMode  = false;
            _initialized = true;
            return { type: 'native', handle: _rootHandle, name: _rootHandle.name };
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            console.warn('StorageAdapter: Native FS failed, falling back to IDB.', e);
        }
    }

    await _requestPersistentStorage();

    _memoryMode  = true;
    _initialized = true;
    return { type: 'idb', name: 'Browser Storage' };
}

export function isInitialized() {
    return _initialized;
}

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

let _lastGoodMasterText = null;

function _isEmptyMaster(data) {
    const projects = data?.projects || [];
    return projects.every(p =>
        !(p.spots?.length || p.sites?.length || p.routes?.length ||
          p.external_files?.length || p.jobs?.length)
    );
}

async function _writeRootFile(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    if (!_memoryMode && _rootHandle) {
        const fh       = await _rootHandle.getFileHandle(filename, { create: true });
        const writable = await fh.createWritable();
        await writable.write(blob);
        await writable.close();
    } else {
        await _idbSave(filename, blob);
    }
}

async function _backupCorruptMaster(text) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name  = `master_data.corrupt-${stamp}.json`;
    try {
        await _writeRootFile(name, text);
        console.warn(`[StorageAdapter] Backed up unreadable/at-risk master to ${name}`);
    } catch (e) {
        console.error('[StorageAdapter] Could not back up master data:', e);
    }
    return name;
}

// Returns null ONLY when the file is genuinely absent. An IO or parse failure
// throws (after backing up the raw bytes), so callers can never mistake a
// corrupt master for a missing one and overwrite it with an empty state.
export async function getMasterData() {
    let text;

    if (!_memoryMode && _rootHandle) {
        let file = null;
        try {
            const fh = await _rootHandle.getFileHandle('master_data.json');
            file = await fh.getFile();
        } catch (e) {
            if (e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError') return null;
            throw new Error(`Could not read master_data.json: ${e?.message || e}`);
        }
        text = await file.text();
    } else {
        const blob = await _idbGet('master_data.json');
        if (blob === undefined || blob === null) return null;
        text = await blob.text();
    }

    try {
        const data = JSON.parse(text);
        _lastGoodMasterText = text;
        return data;
    } catch {
        const backup = await _backupCorruptMaster(text);
        throw new Error(
            `master_data.json is corrupt and was NOT overwritten. ` +
            `The raw content was backed up as ${backup}.`
        );
    }
}

export async function saveMasterData(data) {
    const text = JSON.stringify(data, null, 2);

    // Losing all items between two writes means either a legitimate wipe or a
    // bug upstream; keep the last non-empty snapshot either way.
    if (_lastGoodMasterText && _isEmptyMaster(data)) {
        try {
            if (!_isEmptyMaster(JSON.parse(_lastGoodMasterText))) {
                await _backupCorruptMaster(_lastGoodMasterText);
            }
        } catch { }
    }

    await _writeRootFile('master_data.json', text);
    _lastGoodMasterText = text;
}

export async function saveFile(blob, filename, pathParts) {
    const safeParts = pathParts.flatMap(p => {
        const segments = p.replace(/\\/g, '/').split('/').filter(Boolean);
        return segments;
    }).filter(seg => {
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

    if (objectUrl) _blobUrls.push(objectUrl);

    return objectUrl;
}

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
            return [];
        }
    }

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

async function _walkNative(dirHandle, prefix, out) {
    try {
        for await (const [name, handle] of dirHandle.entries()) {
            const path = prefix ? `${prefix}/${name}` : name;
            if (handle.kind === 'file') out.push(path);
            else await _walkNative(handle, path, out);
        }
    } catch { }
}

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

    try {
        const db = await _openDB();
        return await new Promise((resolve) => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).delete(relativePath);
            tx.oncomplete = () => resolve(true);
            tx.onerror    = () => resolve(false);
            tx.onabort    = () => resolve(false);
        });
    } catch {
        return false;
    }
}

export function revokeObjectUrls() {
    _blobUrls.forEach(url => URL.revokeObjectURL(url));
    _blobUrls.length = 0;
}
