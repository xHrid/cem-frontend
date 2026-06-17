/**
 * AnalysisUI.js — Analysis popup UI controller
 *
 * Pattern : Module Pattern
 *           All DOM references and interval handles are private to this module.
 *           AnalysisService provides the pure business logic; this module owns
 *           only the rendering and event wiring.
 *
 * Extracted from analysis.js which mixed DOM manipulation and data logic.
 *
 * Bug fixes over analysis.js
 * --------------------------
 *  1. DOM element cache (`els`) populated LAZILY on first popup open, not at
 *     module parse time — avoids null refs if the popup HTML is not yet in
 *     the DOM when the script loads.
 *  2. `renderSpotDateSelector` previously called
 *     `els.fileSelector.addEventListener('change', ...)` on EVERY script
 *     selection, stacking multiple listeners.  Now a SINGLE delegated listener
 *     is registered once on `els.fileSelector` (in _initFileSelectorListener).
 *  3. `statusIndicator` colour is applied to `style.color` (the ● text
 *     character) instead of `style.backgroundColor` (which coloured the
 *     surrounding box, not the dot itself).
 *  4. `heartbeatInterval` is cleared when the popup closes — previously the
 *     setInterval could keep running in the background after close.
 *
 * Dependencies
 * ------------
 *   EventBus, EVENTS   — ../core/EventBus.js
 *   AnalysisService    — ../services/AnalysisService.js
 *   MasterData         — ../data/MasterData.js  (getSpots, getExternalFiles)
 *   Repository         — ../data/Repository.js  (getProcessedFilesCache,
 *                                                getWatcherStatus,
 *                                                getInstalledScripts)
 *   showToast          — ./Toast.js
 */

import Config                       from '../core/Config.js';
import EventBus, { EVENTS }        from '../core/EventBus.js';
import {
    getWatcherOnlineStatus,
    loadInstalledScripts,
    buildJobData,
    queueJob,
}                                   from '../services/AnalysisService.js';
import {
    isConfigured       as serverConfigured,
    getServerConfig,
    checkServerHealth,
    getServerSteps,
    runJobOnServer,
}                                   from '../services/ServerService.js';
import {
    checkProjectFiles,
    uploadAudioFiles,
    uploadAggregate,
    uploadProcessed,
}                                   from '../services/ServerUploadService.js';
import { getSpots, getExternalFiles, getActiveProject } from '../data/MasterData.js';
import { getProjectFolderName } from '../data/projectUtils.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import { getWatcherStatus } from '../data/Repository.js';
import { showToast }                from './Toast.js';
import { openModal, closeModal }    from './ModalManager.js';

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

/**
 * Lazily populated DOM element cache.
 * All values are null until _cacheElements() is called on first popup open.
 * @type {object}
 */
const els = {
    popup          : null,
    statusIndicator: null,
    statusText     : null,
    runBtn         : null,
    closeBtn       : null,
    scriptSelect   : null,
    fileSelector   : null,
    dynamicForm    : null,
    paramsContainer: null,
    jobNameInput   : null,
};

/** True once _cacheElements() has resolved all element refs. */
let _elsCached = false;

/** The currently selected script descriptor object from installed.json. */
let _currentScript = null;

/** setInterval handle for the watcher heartbeat poll. Cleared on popup close. */
let _heartbeatInterval = null;

/**
 * Guard flag: the delegated change listener on els.fileSelector is registered
 * only once, regardless of how many times the popup is opened.
 */
let _fileSelectorListenerAttached = false;

/** Compute backend: false = local watcher (default), true = lab server. */
let _serverMode = false;

/**
 * True while a server job is uploading/running/downloading. Suppresses the
 * heartbeat from overwriting the live progress text in the status pill.
 */
let _runningServerJob = false;

// ---------------------------------------------------------------------------
// DOM element cache — lazy init
// ---------------------------------------------------------------------------

/**
 * Populate the `els` cache from the live DOM.
 * Called on the first popup open so all elements are guaranteed to exist.
 *
 * @private
 */
