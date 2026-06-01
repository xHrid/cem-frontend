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

import EventBus, { EVENTS }        from '../core/EventBus.js';
import {
    getWatcherOnlineStatus,
    loadInstalledScripts,
    buildJobData,
    queueJob,
}                                   from '../services/AnalysisService.js';
import { getSpots, getExternalFiles } from '../data/MasterData.js';
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

            _checkStatus();
            _loadScripts();
            _startHeartbeat();
        });
    }

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

/**
 * Read watcher status.json and update the indicator dot + status text.
 *
 * Bug fix: colours are now applied to `style.color` on the ● text character
 * (els.statusIndicator), not `style.backgroundColor`, which coloured the box
 * behind the dot and did not affect the dot's fill colour.
 *
 * @private
 */
async function _checkStatus() {
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
    const installedScripts  = await loadInstalledScripts();

    els.scriptSelect.innerHTML = '<option value="">-- Select Script --</option>';

    if (installedScripts.length === 0) {
        const opt     = document.createElement('option');
        opt.disabled  = true;
        opt.textContent = 'Connect Watcher to load scripts';
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

    let spotsHtml = '<div style="max-height:150px; overflow-y:auto; border:1px solid var(--border-color); padding:5px; border-radius:4px; background:var(--bg-surface);">';
    spots.forEach(s => {
        spotsHtml += `
            <label style="display:flex; align-items:center; gap:8px; padding:4px; cursor:pointer;">
                <input type="checkbox" class="analysis-spot-checkbox" value="${s.spotId}">
                <strong>${s.name}</strong>
            </label>
        `;
    });
    spotsHtml += '</div>';

    // Init calendar state to current month
    const now = new Date();
    _calendarState.start = { year: now.getFullYear(), month: now.getMonth() };
    _calendarState.end   = { year: now.getFullYear(), month: now.getMonth() };
    _availableDates = new Set();

    // Append to the file-selector panel
    els.fileSelector.innerHTML += `
        <div style="margin-bottom:15px;">
            <label style="display:block; margin-bottom:5px; font-weight:bold;">${label}</label>
            ${spotsHtml}
        </div>
        <div style="display:flex; gap:10px; margin-bottom:15px;">
            <div style="flex:1;">
                <label style="display:block; margin-bottom:5px; font-weight:bold;">Start Date</label>
                <input type="hidden" id="analysis-start-date" value="">
                <div id="cal-start" style="border:1px solid var(--border-color); border-radius:6px; padding:8px; background:var(--bg-surface);"></div>
            </div>
            <div style="flex:1;">
                <label style="display:block; margin-bottom:5px; font-weight:bold;">End Date</label>
                <input type="hidden" id="analysis-end-date" value="">
                <div id="cal-end" style="border:1px solid var(--border-color); border-radius:6px; padding:8px; background:var(--bg-surface);"></div>
            </div>
        </div>
        <div id="analysis-file-acknowledgement" style="padding:10px; background:var(--bg-surface-alt); border-radius:4px; font-size:0.9rem; color:var(--text-muted);">
            Select spots and a date range, then queue your job.
        </div>
    `;

    // Initial render (empty — no spots selected yet)
    _renderCalendar('start');
    _renderCalendar('end');
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

    // Change listener — spot checkboxes
    els.fileSelector.addEventListener('change', (e) => {
        const isCheckbox = e.target.classList.contains('analysis-spot-checkbox');

        if (isCheckbox) {
            _refreshAvailableDates();
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
