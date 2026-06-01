/**
 * SpotManager.js — Observation spot recording and map display
 *
 * Pattern : Module Pattern (IIFE / private-scope encapsulation)
 *
 * Replaces the legacy js/spots.js. Bugs fixed:
 *
 *  Bug 1 — saveSpot called with 4 args but old storage only accepted 3.
 *           Now fixed in Repository.saveSpot() which accepts the 4th
 *           `recordDate` parameter. This module passes all four.
 *
 *  Bug 2 — displaySpots() was called on PROJECT_CHANGED even when the
 *           "Show Spots" checkbox was unchecked, creating ghost markers.
 *           Fixed: all three event handlers gate on the checkbox state.
 *
 *  Bug 3 — Audio recording state (mediaRecorder, audioChunks) was mixed
 *           with form-submit scope, making the blob unreliable when the
 *           user stopped recording after opening the form a second time.
 *           Fixed: encapsulated in _startRecording() / _stopRecording().
 *
 *  Bug 4 — DOM queries ran at module top level (import-time), before
 *           DOMContentLoaded. Fixed: all querySelector calls deferred
 *           inside initSpots() and the functions it calls.
 *
 *  Bug 5 — alert() used for all user feedback. Replaced with showToast().
 *
 * Import graph
 * ------------
 *   EventBus, EVENTS          → ../core/EventBus.js
 *   saveSpot, getLocalFileUrl → ../data/Repository.js
 *   getSpots, getExternalFiles → ../data/MasterData.js
 *   getMap                    → ./MapManager.js
 *   showToast                 → ../ui/Toast.js
 */

import EventBus, { EVENTS }          from '../core/EventBus.js';
import { saveSpot, getLocalFileUrl, deleteSpot, deleteExternalFile } from '../data/Repository.js';
import { getSpots, getExternalFiles } from '../data/MasterData.js';
import { getMap, getCurrentPosition } from './MapManager.js';
import { showToast }                 from '../ui/Toast.js';
import { openModal, closeModal }     from '../ui/ModalManager.js';

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

/** @type {L.LayerGroup|null} — the layer that holds all spot circle-markers */
let _spotsLayer = null;

// Audio recording state — encapsulated here (Bug 3 fix)
/** @type {MediaRecorder|null} */
let _mediaRecorder = null;
/** @type {Blob[]} */
let _audioChunks = [];
/** @type {Blob|null} */
let _recordedAudioBlob = null;

/** Pre-fill spot name when using "Add More" from spot details */
let _prefillSpotName = null;

/**
 * When set, the spot form is in "Add More" mode: we are appending another
 * temporal entry to an EXISTING spot. Name and coordinates are locked to the
 * original spot — only the new observation's notes/media/time may change.
 * @type {object|null}
 */
let _addMoreSpot = null;

/**
 * Lock or unlock the spot-form name + location inputs.
 *
 * In Add More mode the name field is read-only and the location is pinned to
 * the original spot's coordinates (the "use current location" path is
 * disabled), because the user is adding info to the same spot — not moving it
 * or renaming it.
 *
 * @param {object|null} spot  The spot to lock onto, or null to unlock.
 */
function _setAddMoreMode(spot) {
    _addMoreSpot = spot || null;

    const nameInput   = document.querySelector('#spot-form [name="name"]');
    const useLocCb     = document.getElementById('use-current-location');
    const locFields    = document.getElementById('custom-location-fields');
    const latInput     = document.getElementById('custom-lat');
    const lonInput     = document.getElementById('custom-lon');

    if (spot) {
        // --- Lock name ---
        if (nameInput) {
            nameInput.value    = spot.name;
            nameInput.readOnly = true;
            nameInput.title    = 'Name locked — adding to the same spot';
        }
        // --- Pin location to the spot's coordinates, lock the inputs ---
        if (useLocCb) {
            useLocCb.checked  = false;
            useLocCb.disabled = true;
        }
        if (locFields) locFields.style.display = 'flex';
        if (latInput) {
            latInput.value    = spot.latitude;
            latInput.readOnly = true;
            latInput.disabled = true;
        }
        if (lonInput) {
            lonInput.value    = spot.longitude;
            lonInput.readOnly = true;
            lonInput.disabled = true;
        }
    } else {
        // --- Unlock everything (normal "Add" path) ---
        if (nameInput) { nameInput.readOnly = false; nameInput.title = ''; }
        if (useLocCb)  { useLocCb.disabled  = false; }
        if (latInput)  { latInput.readOnly  = false; latInput.disabled  = false; }
        if (lonInput)  { lonInput.readOnly  = false; lonInput.disabled  = false; }
    }
}