function _cacheElements() {
    if (_elsCached) return;

    els.popup           = document.getElementById('analysis-popup');
    els.statusIndicator = document.getElementById('watcher-indicator');
    els.statusText      = document.getElementById('watcher-status-text');
    els.runBtn          = document.getElementById('btn-run-analysis');
    els.closeBtn        = document.getElementById('close-analysis-btn');
    els.scriptSelect    = document.getElementById('analysis-script-select');
    els.fileSelector    = document.getElementById('analysis-file-selector');
    els.dynamicForm     = document.getElementById('analysis-dynamic-form');
    els.paramsContainer = document.getElementById('dynamic-params-container');
    els.jobNameInput    = document.getElementById('analysis-job-name');

    _elsCached = true;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Wire up the analysis popup open/close triggers, run button, and script
 * selector.  Must be called once after DOMContentLoaded.
 */
export function initAnalysis() {
    const openBtn = document.getElementById('analysis-btn');

    if (openBtn) {
        openBtn.addEventListener('click', () => {
            // Lazily resolve DOM refs on first open
            _cacheElements();

            openModal('analysis-popup');

            // Reset form state
            if (els.jobNameInput)    els.jobNameInput.value = '';
            if (els.fileSelector)    els.fileSelector.innerHTML =
                '<p style="padding:10px; color:var(--text-muted);">Select a script first...</p>';
            if (els.dynamicForm)     els.dynamicForm.innerHTML = '';
            if (els.paramsContainer) els.paramsContainer.style.display = 'none';

            _currentScript = null;

            // Attach the single delegated file-selector listener (idempotent)
            _initFileSelectorListener();

            _applyModeStyles();
            _checkStatus();
            _loadScripts();
            _startHeartbeat();
        });
    }

    // Compute-mode toggle (Local Watcher vs Lab Server) — delegated.
    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest && e.target.closest('.analysis-mode-btn');
        if (btn) _setMode(btn.dataset.mode);
    });

    // Close button — also stops the heartbeat
    document.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'close-analysis-btn') {
            _cacheElements();
            closeModal('analysis-popup');
            _stopHeartbeat();
        }
    });

    // Run button
    document.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'btn-run-analysis') {
            _handleRunClick();
        }
    });

    // Script selector change
    document.addEventListener('change', (e) => {
        if (e.target && e.target.id === 'analysis-script-select') {
            _loadScriptParams(e.target.value);
        }
    });

    // ── Server Upload Panel — delegated listeners ──────────────────────────
    document.addEventListener('click', (e) => {
        const uploadBtn = e.target && e.target.closest && e.target.closest('.server-upload-btn');
        if (uploadBtn) {
            _handleServerUpload(uploadBtn.dataset.category, false);
            return;
        }
        const overrideBtn = e.target && e.target.closest && e.target.closest('.server-override-btn');
        if (overrideBtn) {
            _handleServerUpload(overrideBtn.dataset.category, true);
        }
    });

    // Audio spot dropdown → enable/disable upload trigger
    const spotSelect = document.getElementById('audio-spot-select');
    const audioTrigger = document.getElementById('audio-upload-trigger');
    if (spotSelect && audioTrigger) {
        spotSelect.addEventListener('change', () => {
            audioTrigger.disabled = !spotSelect.value;
        });
        // Click trigger → open file picker
        audioTrigger.addEventListener('click', () => {
            const fileInput = document.getElementById('upload-audio-input');
            if (fileInput) { fileInput.value = ''; fileInput.click(); }
        });
    }

    // Audio file input change (from file picker)
    const audioInput = document.getElementById('upload-audio-input');
    if (audioInput) {
        audioInput.addEventListener('change', _handleAudioFileSelected);
    }
}

// ---------------------------------------------------------------------------
// Heartbeat — watcher status polling
// ---------------------------------------------------------------------------

/**
 * Start polling the watcher status every 3 s.
 * Clears any previous interval first to avoid stacked polls.
 * @private
 */
function _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatInterval = setInterval(_checkStatus, 3000);
}

/**
 * Stop the heartbeat poll and clear the interval handle.
 * @private
 */
function _stopHeartbeat() {
    if (_heartbeatInterval) {
        clearInterval(_heartbeatInterval);
        _heartbeatInterval = null;
    }
}

// ---------------------------------------------------------------------------
// Compute-mode toggle (Local Watcher vs Lab Server)
// ---------------------------------------------------------------------------

/**
 * Switch the active compute backend and refresh status + script list.
 * @param {'watcher'|'server'} mode
 * @private
 */
function _setMode(mode) {
    const next = mode === 'server';
    if (next === _serverMode) return;
    _serverMode = next;
    if (!next) _serverFileStatus = null;   // clear cached status when leaving server mode
    _applyModeStyles();
    // Reset the script dropdown so it reloads from the right source.
    if (els.scriptSelect) els.scriptSelect.innerHTML = '<option value="">Loading scripts...</option>';
    _currentScript = null;
    if (els.fileSelector) els.fileSelector.innerHTML =
        '<p style="padding:10px; color:var(--text-muted);">Select a script first...</p>';
    if (els.paramsContainer) els.paramsContainer.style.display = 'none';
    if (els.runBtn) { els.runBtn.dataset.formReady = 'false'; els.runBtn.disabled = true; }
    _checkStatus();
    _loadScripts();
}

/**
 * Reflect the active mode in the toggle buttons + contextual help boxes.
 * @private
 */
function _applyModeStyles() {
    document.querySelectorAll('.analysis-mode-btn').forEach(btn => {
        const active = (btn.dataset.mode === 'server') === _serverMode;
        btn.style.background = active ? 'var(--accent-blue)' : 'var(--bg-surface-alt)';
        btn.style.color      = active ? '#fff' : 'var(--text-dark)';
    });

    const serverHelp  = document.getElementById('server-help');
    const watcherHelp = document.getElementById('watcher-offline-help');
    const uploadPanel = document.getElementById('server-upload-panel');
    if (serverHelp)  serverHelp.style.display  = _serverMode ? 'block' : 'none';
    if (uploadPanel) uploadPanel.style.display  = _serverMode ? 'block' : 'none';
    // The watcher-offline help is only ever relevant in watcher mode; its own
    // visibility within watcher mode is still driven by _checkStatus.
    if (watcherHelp && _serverMode) watcherHelp.style.display = 'none';

    // Auto-check server file status when entering server mode
    if (_serverMode && serverConfigured()) {
        _refreshServerUploadStatus();
    }
}

// ---------------------------------------------------------------------------
// Server Upload Panel — status check + upload handlers
// ---------------------------------------------------------------------------

/** Cached server file status to avoid redundant fetches. */
let _serverFileStatus = null;

/**
 * Query the server for existing project files, detect local files,
 * and update all 3 upload slots.
 * @private
 */
