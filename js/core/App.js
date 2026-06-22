import EventBus, { EVENTS } from './EventBus.js';
import Config               from './Config.js';

import { initAuth, requestLogin }      from '../services/AuthService.js';
import { initStorage, checkFileExists, saveFile, getStorageEstimate } from '../data/StorageAdapter.js';
import { ensureMasterJson }            from '../data/MasterData.js';
import { initSyncEngine, onAuthReady } from '../services/SyncEngine.js';
import { initSyncPanel }               from '../ui/SyncPanel.js';
import { initSharedMediaSync }         from '../services/SharedMediaSync.js';

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

    if (driveControls && Config.google.clientId) {
        driveControls.style.display = 'flex';
    }

    _enableAppControls();

    EventBus.emit(EVENTS.STORAGE_READY, storageInfo);
    EventBus.emit(EVENTS.DATA_UPDATED,  null);
}

function _enableAppControls() {
    const wrapper = document.getElementById('app-controls');
    if (!wrapper) return;
    wrapper.classList.remove('app-controls-disabled');
    wrapper.querySelectorAll('button, select, input').forEach(el => {
        el.disabled = false;
    });
}

function _fmtBytes(n) {
    if (!n && n !== 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

async function _ensureWatcherScript() {
    try {
        const exists = await checkFileExists('watcher.py');
        if (!exists) {
            const response = await fetch('./watcher.py');
            if (!response.ok) throw new Error(`Server returned ${response.status}`);
            const pythonCode = await response.text();
            const blob = new Blob([pythonCode], { type: 'text/plain' });
            await saveFile(blob, 'watcher.py', []);
        }
    } catch (e) {
        console.warn('[App] Could not inject watcher.py:', e);
    }
}

async function _handleSelectStorage() {
    try {
        const storageInfo = await initStorage();
        await ensureMasterJson();
        await _ensureWatcherScript();
        _onStorageReady(storageInfo);
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('[App] Storage initialisation failed:', error);
            EventBus.emit(EVENTS.TOAST_SHOW, {
                message: `Storage initialisation failed: ${error.message}`,
                type: 'error',
            });
        }
    }
}

function _onAuthSuccess() {
    const btnLogin = document.getElementById('btn-login');
    const syncPill = document.getElementById('btn-sync-pill');

    if (btnLogin) btnLogin.style.display = 'none';
    if (syncPill) syncPill.style.display = 'block';

    onAuthReady();
}

function _bindUIEvents() {
    document.getElementById('btn-select-storage')
        ?.addEventListener('click', _handleSelectStorage);

    document.getElementById('btn-login')
        ?.addEventListener('click', () => requestLogin());

}

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

export function initApp() {
    const authSection = document.getElementById('auth-section');
    if (!authSection) {
        console.warn('[App] #auth-section not found in DOM — aborting initApp.');
        return;
    }

    _renderAuthPanel(authSection);
    _bindUIEvents();

    _initAuthWhenReady(_onAuthSuccess);

    initSyncEngine();

    initSyncPanel();

    initSharedMediaSync();

}