// ---------------------------------------------------------------------------
// Private — audio recording (Bug 3: was inlined inside the click handler)
// ---------------------------------------------------------------------------

/**
 * Request microphone access and start a new MediaRecorder session.
 * Clears any previously recorded blob so a fresh recording always starts clean.
 *
 * @returns {Promise<void>}
 */
async function _startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        _audioChunks       = [];
        _recordedAudioBlob = null;
        _mediaRecorder     = new MediaRecorder(stream);

        _mediaRecorder.ondataavailable = (e) => _audioChunks.push(e.data);

        _mediaRecorder.onstop = () => {
            _recordedAudioBlob = new Blob(_audioChunks, { type: 'audio/webm' });
            const playback = document.getElementById('audioPlayback');
            if (playback) playback.src = URL.createObjectURL(_recordedAudioBlob);
        };

        _mediaRecorder.start();
    } catch (err) {
        showToast(`Mic Error: ${err.message}`, 'failed');
        _mediaRecorder = null;
    }
}

/**
 * Stop the currently active MediaRecorder.
 * The `onstop` handler above assembles the blob asynchronously.
 */
function _stopRecording() {
    if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
        _mediaRecorder.stop();
    }
}

// ---------------------------------------------------------------------------
// Private — audio toggle wiring
// ---------------------------------------------------------------------------

/**
 * Bind the microphone toggle button inside the spot form.
 * Called once from initSpots() after DOMContentLoaded.
 */
function _bindAudioToggle() {
    const audioToggle = document.getElementById('audio-toggle');
    if (!audioToggle) return;

    audioToggle.addEventListener('click', async () => {
        const isIdle = !_mediaRecorder || _mediaRecorder.state === 'inactive';

        if (isIdle) {
            await _startRecording();
            if (_mediaRecorder) {
                // Only update UI if recording started successfully
                audioToggle.classList.add('recording');
                audioToggle.style.backgroundColor = 'red';
            }
        } else {
            _stopRecording();
            audioToggle.classList.remove('recording');
            audioToggle.style.backgroundColor = '';
        }
    });
}

// ---------------------------------------------------------------------------
// Private — spot form submission
// ---------------------------------------------------------------------------

/**
 * Handle the #spot-form submit event.
 *
 * Date-handling fix (Bug 1 extension): the form exposes a "use current time"
 * checkbox. When unchecked, custom date/time inputs determine recordDate,
 * which is passed as the 4th argument to saveSpot() so Repository uses it as
 * the observation timestamp rather than always calling new Date().
 *
 * @param {SubmitEvent} e
 */