async function _refreshServerUploadStatus() {
    const msgEl = document.getElementById('server-upload-status-msg');
    if (msgEl) msgEl.textContent = 'Checking server…';

    try {
        _serverFileStatus = await checkProjectFiles();
        await _renderUploadSlots(_serverFileStatus);
        if (msgEl) msgEl.textContent = '';
    } catch (e) {
        if (msgEl) msgEl.textContent = `Could not reach server: ${e.message}`;
        _serverFileStatus = null;
    }
}

/**
 * Populate the audio spot dropdown from the project's spots.
 * @private
 */
function _populateAudioSpotDropdown() {
    const select = document.getElementById('audio-spot-select');
    if (!select) return;
    const spots = getSpots();
    select.innerHTML = '<option value="">Select spot…</option>';
    spots.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name.replace(/\s+/g, '').toUpperCase();
        opt.textContent = s.name;
        opt.dataset.spotId = s.spotId;
        select.appendChild(opt);
    });
}

/**
 * Check if a file exists in local storage (IndexedDB / native FS).
 * @param {string} path  Relative storage path
 * @returns {Promise<boolean>}
 * @private
 */
async function _localFileExists(path) {
    try {
        const blob = await StorageAdapter.getFileBlob(path);
        return blob != null && blob.size > 0;
    } catch {
        return false;
    }
}

/**
 * Build a clickable link that opens a locally-stored file in a new tab.
 * @param {string} storagePath  Relative path in StorageAdapter
 * @param {string} label        Visible link text
 * @returns {HTMLAnchorElement}
 */
function _makeLocalFileLink(storagePath, label) {
    const a = document.createElement('a');
    a.textContent = label;
    a.href = '#';
    a.style.cssText = 'color:#0b5394; text-decoration:underline; cursor:pointer;';
    a.addEventListener('click', async (e) => {
        e.preventDefault();
        const url = await StorageAdapter.getFileUrl(storagePath);
        if (url) {
            window.open(url, '_blank');
        } else {
            showToast('Could not open file.', 'failed');
        }
    });
    return a;
}

/**
 * Update all 3 file slot UI elements based on server + local status.
 * @param {object} status  Response from checkProjectFiles()
 * @private
 */
async function _renderUploadSlots(status) {
    // Populate spot dropdown
    _populateAudioSpotDropdown();

    // ── Audio ──
    const audioInfo = document.getElementById('slot-audio-info');
    const totalAudio = status.total_audio || 0;
    const spotNames = status.spots ? Object.keys(status.spots) : [];
    if (audioInfo) {
        if (totalAudio > 0) {
            audioInfo.textContent = `${totalAudio} file(s) on server (${spotNames.length} spot${spotNames.length !== 1 ? 's' : ''})`;
            audioInfo.style.color = '#28a745';
        } else {
            audioInfo.textContent = 'No audio on server yet';
            audioInfo.style.color = 'var(--text-muted)';
        }
    }

    // ── Aggregate: check local + server ──
    const project = getActiveProject();
    const pf = project ? getProjectFolderName(project) : '';

    const aggInfo    = document.getElementById('slot-aggregate-info');
    const aggLocal   = document.getElementById('slot-aggregate-local');
    const aggUpload  = document.querySelector('#slot-aggregate .server-upload-btn');
    const aggOverride = document.querySelector('#slot-aggregate .server-override-btn');

    if (aggInfo && pf) {
        const serverAggPath = `${pf}/system/database/birdnet_results_server.csv`;
        const localAggPath  = `${pf}/system/database/birdnet_results.csv`;
        const hasServerLocal = await _localFileExists(serverAggPath);
        const hasLocalAgg    = hasServerLocal || await _localFileExists(localAggPath);

        const aggFilePath = hasServerLocal ? serverAggPath : localAggPath;

        if (status.has_aggregate) {
            aggInfo.textContent = '✓ On server';
            aggInfo.style.color = '#28a745';
            if (aggUpload)   aggUpload.style.display = 'none';
            if (aggOverride) aggOverride.style.display = 'inline-block';
            if (aggLocal) {
                aggLocal.innerHTML = '';
                if (hasLocalAgg) {
                    aggLocal.appendChild(_makeLocalFileLink(aggFilePath, '📁 View local copy'));
                }
            }
        } else if (hasLocalAgg) {
            aggInfo.textContent = 'Not on server';
            aggInfo.style.color = '#dc3545';
            if (aggLocal) {
                aggLocal.innerHTML = '';
                aggLocal.appendChild(_makeLocalFileLink(aggFilePath, '📁 Found locally — view file'));
            }
            if (aggUpload)  { aggUpload.style.display = 'inline-block'; aggUpload.textContent = 'Upload to Server'; }
            if (aggOverride) aggOverride.style.display = 'none';
        } else {
            aggInfo.textContent = 'Not found';
            aggInfo.style.color = 'var(--text-muted)';
            if (aggLocal)    aggLocal.textContent = 'Run BirdNET first to generate this file';
            if (aggUpload)   aggUpload.style.display = 'none';
            if (aggOverride) aggOverride.style.display = 'none';
        }
    }

    // ── Processed: check local + server ──
    const procInfo    = document.getElementById('slot-processed-info');
    const procLocal   = document.getElementById('slot-processed-local');
    const procUpload  = document.querySelector('#slot-processed .server-upload-btn');
    const procOverride = document.querySelector('#slot-processed .server-override-btn');

    if (procInfo && pf) {
        const scriptFile = _currentScript?.script_file || 'birdnet_predictions.py';
        const serverProcPath = `${pf}/system/database/processed_${scriptFile}_server.txt`;
        const localProcPath  = `${pf}/system/database/processed_${scriptFile}.txt`;
        const hasServerProc = await _localFileExists(serverProcPath);
        const hasLocalProc  = hasServerProc || await _localFileExists(localProcPath);

        const procFilePath = hasServerProc ? serverProcPath : localProcPath;

        if (status.has_processed) {
            procInfo.textContent = '✓ On server';
            procInfo.style.color = '#28a745';
            if (procUpload)   procUpload.style.display = 'none';
            if (procOverride) procOverride.style.display = 'inline-block';
            if (procLocal) {
                procLocal.innerHTML = '';
                if (hasLocalProc) {
                    procLocal.appendChild(_makeLocalFileLink(procFilePath, '📁 View local copy'));
                }
            }
        } else if (hasLocalProc) {
            procInfo.textContent = 'Not on server';
            procInfo.style.color = '#dc3545';
            if (procLocal) {
                procLocal.innerHTML = '';
                procLocal.appendChild(_makeLocalFileLink(procFilePath, '📁 Found locally — view file'));
            }
            if (procUpload)  { procUpload.style.display = 'inline-block'; procUpload.textContent = 'Upload to Server'; }
            if (procOverride) procOverride.style.display = 'none';
        } else {
            procInfo.textContent = 'Not found';
            procInfo.style.color = 'var(--text-muted)';
            if (procLocal)    procLocal.textContent = 'Generated after first analysis run';
            if (procUpload)   procUpload.style.display = 'none';
            if (procOverride) procOverride.style.display = 'none';
        }
    }

    // Auto-collapse panel when all files confirmed on server
    const panel = document.getElementById('server-upload-panel');
    if (panel && totalAudio > 0 && status.has_aggregate && status.has_processed) {
        panel.removeAttribute('open');
    }
}