async function _handleSpotFormSubmit(e) {
    e.preventDefault();
    const form = e.target;

    // --- Date handling ---
    let recordDate = new Date();
    const useCurrentCb = document.getElementById('use-current-time');
    if (useCurrentCb && !useCurrentCb.checked) {
        const cDate = document.getElementById('custom-date').value;
        const cTime = document.getElementById('custom-time').value || '00:00:00';
        if (cDate) recordDate = new Date(`${cDate}T${cTime}`);
    }

    // --- Location handling ---
    let lat, lng;
    if (_addMoreSpot) {
        // Add More mode — coordinates are locked to the original spot.
        lat = _addMoreSpot.latitude;
        lng = _addMoreSpot.longitude;
    } else {
        const useCurrentLocCb = document.getElementById('use-current-location');
        if (useCurrentLocCb && !useCurrentLocCb.checked) {
            lat = parseFloat(document.getElementById('custom-lat').value);
            lng = parseFloat(document.getElementById('custom-lon').value);
            if (isNaN(lat) || isNaN(lng)) {
                showToast('Please enter valid latitude and longitude.', 'failed');
                return;
            }
        } else {
            const pos = getCurrentPosition();
            lat = pos.lat;
            lng = pos.lng;
        }
    }

    // Add More mode — name is locked to the original spot.
    const spotName = _addMoreSpot ? _addMoreSpot.name : form.name.value;

    const imageFile = document.getElementById('image-upload').files[0] || null;

    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.textContent = 'Saving to disk...';

    try {
        await saveSpot(
            {
                name        : spotName,
                description : form.description.value,
                latitude    : lat,
                longitude   : lng,
                birds       : form.birds?.value || '',
            },
            imageFile,
            _recordedAudioBlob,
            recordDate
        );

        showToast('Spot saved locally!', 'success');

        // --- Reset the form ---
        form.reset();
        _prefillSpotName = null;
        _setAddMoreMode(null); // unlock name/location for the next normal add
        const useCurrentCbReset = document.getElementById('use-current-time');
        if (useCurrentCbReset) useCurrentCbReset.checked = true;
        const useCurrentLocReset = document.getElementById('use-current-location');
        if (useCurrentLocReset) useCurrentLocReset.checked = true;

        const customTimeFields = document.getElementById('custom-time-fields');
        if (customTimeFields) customTimeFields.style.display = 'none';
        const customLocFields = document.getElementById('custom-location-fields');
        if (customLocFields) customLocFields.style.display = 'none';

        closeModal('popup-form');
        if (statusEl) statusEl.textContent = '';

        // Reset audio state
        _recordedAudioBlob = null;
        _mediaRecorder     = null;
        _audioChunks       = [];
        const playback = document.getElementById('audioPlayback');
        if (playback) playback.src = '';

        // Refresh the map layer if the checkbox is checked
        if (_isSpotsCheckboxChecked()) displaySpots();

    } catch (err) {
        console.error('[SpotManager] saveSpot failed:', err);
        showToast(`Error saving spot (is a folder selected?): ${err.message}`, 'failed');
        if (statusEl) statusEl.textContent = '';
    }
}

// ---------------------------------------------------------------------------
// Private — detail panel
// ---------------------------------------------------------------------------

/**
 * Read the display-spots checkbox state.
 *
 * @returns {boolean}
 */
function _isSpotsCheckboxChecked() {
    const cb = document.getElementById('display-spots');
    return cb ? cb.checked : false;
}

/**
 * Populate the side panel with details for the clicked spot.
 *
 * Loads image and audio blob URLs asynchronously via Repository.getLocalFileUrl()
 * (which delegates to StorageAdapter for the native File System handle).
 *
 * @param {object} spot  The spot record from MasterData.
 */