/**
 * Handle click on upload/override buttons for aggregate or processed.
 * @param {string} category  'aggregate' | 'processed'
 * @param {boolean} force    true = override existing
 * @private
 */
async function _handleServerUpload(category, force = false) {
    const msgEl = document.getElementById('server-upload-status-msg');
    const setMsg = (msg) => { if (msgEl) msgEl.textContent = msg; };

    try {
        if (category === 'aggregate') {
            setMsg('Uploading aggregate…');
            await uploadAggregate(force, setMsg);
            showToast('Aggregate uploaded.', 'success');
        }

        if (category === 'processed') {
            const scriptFile = _currentScript?.script_file || 'birdnet_predictions.py';
            setMsg('Uploading processed list…');
            await uploadProcessed(scriptFile, force, setMsg);
            showToast('Processed list uploaded.', 'success');
        }

        await _refreshServerUploadStatus();
    } catch (e) {
        setMsg(`Upload failed: ${e.message}`);
        showToast(`Upload failed: ${e.message}`, 'failed');
    }
}

/**
 * Handle audio file selection → upload with progress bar + spot mapping.
 * Replaces controls with progress bar during upload, restores after.
 * @private
 */
async function _handleAudioFileSelected(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const spotSelect = document.getElementById('audio-spot-select');
    const spotName   = spotSelect ? spotSelect.value : '';
    if (!spotName) {
        showToast('Select a spot first.', 'failed');
        return;
    }

    const controls = document.getElementById('audio-upload-controls');
    const progress = document.getElementById('audio-upload-progress');
    const progressBar  = document.getElementById('audio-progress-bar');
    const progressLbl  = document.getElementById('audio-progress-label');
    const progressPct  = document.getElementById('audio-progress-pct');

    // Switch to progress view
    if (controls) controls.style.display = 'none';
    if (progress) progress.style.display = 'block';

    try {
        const project = getActiveProject();
        if (!project) throw new Error('No active project.');
        const projFolder = getProjectFolderName(project);
        const base = (Config.server?.baseUrl || '').replace(/\/+$/, '');

        const fd = new FormData();
        fd.append('project', projFolder);
        fd.append('spot', spotName);
        for (const file of files) {
            fd.append('files', file, file.name);
        }

        if (progressLbl) progressLbl.textContent = `Uploading ${files.length} file(s) for ${spotName}…`;

        // Use XMLHttpRequest for progress tracking
        await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${base}/api/v1/projects/upload/audio`);
            xhr.setRequestHeader('ngrok-skip-browser-warning', 'true');

            xhr.upload.onprogress = (evt) => {
                if (evt.lengthComputable) {
                    const pct = Math.round((evt.loaded / evt.total) * 100);
                    if (progressBar) progressBar.style.width = `${pct}%`;
                    if (progressPct) progressPct.textContent = `${pct}%`;
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve();
                } else {
                    let msg = `${xhr.status} ${xhr.statusText}`;
                    try { const b = JSON.parse(xhr.responseText); if (b.detail) msg = b.detail; } catch {}
                    reject(new Error(msg));
                }
            };
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(fd);
        });

        showToast(`${files.length} audio file(s) uploaded for ${spotName}.`, 'success');
        await _refreshServerUploadStatus();
    } catch (err) {
        showToast(`Audio upload failed: ${err.message}`, 'failed');
    } finally {
        // Restore controls
        if (progress) progress.style.display = 'none';
        if (progressBar) progressBar.style.width = '0%';
        if (controls) controls.style.display = 'flex';
        // Reset file input
        const fileInput = document.getElementById('upload-audio-input');
        if (fileInput) fileInput.value = '';
    }
}

// ---------------------------------------------------------------------------
// Status check — dispatches to watcher or server
// ---------------------------------------------------------------------------

/**
 * Update the indicator dot + status text for the active backend.
 *
 * Bug fix: colours are now applied to `style.color` on the ● text character
 * (els.statusIndicator), not `style.backgroundColor`, which coloured the box
 * behind the dot and did not affect the dot's fill colour.
 *
 * @private
 */
async function _checkStatus() {
    // Never clobber the live progress text while a server job is running.
    if (_runningServerJob) return;

    if (_serverMode) return _checkServerStatus();

    try {
        const rawStatus  = await getWatcherStatus();
        const descriptor = getWatcherOnlineStatus(rawStatus);

        // Bug fix #3: use style.color (the ● character) not style.backgroundColor
        if (els.statusIndicator) els.statusIndicator.style.color = descriptor.color;
        if (els.statusText)      els.statusText.textContent       = descriptor.text;

        if (els.runBtn) {
            const isFormReady = els.runBtn.dataset.formReady === 'true';
            els.runBtn.disabled   = !isFormReady;
            els.runBtn.textContent = descriptor.isBusy ? 'Watcher Busy...' : 'Queue Job';
        }

        // Refresh script list if dropdown is empty
        if (els.scriptSelect && els.scriptSelect.options.length <= 1) {
            _loadScripts();
        }
    } catch (e) {
        console.error('[AnalysisUI] Status check failed:', e);
    }
}

/**
 * Server-mode status: probe /health and reflect reachability in the pill.
 * @private
 */
async function _checkServerStatus() {
    if (!serverConfigured()) {
        if (els.statusIndicator) els.statusIndicator.style.color = '#dc3545';
        if (els.statusText)      els.statusText.textContent =
            'Server not configured (Config.server)';
        if (els.runBtn) { els.runBtn.disabled = true; els.runBtn.textContent = 'Run on Server'; }
        const d = document.getElementById('server-help-detail');
        if (d) d.innerHTML = '<br><strong>Set Config.server.baseUrl.</strong>';
        return;
    }

    const { online, error } = await checkServerHealth();
    if (els.statusIndicator) els.statusIndicator.style.color = online ? '#28A745' : '#dc3545';
    if (els.statusText) {
        const { baseUrl } = getServerConfig();
        els.statusText.textContent = online ? `Server Online (${baseUrl})` : 'Server Offline';
    }
    const d = document.getElementById('server-help-detail');
    if (d) d.innerHTML = online ? '' : `<br><strong>Cannot reach server.</strong> ${error || ''}`;

    if (els.runBtn) {
        const isFormReady = els.runBtn.dataset.formReady === 'true';
        els.runBtn.disabled    = !online || !isFormReady;
        els.runBtn.textContent = 'Run on Server';
    }

    if (els.scriptSelect && els.scriptSelect.options.length <= 1 && online) {
        _loadScripts();
    }
}

// ---------------------------------------------------------------------------
// Script loading
// ---------------------------------------------------------------------------

/**
 * Load the installed-scripts list and populate the script selector dropdown.
 * Preserves any previously selected script (re-selects it after refresh).
 * @private
 */
async function _loadScripts() {
    if (!els.scriptSelect) return;

    const currentSelection  = els.scriptSelect.value;

    // Source the script list from the active backend.
    let installedScripts;
    if (_serverMode) {
        try {
            installedScripts = serverConfigured() ? await getServerSteps() : [];
        } catch (e) {
            console.error('[AnalysisUI] Failed to load server steps:', e);
            installedScripts = [];
        }
    } else {
        installedScripts = await loadInstalledScripts();
    }

    els.scriptSelect.innerHTML = '<option value="">-- Select Script --</option>';

    if (installedScripts.length === 0) {
        const opt     = document.createElement('option');
        opt.disabled  = true;
        opt.textContent = _serverMode
            ? 'Connect to a reachable server to load scripts'
            : 'Connect Watcher to load scripts';
        els.scriptSelect.appendChild(opt);
        return;
    }

    installedScripts.forEach(script => {
        const opt       = document.createElement('option');
        opt.value       = script.id;
        opt.textContent = script.name;
        opt.dataset.json = JSON.stringify(script);
        els.scriptSelect.appendChild(opt);
    });

    // Restore previous selection and trigger param rendering
    if (
        currentSelection &&
        Array.from(els.scriptSelect.options).some(o => o.value === currentSelection)
    ) {
        els.scriptSelect.value = currentSelection;
        _loadScriptParams(currentSelection);
    }
}

// ---------------------------------------------------------------------------
// Script parameter rendering
// ---------------------------------------------------------------------------

/**
 * Render the file-selector panel and dynamic parameter form for a chosen script.
 *
 * @param {string} scriptId  Value of the selected <option> in the script dropdown.
 * @private
 */
function _loadScriptParams(scriptId) {
    if (els.runBtn) {
        els.runBtn.dataset.formReady = 'false';
        els.runBtn.disabled          = true;
    }

    if (!scriptId) {
        if (els.paramsContainer) els.paramsContainer.style.display = 'none';
        if (els.fileSelector)    els.fileSelector.innerHTML =
            '<p style="padding:10px; color:var(--text-muted);">Select a script first...</p>';
        return;
    }

    const opt = els.scriptSelect.querySelector(`option[value="${scriptId}"]`);
    if (!opt) return;
    _currentScript = JSON.parse(opt.dataset.json);

    if (els.fileSelector) els.fileSelector.innerHTML = '';
    if (els.dynamicForm)  els.dynamicForm.innerHTML  = '';

    let hasSpotDateInput = false;

    // Render spot+date input panel if the script declares it
    if (_currentScript.inputs) {
        _currentScript.inputs.forEach(input => {
            if (input.type === 'spot_date_range') {
                _renderSpotDateSelector(input.label);
                hasSpotDateInput = true;
            }
        });
    }

    // Render dynamic parameter fields (select / text)
    if (_currentScript.parameters) {
        _currentScript.parameters.forEach(param => {
            const row = document.createElement('div');
            row.className        = 'param-row';
            row.style.marginBottom = '10px';

            const label        = document.createElement('label');
            label.style.display    = 'block';
            label.style.fontWeight = 'bold';
            label.textContent      = param.label;
            row.appendChild(label);

            let inputEl;
            if (param.type === 'select') {
                inputEl = document.createElement('select');
                param.options.forEach(opt => {
                    const o       = document.createElement('option');
                    o.value       = opt;
                    o.textContent = opt;
                    inputEl.appendChild(o);
                });
                inputEl.value = param.default;
            } else {
                inputEl       = document.createElement('input');
                inputEl.type  = 'text';
                inputEl.value = param.default || '';
            }

            inputEl.style.width      = '100%';
            inputEl.style.padding    = '8px';
            inputEl.dataset.paramId  = param.id;
            row.appendChild(inputEl);
            els.dynamicForm.appendChild(row);
        });
    }

    // Scripts with no spot/date selector are instantly ready to run
    if (!hasSpotDateInput && els.runBtn) {
        els.runBtn.dataset.formReady = 'true';
        _checkStatus(); // let the heartbeat re-evaluate the disabled state immediately
    }

    if (els.paramsContainer) els.paramsContainer.style.display = 'block';
}

// ---------------------------------------------------------------------------
// File selector — spot + date range panel
// ---------------------------------------------------------------------------

/** Set of "YYYYMMDD" strings with audio for currently selected spots. */
let _availableDates = new Set();

/** Currently viewed month for each calendar { start: {year,month}, end: {year,month} } */
let _calendarState = { start: null, end: null };

/**
 * Scan external files linked to given spotIds, extract YYYYMMDD dates from
 * filenames. Returns a Set of "YYYYMMDD" strings.
 * @param {string[]} spotIds
 * @returns {Set<string>}
 */
function _getAvailableDates(spotIds) {
    const idSet = new Set(spotIds);
    const dates = new Set();
    const externalFiles = getExternalFiles();
    const audioExts = /\.(wav|mp3|m4a|flac)$/i;

    externalFiles.forEach(f => {
        if (!audioExts.test(f.name)) return;
        if (!f.linked_spots || !f.linked_spots.some(id => idSet.has(id))) return;
        const m = f.name.match(/_(\d{8})_/);
        if (m) dates.add(m[1]);
    });
    return dates;
}

/**
 * Recalculate available dates from checked spots and re-render both calendars.
 */
function _refreshAvailableDates() {
    const checked = document.querySelectorAll('.analysis-spot-checkbox:checked');
    const spotIds = Array.from(checked).map(cb => cb.value);
    _availableDates = _getAvailableDates(spotIds);
    _renderCalendar('start');
    _renderCalendar('end');
}

/**
 * Render an inline month-grid calendar into #cal-{which} container.
 * Dates with audio files get a coloured highlight.
 * @param {'start'|'end'} which
 */
function _renderCalendar(which) {
    const container = document.getElementById(`cal-${which}`);
    if (!container) return;

    const st = _calendarState[which];
    if (!st) return;

    const { year, month } = st;                 // month 0-based
    const today     = new Date();
    const firstDay  = new Date(year, month, 1);
    const daysInMon = new Date(year, month + 1, 0).getDate();
    const startDow  = firstDay.getDay();         // 0=Sun

    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // Selected value (YYYY-MM-DD)
    const inputEl   = document.getElementById(`analysis-${which}-date`);
    const selVal    = inputEl ? inputEl.value : '';
    const selParts  = selVal ? selVal.split('-') : null;
    const selDay    = selParts ? parseInt(selParts[2], 10) : -1;
    const selMonth  = selParts ? parseInt(selParts[1], 10) - 1 : -1;
    const selYear   = selParts ? parseInt(selParts[0], 10) : -1;

    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <button type="button" class="cal-nav" data-which="${which}" data-dir="-1" style="background:none; border:none; cursor:pointer; font-size:1rem; color:var(--text-dark); padding:2px 6px;">◀</button>
            <span style="font-weight:bold; font-size:0.85rem; color:var(--text-dark);">${monthNames[month]} ${year}</span>
            <button type="button" class="cal-nav" data-which="${which}" data-dir="1" style="background:none; border:none; cursor:pointer; font-size:1rem; color:var(--text-dark); padding:2px 6px;">▶</button>
        </div>
        <div style="display:grid; grid-template-columns:repeat(7,1fr); text-align:center; font-size:0.75rem; gap:1px;">
    `;

    // Day-of-week header
    ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(d => {
        html += `<div style="font-weight:bold; color:var(--text-muted); padding:2px;">${d}</div>`;
    });

    // Empty cells before day 1
    for (let i = 0; i < startDow; i++) {
        html += `<div></div>`;
    }

    // Day cells
    for (let d = 1; d <= daysInMon; d++) {
        const yyyymmdd = `${year}${String(month + 1).padStart(2, '0')}${String(d).padStart(2, '0')}`;
        const isoDate  = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const hasAudio = _availableDates.has(yyyymmdd);
        const isSelected = (d === selDay && month === selMonth && year === selYear);
        const isToday  = (d === today.getDate() && month === today.getMonth() && year === today.getFullYear());

        let bg = 'transparent';
        let color = 'var(--text-dark)';
        let border = '1px solid transparent';
        let fontWeight = 'normal';

        if (hasAudio) {
            bg = 'rgba(220, 53, 69, 0.15)';
            color = '#dc3545';
            fontWeight = 'bold';
        }
        if (isSelected) {
            bg = 'var(--accent-blue)';
            color = '#fff';
            fontWeight = 'bold';
        }
        if (isToday && !isSelected) {
            border = '1px solid var(--accent-blue)';
        }

        html += `<div class="cal-day" data-which="${which}" data-date="${isoDate}"
                      style="padding:3px 1px; cursor:pointer; border-radius:4px;
                             background:${bg}; color:${color}; font-weight:${fontWeight};
                             border:${border}; line-height:1.6;"
                      title="${hasAudio ? 'Audio available' : ''}">${d}</div>`;
    }

    html += `</div>`;

    // Legend
    html += `<div style="display:flex; align-items:center; gap:6px; margin-top:6px; font-size:0.7rem; color:var(--text-muted);">
        <span style="display:inline-block; width:10px; height:10px; background:rgba(220,53,69,0.3); border-radius:2px;"></span> Has audio
    </div>`;

    container.innerHTML = html;
}

/**
 * Inject the spot-checkbox list and date-range inputs into els.fileSelector.
 *
 * A single delegated listener on els.fileSelector (registered once in
 * _initFileSelectorListener) handles all change events from these controls.
 *
 * @param {string} label  Human-readable label from the script descriptor.
 * @private
 */
function _renderSpotDateSelector(label) {
    const spots = getSpots();

    let spotsHtml = `
        <label class="analysis-selectall">
            <input type="checkbox" id="analysis-select-all-spots"> Select all spots (${spots.length})
        </label>
        <div class="analysis-spot-grid">`;
    spots.forEach(s => {
        spotsHtml += `
            <label class="analysis-spot-card">
                <input type="checkbox" class="analysis-spot-checkbox" value="${s.spotId}">
                <span>${s.name}</span>
            </label>
        `;
    });
    spotsHtml += '</div>';

    _availableDates = new Set();

    // Compact native date range (the old data-aware calendar is no longer needed
    // — the UI doesn't track which dates have data anymore).
    els.fileSelector.innerHTML += `
        <div style="margin-bottom:14px;">
            <label style="display:block; margin-bottom:6px; font-weight:700;">${label}</label>
            ${spotsHtml}
        </div>
        <div style="display:flex; gap:12px; margin-bottom:6px;">
            <div style="flex:1;">
                <label style="display:block; margin-bottom:4px; font-size:0.82rem; font-weight:700; color:var(--text-muted);">Start date</label>
                <input type="date" id="analysis-start-date" value="">
            </div>
            <div style="flex:1;">
                <label style="display:block; margin-bottom:4px; font-size:0.82rem; font-weight:700; color:var(--text-muted);">End date</label>
                <input type="date" id="analysis-end-date" value="">
            </div>
        </div>
        <div id="analysis-file-acknowledgement" style="padding:10px; background:var(--bg-surface-alt); border-radius:var(--radius-md); font-size:0.85rem; color:var(--text-muted);">
            Select spots and a date range, then queue your job.
        </div>
    `;
}

/**
 * Register a SINGLE delegated 'change' + 'click' listener on els.fileSelector.
 *
 * Handles:
 *  - spot checkbox change → refresh available dates + recalculate overlap
 *  - calendar day click   → set hidden date input + re-render + recalculate
 *  - calendar nav (◀▶)    → shift month + re-render
 *
 * @private
 */
function _initFileSelectorListener() {
    if (_fileSelectorListenerAttached || !els.fileSelector) return;

    // Change listener — spot checkboxes + select-all
    els.fileSelector.addEventListener('change', (e) => {
        if (e.target.id === 'analysis-select-all-spots') {
            els.fileSelector
                .querySelectorAll('.analysis-spot-checkbox')
                .forEach(cb => { cb.checked = e.target.checked; });
            _refreshAvailableDates();
            _updateFormReadiness();
            return;
        }
        if (e.target.classList.contains('analysis-spot-checkbox')) {
            _refreshAvailableDates();
            _updateFormReadiness();
            return;
        }
        if (e.target.id === 'analysis-start-date' || e.target.id === 'analysis-end-date') {
            _updateFormReadiness();
        }
    });

    // Click listener — calendar day selection + nav arrows
    els.fileSelector.addEventListener('click', (e) => {
        const dayEl = e.target.closest('.cal-day');
        const navEl = e.target.closest('.cal-nav');

        if (dayEl) {
            const which = dayEl.dataset.which;  // 'start' or 'end'
            const date  = dayEl.dataset.date;   // 'YYYY-MM-DD'
            const input = document.getElementById(`analysis-${which}-date`);
            if (input) {
                input.value = date;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            _renderCalendar(which);
            _updateFormReadiness();
            return;
        }

        if (navEl) {
            const which = navEl.dataset.which;
            const dir   = parseInt(navEl.dataset.dir, 10);
            const st    = _calendarState[which];
            if (!st) return;

            st.month += dir;
            if (st.month > 11) { st.month = 0;  st.year++; }
            if (st.month < 0)  { st.month = 11; st.year--; }
            _renderCalendar(which);
        }
    });

    _fileSelectorListenerAttached = true;
}

// ---------------------------------------------------------------------------
// Form readiness — simple spots + dates check
// ---------------------------------------------------------------------------

/**
 * Check if spots and date range are selected. If so, mark form ready.
 * No file counting, no dependency checks — just spots + dates.
 *
 * @private
 */
function _updateFormReadiness() {
    const checkedSpots = document.querySelectorAll('.analysis-spot-checkbox:checked');
    const start        = document.getElementById('analysis-start-date')?.value;
    const end          = document.getElementById('analysis-end-date')?.value;

    if (checkedSpots.length > 0 && start && end) {
        _setFormReady(true);
    } else {
        _setFormReady(false);
    }
}

/**
 * Toggle the run button's `formReady` data attribute and re-evaluate enabled state.
 *
 * @param {boolean} ready
 * @private
 */
function _setFormReady(ready) {
    if (!els.runBtn) return;
    els.runBtn.dataset.formReady = ready ? 'true' : 'false';
    _checkStatus(); // let heartbeat decide if watcher is also ready
}

// ---------------------------------------------------------------------------
// Run handler
// ---------------------------------------------------------------------------

/**
 * Gather form state, build job data via AnalysisService, and queue the job.
 * Replaces the inline alert() calls with showToast().
 *
 * @private
 */
async function _handleRunClick() {
    if (!_currentScript) return;

    // Auto-generate job name if blank
    let jobName = els.jobNameInput ? els.jobNameInput.value.trim() : '';
    if (!jobName) {
        const d  = new Date();
        const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
        jobName  = `Job_${ts}`;
        if (els.jobNameInput) els.jobNameInput.value = jobName;
    }
    jobName = jobName.replace(/[^a-zA-Z0-9_\-\s]/g, '_').trim();

    const hasSpotDateInput = _currentScript.inputs &&
        _currentScript.inputs.some(i => i.type === 'spot_date_range');

    let spotIds   = [];
    let startDate = '';
    let endDate   = '';

    if (hasSpotDateInput) {
        const checkedSpots = document.querySelectorAll('.analysis-spot-checkbox:checked');
        startDate          = document.getElementById('analysis-start-date')?.value || '';
        endDate            = document.getElementById('analysis-end-date')?.value   || '';

        if (checkedSpots.length === 0 || !startDate || !endDate) {
            showToast('Please select at least one Spot and a full Date Range.', 'failed');
            return;
        }
        spotIds = Array.from(checkedSpots).map(cb => cb.value);
    }

    // Collect dynamic parameter values from the rendered form
    const dynamicParams = {};
    els.dynamicForm.querySelectorAll('[data-param-id]').forEach(input => {
        dynamicParams[input.dataset.paramId] = input.value;
    });

    const spots         = getSpots();
    const externalFiles = getExternalFiles();

    // ── Server mode: upload → run → poll → download (see ServerService) ──────
    if (_serverMode) {
        await _runOnServer({ jobName, spotIds, startDate, endDate, dynamicParams, spots, externalFiles });
        return;
    }

    // ── Watcher mode: write a job descriptor into jobs/queue ─────────────────
    const jobData = buildJobData(
        jobName,
        _currentScript,
        spotIds,
        startDate,
        endDate,
        dynamicParams,
        spots,
        externalFiles
    );

    try {
        if (els.runBtn) {
            els.runBtn.textContent = 'Queuing...';
            els.runBtn.disabled    = true;
        }

        await queueJob(jobData);

        showToast('Job queued successfully!', 'success');
        closeModal('analysis-popup');
        if (els.jobNameInput) els.jobNameInput.value  = '';
        _stopHeartbeat();

    } catch (e) {
        showToast(`Error: ${e.message}`, 'failed');
    } finally {
        if (els.runBtn) {
            els.runBtn.textContent = 'Queue Job';
            els.runBtn.disabled    = false;
        }
    }
}

/**
 * Run the selected step on the lab server, streaming progress into the status
 * pill. The popup stays open so the user can watch upload/run/download; on
 * success it closes and the Jobs dashboard will show the downloaded results.
 *
 * @private
 */
async function _runOnServer({ jobName, spotIds, startDate, endDate, dynamicParams, spots, externalFiles }) {
    _runningServerJob = true;
    const setStatus = (msg) => { if (els.statusText) els.statusText.textContent = msg; };
    if (els.statusIndicator) els.statusIndicator.style.color = '#FFC107';

    if (els.runBtn) { els.runBtn.textContent = 'Running…'; els.runBtn.disabled = true; }

    try {
        const res = await runJobOnServer({
            jobName,
            currentScript: _currentScript,
            spotIds, startDate, endDate, dynamicParams,
            spots, externalFiles,
            onProgress: setStatus,
        });

        showToast(`Server job complete — ${res.files} file(s) downloaded.`, 'success');
        closeModal('analysis-popup');
        if (els.jobNameInput) els.jobNameInput.value = '';
        _stopHeartbeat();
    } catch (e) {
        showToast(`Server job failed: ${e.message}`, 'failed');
        setStatus(`Failed: ${e.message}`);
        if (els.statusIndicator) els.statusIndicator.style.color = '#dc3545';
    } finally {
        _runningServerJob = false;
        if (els.runBtn) { els.runBtn.textContent = 'Run on Server'; els.runBtn.disabled = false; }
    }
}
// EOF — AnalysisUI (watcher + server compute modes)