async function _showSpotDetails(spot) {
    const menu    = document.getElementById('spot-details-menu');
    const content = document.getElementById('spot-details-content');
    if (!menu || !content) return;

    // Find all entries with the same spot name (temporal tracking)
    const allSpots = getSpots();
    const spotEntries = allSpots.filter(s => s.name === spot.name);

    // Build external-files button
    const allExternal   = getExternalFiles();
    const externalFiles = allExternal.filter(
        (f) => f.linked_spots && f.linked_spots.some(id => spotEntries.some(s => s.spotId === id))
    );
    const hasExternal = externalFiles.length > 0;

    // Build header with action buttons
    let html = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <h2 id="spot-name"></h2>
        </div>
        <p><span id="spot-coordinates"></span></p>
        <div style="display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap;">
            <button id="add-more-spot-btn" class="popup-btn" style="font-size:0.85rem; padding:5px 12px; background:#4CAF50; color:white; border:none; border-radius:4px; cursor:pointer;">
                + Add More
            </button>
            <button id="show-external-data-btn" class="show-external-data-btn" ${!hasExternal ? 'disabled' : ''}>
                External Media (${externalFiles.length})
            </button>
        </div>
        <hr>
    `;

    // Render each temporal entry
    spotEntries.forEach((entry, idx) => {
        const obsDate = new Date(entry.timestamp || Date.now()).toLocaleString();
        html += `
            <div class="spot-entry" style="margin-bottom:15px; padding:10px; background:var(--bg-surface-alt); border-radius:8px; border:1px solid var(--border-color);">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <p style="margin:0;"><small><strong>Entry ${idx + 1}</strong> — <span class="spot-date">${''}</span></small></p>
                    <button class="delete-spot-entry-btn" data-spot-id="${entry.spotId}" style="background:none; border:none; color:#dc3545; cursor:pointer; font-size:1.1rem;" title="Delete this entry">🗑</button>
                </div>
                <p style="margin:5px 0;"><strong>Coords:</strong> <span class="entry-coords">${''}</span></p>
                <p style="margin:5px 0;"><strong>Description:</strong> <span class="entry-desc">${''}</span></p>
                <p style="margin:5px 0;"><strong>Birds:</strong> <span class="entry-birds">${''}</span></p>
                <div class="media-container-img-${idx}" style="margin-top:10px;"></div>
                <div class="media-container-audio-${idx}" style="margin-top:10px;"></div>
            </div>
        `;
    });

    content.innerHTML = html;

    // Set user content via textContent (XSS-safe)
    content.querySelector('#spot-name').textContent = spot.name;
    content.querySelector('#spot-coordinates').textContent =
        `(${spot.latitude.toFixed(5)}, ${spot.longitude.toFixed(5)})`;

    // Fill in each entry's text safely
    const entryDivs = content.querySelectorAll('.spot-entry');
    spotEntries.forEach((entry, idx) => {
        const div = entryDivs[idx];
        if (!div) return;
        const obsDate = new Date(entry.timestamp || Date.now()).toLocaleString();
        div.querySelector('.spot-date').textContent = obsDate;
        div.querySelector('.entry-coords').textContent =
            `(${entry.latitude.toFixed(5)}, ${entry.longitude.toFixed(5)})`;
        div.querySelector('.entry-desc').textContent = entry.description || 'No notes';
        div.querySelector('.entry-birds').textContent = entry.birds || 'None listed';
    });

    menu.classList.add('open');

    // "Add More" button — opens the spot form locked to THIS spot (same name +
    // coordinates; the user is appending another observation, not editing identity).
    document.getElementById('add-more-spot-btn')?.addEventListener('click', () => {
        _prefillSpotName = spot.name;
        _setAddMoreMode(spot);
        openModal('popup-form');
    });

    if (hasExternal) {
        document.getElementById('show-external-data-btn').addEventListener('click', () => {
            _openExternalViewer(externalFiles);
        });
    }

    // Delete buttons for each entry
    content.querySelectorAll('.delete-spot-entry-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const spotId = btn.dataset.spotId;
            if (!confirm('Delete this spot entry? This cannot be undone.')) return;
            try {
                await deleteSpot(spotId);
                showToast('Spot entry deleted.', 'success');
                // Refresh panel — if entries remain, show first; otherwise close panel
                const remaining = getSpots().filter(s => s.name === spot.name);
                if (remaining.length > 0) {
                    _showSpotDetails(remaining[0]);
                } else {
                    menu.classList.remove('open');
                }
                if (_isSpotsCheckboxChecked()) displaySpots();
            } catch (err) {
                showToast(`Delete failed: ${err.message}`, 'failed');
            }
        });
    });

    // Async media loads for each entry
    for (let idx = 0; idx < spotEntries.length; idx++) {
        const entry = spotEntries[idx];

        const imgContainer = content.querySelector(`.media-container-img-${idx}`);
        if (entry.image_local_filename && imgContainer) {
            const url = await getLocalFileUrl(entry.image_local_filename);
            imgContainer.innerHTML = url
                ? `<img src="${url}" style="max-width:100%; border-radius:8px;">`
                : `<p style="font-size:0.8rem; color:red;">Image file missing from disk</p>`;
        }

        const audioContainer = content.querySelector(`.media-container-audio-${idx}`);
        if (entry.audio_local_filename && audioContainer) {
            const url = await getLocalFileUrl(entry.audio_local_filename);
            if (url) {
                audioContainer.innerHTML = `<audio controls src="${url}" style="width:100%;"></audio>`;
            }
        }
    }
}

/**
 * Render the external-files viewer panel.
 *
 * @param {object[]} files  External file records linked to the current spot.
 */
function _openExternalViewer(files) {
    const viewer      = document.getElementById('external-data-viewer');
    const dataContent = document.getElementById('external-data-content');
    if (!viewer || !dataContent) return;

    dataContent.innerHTML = '';
    files.forEach(f => {
        const row = document.createElement('div');
        row.style.cssText = 'padding:10px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center;';

        const info = document.createElement('div');
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-weight:bold; color:var(--text-dark);';
        nameEl.textContent = f.name;
        const typeEl = document.createElement('div');
        typeEl.style.cssText = 'font-size:0.85rem; color:var(--text-muted);';
        typeEl.textContent = `Type: ${f.type}${f.is_reference ? ' (reference)' : ''}`;
        info.appendChild(nameEl);
        info.appendChild(typeEl);

        const delBtn = document.createElement('button');
        delBtn.textContent = '🗑';
        delBtn.title = 'Delete this file';
        delBtn.style.cssText = 'background:none; border:none; color:#dc3545; cursor:pointer; font-size:1.1rem;';
        delBtn.addEventListener('click', async () => {
            if (!confirm(`Delete "${f.name}"? This cannot be undone.`)) return;
            try {
                await deleteExternalFile(f.id);
                showToast('File deleted.', 'success');
                row.remove();
                // Close viewer if empty
                if (dataContent.children.length === 0) closeModal('external-data-viewer');
            } catch (err) {
                showToast(`Delete failed: ${err.message}`, 'failed');
            }
        });

        row.appendChild(info);
        row.appendChild(delBtn);
        dataContent.appendChild(row);
    });

    openModal('external-data-viewer');
}

// ---------------------------------------------------------------------------
// Public — map layer management
// ---------------------------------------------------------------------------

/**
 * Render all spots for the active project as Leaflet CircleMarkers.
 *
 * Clears the existing layer first, then re-creates it from the current
 * MasterData state. Invalid spots (missing coordinates) are skipped with a
 * console warning rather than throwing.
 *
 * Safe to call multiple times — each call rebuilds the layer from scratch.
 */
export function displaySpots() {
    const map = getMap();

    // Remove existing layer cleanly before rebuilding
    if (_spotsLayer) map.removeLayer(_spotsLayer);
    _spotsLayer = L.layerGroup().addTo(map);

    const spots = getSpots();
    if (!spots || spots.length === 0) return;

    // Group by name — show one marker per unique spot name (latest position)
    const spotByName = new Map();
    spots.forEach(spot => {
        if (spot.latitude == null || spot.longitude == null) {
            console.warn('[SpotManager] Skipping invalid spot (missing coords):', spot);
            return;
        }
        const existing = spotByName.get(spot.name);
        if (!existing || new Date(spot.timestamp) > new Date(existing.timestamp)) {
            spotByName.set(spot.name, spot);
        }
    });

    for (const [, spot] of spotByName) {
        const entryCount = spots.filter(s => s.name === spot.name).length;
        const marker = L.circleMarker([spot.latitude, spot.longitude], {
            color       : '#000',
            fillColor   : entryCount > 1 ? '#ff9800' : '#3388ff',
            fillOpacity : 0.8,
            radius      : 10,
            weight      : 1,
        }).addTo(_spotsLayer);

        if (entryCount > 1) {
            marker.bindTooltip(`${spot.name} (${entryCount} entries)`, { direction: 'top' });
        }

        marker.on('click', () => _showSpotDetails(spot));
    }
}

/**
 * Remove all markers from the spots layer without destroying the layer itself.
 * Used when switching projects or unchecking the "Show" checkbox.
 */
export function clearSpotsLayer() {
    if (_spotsLayer) _spotsLayer.clearLayers();
}

// ---------------------------------------------------------------------------
// Public — module initialisation
// ---------------------------------------------------------------------------

/**
 * Wire all DOM event listeners and EventBus subscriptions for the Spots feature.
 *
 * Must be called exactly once from App.js after DOMContentLoaded fires.
 * Defers all document.getElementById calls to this point (Bug 4 fix).
 */
export function initSpots() {

    // --- Audio toggle ---
    _bindAudioToggle();

    // --- Spot form submission ---
    const spotForm = document.getElementById('spot-form');
    if (spotForm) spotForm.addEventListener('submit', _handleSpotFormSubmit);

    // --- Normal "Add" button clears any Add More lock (fresh, editable spot) ---
    document.getElementById('open-form')?.addEventListener('click', () => {
        _setAddMoreMode(null);
    });

    // --- "Current Location" checkbox toggle ---
    const useCurrentLocCb = document.getElementById('use-current-location');
    if (useCurrentLocCb) {
        useCurrentLocCb.addEventListener('change', () => {
            const fields = document.getElementById('custom-location-fields');
            if (fields) fields.style.display = useCurrentLocCb.checked ? 'none' : 'flex';
        });
    }

    // --- "Current Date/Time" checkbox toggle ---
    const useCurrentTimeCb = document.getElementById('use-current-time');
    if (useCurrentTimeCb) {
        useCurrentTimeCb.addEventListener('change', () => {
            const fields = document.getElementById('custom-time-fields');
            if (fields) fields.style.display = useCurrentTimeCb.checked ? 'none' : 'flex';
        });
    }

    // --- "Show Spots" checkbox ---
    const displayCb = document.getElementById('display-spots');
    if (displayCb) {
        displayCb.addEventListener('change', (e) => {
            if (e.target.checked) {
                displaySpots();
            } else {
                // Remove the layer group from the map entirely when unchecked
                if (_spotsLayer) getMap().removeLayer(_spotsLayer);
                _spotsLayer = null;
            }
        });
    }

    // --- Close spot details panel ---
    const closeDetails = document.getElementById('close-spot-details');
    if (closeDetails) {
        closeDetails.addEventListener('click', () => {
            document.getElementById('spot-details-menu')?.classList.remove('open');
        });
    }

    // --- Close external viewer ---
    const closeExternal = document.getElementById('close-external-viewer');
    if (closeExternal) {
        closeExternal.addEventListener('click', () => {
            closeModal('external-data-viewer');
        });
    }

    // -----------------------------------------------------------------------
    // EventBus subscriptions
    // -----------------------------------------------------------------------

    /**
     * PROJECT_CHANGED — clear markers and redisplay only if checkbox is checked.
     * Bug 2 fix: legacy code called displaySpots() unconditionally, causing ghost
     * markers to appear even when the "Show" checkbox was unchecked.
     */
    EventBus.on(EVENTS.PROJECT_CHANGED, () => {
        clearSpotsLayer();
        document.getElementById('spot-details-menu')?.classList.remove('open');
        if (_isSpotsCheckboxChecked()) displaySpots();
    });

    /** DATA_UPDATED — refresh layer if currently displayed */
    EventBus.on(EVENTS.DATA_UPDATED, () => {
        if (_isSpotsCheckboxChecked()) displaySpots();
    });

    /** STORAGE_READY — initial render once storage is open */
    EventBus.on(EVENTS.STORAGE_READY, () => {
        if (_isSpotsCheckboxChecked()) displaySpots();
    });

    console.log('[SpotManager] Initialised.');
}
