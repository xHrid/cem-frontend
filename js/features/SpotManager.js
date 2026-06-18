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

import Config                         from '../core/Config.js';
import EventBus, { EVENTS }          from '../core/EventBus.js';
import { saveSpot, updateSpot, getLocalFileUrl, deleteSpot, deleteExternalFile } from '../data/Repository.js';
import { getSpots, getExternalFiles, getActiveProjectId } from '../data/MasterData.js';
import { revokeObjectUrls } from '../data/StorageAdapter.js';
import { getMap, getCurrentPosition } from './MapManager.js';
import { showToast }                 from '../ui/Toast.js';
import { openModal, closeModal }     from '../ui/ModalManager.js';
import { downscaleImage }            from '../data/imageUtils.js';
import { downloadMediaFile, getPublicUrl } from '../services/ProjectFilesSync.js';

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

/** @type {L.LayerGroup|null} — the layer that holds all spot circle-markers */
let _spotsLayer = null;

/** Last active project id seen — used to tell a real project SWITCH apart from a
 *  background data refresh (sync also emits PROJECT_CHANGED). */
let _lastProjectId = null;

// _drivePublicUrl is now the shared getPublicUrl() from ProjectFilesSync.

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
 * Pending image files for the spot form (multi-image support).
 * Each element: { file: File, id: string }
 * @type {{ file: File, id: string }[]}
 */
let _pendingImages = [];

/**
 * Render the image preview grid from _pendingImages.
 */
function _renderImagePreviews() {
    const grid = document.getElementById('image-preview-grid');
    if (!grid) return;
    grid.innerHTML = '';
    _pendingImages.forEach((item) => {
        const thumb = document.createElement('div');
        thumb.className = 'image-preview-thumb';

        const img = document.createElement('img');
        img.src = URL.createObjectURL(item.file);
        img.onload = () => URL.revokeObjectURL(img.src);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'remove-img-btn';
        btn.textContent = '✕';
        btn.addEventListener('click', () => {
            _pendingImages = _pendingImages.filter(i => i.id !== item.id);
            _renderImagePreviews();
        });

        thumb.appendChild(img);
        thumb.appendChild(btn);
        grid.appendChild(thumb);
    });
}

/**
 * Add files to _pendingImages and refresh previews.
 * @param {FileList|File[]} files
 */
function _addImageFiles(files) {
    for (const f of files) {
        _pendingImages.push({ file: f, id: crypto.randomUUID() });
    }
    _renderImagePreviews();
}

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
        if (locFields) locFields.style.display = 'grid';
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

    const statusEl = document.getElementById('status');

    // Downscale all pending images before storage
    const imageBlobs = [];
    if (_pendingImages.length > 0) {
        for (let i = 0; i < _pendingImages.length; i++) {
            if (statusEl) statusEl.textContent = `Optimising photo ${i + 1}/${_pendingImages.length}...`;
            imageBlobs.push(await downscaleImage(_pendingImages[i].file));
        }
    }
    if (statusEl) statusEl.textContent = 'Saving to disk...';

    try {
        await saveSpot(
            {
                name        : spotName,
                description : form.description.value,
                latitude    : lat,
                longitude   : lng,
            },
            imageBlobs.length > 0 ? imageBlobs : null,
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

        // Reset image + audio state
        _pendingImages = [];
        _renderImagePreviews();
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

    // Build header + a horizontal rail of temporal entries (see them side by side)
    const plural = spotEntries.length === 1 ? 'observation' : 'observations';
    let html = `
        <div class="spot-detail-head">
            <h2 id="spot-name"></h2>
            <span class="spot-detail-coords">📍 <span id="spot-coordinates"></span></span>
            <p style="font-size:0.82rem; color:var(--text-muted); margin-top:6px;">${spotEntries.length} ${plural}</p>
        </div>
        <div class="spot-detail-actions">
            <button id="add-more-spot-btn" class="popup-btn btn-addmore" style="width:auto; padding:8px 14px;">+ Add observation</button>
            <button id="show-external-data-btn" class="show-external-data-btn" style="width:auto; margin-top:0;" ${!hasExternal ? 'disabled' : ''}>
                External media (${externalFiles.length})
            </button>
        </div>
        <div class="spot-rail-wrap">
        ${spotEntries.length > 1 ? '<button class="rail-nav prev" aria-label="Previous">‹</button>' : ''}
        <div class="spot-entry-rail">
    `;

    spotEntries.forEach((entry, idx) => {
        html += `
            <div class="spot-entry">
                <button class="edit-spot-entry-btn" data-spot-id="${entry.spotId}" title="Edit this observation">✏️</button>
                <button class="delete-spot-entry-btn" data-spot-id="${entry.spotId}" title="Delete this observation">🗑</button>
                <span class="entry-index">Entry ${idx + 1}</span>
                ${(() => { const ce = entry.created_by || ''; const se = ce.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); return ce ? '<span class="creator-pill" title="' + se + '" tabindex="0">\u{1F464} ' + se + '</span>' : ''; })()}
                <span class="entry-date"></span>
                <div class="entry-field"><span class="k">Coordinates</span><span class="entry-coords" style="font-family:var(--font-mono); font-size:0.82rem;"></span></div>
                <div class="entry-field"><span class="k">Notes</span><span class="entry-desc"></span></div>
                <div class="media-container-img-${idx}"></div>
                <div class="media-container-audio-${idx}"></div>
            </div>
        `;
    });
    html += `</div>${spotEntries.length > 1 ? '<button class="rail-nav next" aria-label="Next">›</button>' : ''}</div>`;

    content.innerHTML = html;

    // Gallery arrows: scroll the rail by one card width.
    const rail = content.querySelector('.spot-entry-rail');
    if (rail) {
        const step = () => (rail.querySelector('.spot-entry')?.getBoundingClientRect().width || rail.clientWidth) + 16;
        content.querySelector('.rail-nav.prev')?.addEventListener('click', () => rail.scrollBy({ left: -step(), behavior: 'smooth' }));
        content.querySelector('.rail-nav.next')?.addEventListener('click', () => rail.scrollBy({ left:  step(), behavior: 'smooth' }));

        // No mouse-scrolling the gallery — only buttons or touch swipe. Block
        // horizontal-intent wheel/trackpad; let vertical wheel scroll the panel.
        rail.addEventListener('wheel', (e) => {
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.preventDefault();
        }, { passive: false });
    }

    // Set user content via textContent (XSS-safe)
    content.querySelector('#spot-name').textContent = spot.name;
    content.querySelector('#spot-coordinates').textContent =
        `${spot.latitude.toFixed(5)}, ${spot.longitude.toFixed(5)}`;

    const entryDivs = content.querySelectorAll('.spot-entry');
    spotEntries.forEach((entry, idx) => {
        const div = entryDivs[idx];
        if (!div) return;
        div.querySelector('.entry-date').textContent = new Date(entry.timestamp || Date.now()).toLocaleString();
        div.querySelector('.entry-coords').textContent =
            `${entry.latitude.toFixed(5)}, ${entry.longitude.toFixed(5)}`;
        div.querySelector('.entry-desc').textContent = entry.description || 'No notes';

        // Tap-to-expand creator pill
        const pill = div.querySelector('.creator-pill');
        if (pill) pill.addEventListener('click', () => pill.classList.toggle('expanded'));
    });

    menu.classList.add('open');
    document.body.classList.add('panel-open');

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
                    document.body.classList.remove('panel-open');
                }
                if (_isSpotsCheckboxChecked()) displaySpots();
            } catch (err) {
                showToast(`Delete failed: ${err.message}`, 'failed');
            }
        });
    });

    // Edit buttons for each entry — swap the card into an inline editor.
    content.querySelectorAll('.edit-spot-entry-btn').forEach((btn, idx) => {
        btn.addEventListener('click', () => {
            const entry = spotEntries[idx];
            const div   = entryDivs[idx];
            if (entry && div) _beginEntryEdit(spot, entry, div);
        });
    });

    // Async media loads for each entry
    for (let idx = 0; idx < spotEntries.length; idx++) {
        const entry = spotEntries[idx];

        // ── Images ──────────────────────────────────────────────────────────
        const imgContainer = content.querySelector(`.media-container-img-${idx}`);
        const imgPaths = entry.images && entry.images.length > 0
            ? entry.images
            : (entry.image_local_filename ? [entry.image_local_filename] : []);

        if ((imgPaths.length > 0 || entry.image_drive_id) && imgContainer) {
            let imgHtml = '';
            let anyLocal = false;
            for (const imgPath of imgPaths) {
                const url = await getLocalFileUrl(imgPath);
                if (url) {
                    imgHtml += `<img src="${url}" style="max-width:100%; border-radius:8px; margin-bottom:6px;">`;
                    anyLocal = true;
                }
                // Not local — will fall through to Drive URL below
            }
            // No local images but a Drive ID exists → show from public URL
            // (images don't have CORS issues with <img> tags)
            if (!anyLocal && entry.image_drive_id) {
                const src = getPublicUrl(entry.image_drive_id, 'image');
                imgHtml = `<img src="${src}" referrerpolicy="no-referrer" style="max-width:100%; border-radius:8px;">`;
                // Offer to cache locally
                imgHtml += `<button class="on-demand-dl" data-drive-id="${entry.image_drive_id}" data-rel-path="${entry.image_local_filename || ''}" data-kind="image" style="font-size:0.78rem; background:none; border:1px solid var(--border-color); border-radius:6px; padding:4px 10px; margin-top:4px; cursor:pointer; color:var(--text-muted);">⬇ Save locally</button>`;
            } else if (!anyLocal && imgPaths.length > 0) {
                // Has paths but not on disk and no drive_id
                imgHtml = `<p style="font-size:0.8rem; color:var(--text-muted);">Image not available locally</p>`;
            }
            imgContainer.innerHTML = imgHtml;
        }

        // ── Audio (on-demand: CORS blocks public URL playback) ──────────────
        const audioContainer = content.querySelector(`.media-container-audio-${idx}`);
        if ((entry.audio_local_filename || entry.audio_drive_id) && audioContainer) {
            const url = entry.audio_local_filename
                ? await getLocalFileUrl(entry.audio_local_filename)
                : null;
            if (url) {
                audioContainer.innerHTML = `<audio controls src="${url}" style="width:100%;"></audio>`;
            } else if (entry.audio_drive_id) {
                const dl = getPublicUrl(entry.audio_drive_id, 'audio');
                if (Config.proxy?.workerUrl) {
                    // Proxy adds CORS headers → inline <audio> playback works
                    audioContainer.innerHTML =
                        `<audio controls src="${dl}" style="width:100%;"></audio>` +
                        `<button class="on-demand-dl" data-drive-id="${entry.audio_drive_id}" data-rel-path="${entry.audio_local_filename || ''}" data-kind="audio" style="font-size:0.78rem; background:none; border:1px solid var(--border-color); border-radius:6px; padding:4px 10px; margin-top:4px; cursor:pointer; color:var(--text-muted);">⬇ Save locally</button>`;
                } else {
                    // No proxy — CORS blocks <audio>. Show download button.
                    audioContainer.innerHTML =
                        `<div class="on-demand-audio" style="display:flex; align-items:center; gap:8px; padding:8px 12px; background:var(--bg-surface-alt, #f5f5f5); border-radius:8px; margin-top:4px;">` +
                            `<span style="font-size:1.1rem;">🎤</span>` +
                            `<span style="flex:1; font-size:0.85rem; color:var(--text-dark);">Audio on Drive</span>` +
                            `<button class="on-demand-dl" data-drive-id="${entry.audio_drive_id}" data-rel-path="${entry.audio_local_filename || ''}" data-kind="audio" style="font-size:0.82rem; padding:5px 12px; border-radius:6px; border:none; background:var(--forest, #2e7d32); color:#fff; cursor:pointer; font-weight:600;">⬇ Download</button>` +
                            `<a href="${dl}" target="_blank" rel="noopener" style="font-size:0.78rem; color:var(--text-muted); text-decoration:none;" title="Open in browser">↗</a>` +
                        `</div>`;
                }
            }
        }
    }

    // Wire up on-demand download buttons
    content.querySelectorAll('.on-demand-dl').forEach(btn => {
        btn.addEventListener('click', async () => {
            const { driveId, relPath, kind } = btn.dataset;
            if (!driveId) return;
            btn.disabled = true;
            btn.textContent = 'Downloading...';
            try {
                const result = await downloadMediaFile(driveId, relPath, kind);
                if (result) {
                    showToast('Downloaded — rendering.', 'success');
                    _showSpotDetails(spot); // re-render with local file
                } else {
                    // CORS blocked — open download link in new tab
                    const dl = getPublicUrl(driveId, kind);
                    window.open(dl, '_blank');
                    showToast('Opened download in new tab.', 'info');
                    btn.disabled = false;
                    btn.textContent = '⬇ Download';
                }
            } catch (err) {
                showToast(`Download failed: ${err.message}`, 'failed');
                btn.disabled = false;
                btn.textContent = '⬇ Download';
            }
        });
    });
}

/**
 * Replace one entry card with an inline editor for its notes + photo.
 *
 * Scope is deliberately narrow: notes and the photo only. Name, coordinates and
 * the observation date stay fixed (that's identity, not "details"). Cancel — or
 * closing without saving — re-renders the panel from stored data, so nothing
 * changes unless the user explicitly hits Save.
 *
 * @param {object}      spot   The spot whose panel is open (for re-render).
 * @param {object}      entry  The specific temporal entry being edited.
 * @param {HTMLElement} div    The .spot-entry card element to take over.
 */
async function _beginEntryEdit(spot, entry, div) {
    // Resolve all existing images for preview grid.
    const existingPaths = entry.images && entry.images.length > 0
        ? [...entry.images]
        : (entry.image_local_filename ? [entry.image_local_filename] : []);

    const existingImages = []; // { path, src }
    for (const p of existingPaths) {
        const url = await getLocalFileUrl(p);
        if (url) existingImages.push({ path: p, src: url });
    }
    // Drive-only fallback (single image)
    if (existingImages.length === 0 && entry.image_drive_id) {
        existingImages.push({ path: '__drive__', src: getPublicUrl(entry.image_drive_id, 'image') });
    }

    // State: tracks deletions + new additions
    const deletedPaths = new Set();
    const newFiles = [];   // { file: File, id: string }

    div.innerHTML = `
        <span class="entry-index">Editing entry</span>
        <div class="entry-field">
            <span class="k">Notes</span>
            <textarea class="edit-desc" style="width:100%; min-height:80px; box-sizing:border-box; margin-top:4px;"></textarea>
        </div>
        <div class="entry-field">
            <span class="k">Photos</span>
            <div class="edit-img-grid image-preview-grid" style="margin-top:6px;"></div>
            <div style="display:flex; gap:8px; margin-top:8px;">
                <label style="cursor:pointer; display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border-radius:8px; background:var(--forest); color:var(--on-accent); font-size:0.85rem; font-weight:600;">
                    <span>\u{1F5BC}\u{FE0F} Gallery</span>
                    <input type="file" class="edit-gallery-input" accept="image/*" multiple style="display:none;">
                </label>
                <label style="cursor:pointer; display:inline-flex; align-items:center; gap:6px; padding:8px 14px; border-radius:8px; background:var(--forest); color:var(--on-accent); font-size:0.85rem; font-weight:600;">
                    <span>\u{1F4F8} Camera</span>
                    <input type="file" class="edit-camera-input" accept="image/*" capture="environment" style="display:none;">
                </label>
            </div>
        </div>
        <div class="button-group" style="display:flex; gap:8px; margin-top:12px;">
            <button type="button" class="popup-btn edit-save-btn" style="background:var(--forest,#2e7d32); color:#fff;">Save</button>
            <button type="button" class="popup-btn cancel-btn edit-cancel-btn">Cancel</button>
        </div>
    `;

    const grid = div.querySelector('.edit-img-grid');

    function renderEditGrid() {
        grid.innerHTML = '';
        // Existing images (not deleted)
        existingImages.forEach(img => {
            if (deletedPaths.has(img.path)) return;
            const thumb = document.createElement('div');
            thumb.className = 'image-preview-thumb';
            thumb.innerHTML = `<img src="${img.src}" referrerpolicy="no-referrer"><button type="button" class="remove-img-btn" title="Remove">&times;</button>`;
            thumb.querySelector('.remove-img-btn').addEventListener('click', () => {
                deletedPaths.add(img.path);
                renderEditGrid();
            });
            grid.appendChild(thumb);
        });
        // New files
        newFiles.forEach(item => {
            const thumb = document.createElement('div');
            thumb.className = 'image-preview-thumb';
            const url = URL.createObjectURL(item.file);
            thumb.innerHTML = `<img src="${url}"><button type="button" class="remove-img-btn" title="Remove">&times;</button>`;
            thumb.querySelector('.remove-img-btn').addEventListener('click', () => {
                const idx = newFiles.findIndex(f => f.id === item.id);
                if (idx >= 0) newFiles.splice(idx, 1);
                renderEditGrid();
            });
            grid.appendChild(thumb);
        });
        if (grid.children.length === 0) {
            grid.innerHTML = '<span style="font-size:0.82rem; color:var(--text-muted);">No photos</span>';
        }
    }
    renderEditGrid();

    div.querySelector('.edit-desc').value = entry.description || '';

    // Gallery — add multiple
    div.querySelector('.edit-gallery-input').addEventListener('change', (e) => {
        for (const f of e.target.files) {
            newFiles.push({ file: f, id: crypto.randomUUID() });
        }
        e.target.value = '';
        renderEditGrid();
    });

    // Camera — add one (appends, not override)
    div.querySelector('.edit-camera-input').addEventListener('change', (e) => {
        if (e.target.files[0]) {
            newFiles.push({ file: e.target.files[0], id: crypto.randomUUID() });
        }
        e.target.value = '';
        renderEditGrid();
    });

    // Cancel → clean revert
    div.querySelector('.edit-cancel-btn').addEventListener('click', () => {
        _showSpotDetails(spot);
    });

    // Save → persist notes + image changes
    div.querySelector('.edit-save-btn').addEventListener('click', async (e) => {
        const saveBtn = e.currentTarget;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        try {
            const desc = div.querySelector('.edit-desc').value;
            const addBlobs = [];
            for (const item of newFiles) {
                addBlobs.push(await downscaleImage(item.file));
            }
            const removePaths = [...deletedPaths].filter(p => p !== '__drive__');
            const clearDriveImg = deletedPaths.has('__drive__');

            await updateSpot(entry.spotId, { description: desc }, addBlobs, removePaths, clearDriveImg);
            showToast('Observation updated.', 'success');

            _showSpotDetails(spot);
            if (_isSpotsCheckboxChecked()) displaySpots();
        } catch (err) {
            console.error('[SpotManager] updateSpot failed:', err);
            showToast(`Update failed: ${err.message}`, 'failed');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
        }
    });
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

    // --- Multi-image: gallery picker (multiple) ---
    const imageUpload = document.getElementById('image-upload');
    if (imageUpload) {
        imageUpload.addEventListener('change', () => {
            if (imageUpload.files.length) _addImageFiles(imageUpload.files);
            imageUpload.value = '';   // allow re-selecting same files
        });
    }

    // --- Multi-image: camera capture (single shot, appended) ---
    const cameraInput = document.getElementById('camera-capture');
    const cameraBtn   = document.getElementById('camera-capture-btn');
    if (cameraBtn && cameraInput) {
        cameraBtn.addEventListener('click', () => cameraInput.click());
        cameraInput.addEventListener('change', () => {
            if (cameraInput.files.length) _addImageFiles(cameraInput.files);
            cameraInput.value = '';
        });
    }

    // --- Spot form submission ---
    const spotForm = document.getElementById('spot-form');
    if (spotForm) spotForm.addEventListener('submit', _handleSpotFormSubmit);

    // --- Normal "Add" button clears any Add More lock (fresh, editable spot) ---
    document.getElementById('open-form')?.addEventListener('click', () => {
        _pendingImages = [];
        _renderImagePreviews();
        _setAddMoreMode(null);
    });

    // --- "Current Location" checkbox toggle ---
    const useCurrentLocCb = document.getElementById('use-current-location');
    if (useCurrentLocCb) {
        useCurrentLocCb.addEventListener('change', () => {
            const fields = document.getElementById('custom-location-fields');
            if (fields) fields.style.display = useCurrentLocCb.checked ? 'none' : 'grid';
        });
    }

    // --- "Current Date/Time" checkbox toggle ---
    const useCurrentTimeCb = document.getElementById('use-current-time');
    if (useCurrentTimeCb) {
        useCurrentTimeCb.addEventListener('change', () => {
            const fields = document.getElementById('custom-time-fields');
            if (fields) fields.style.display = useCurrentTimeCb.checked ? 'none' : 'grid';
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
            document.body.classList.remove('panel-open');
            // Release the Object URLs this panel created for its images/audio.
            revokeObjectUrls();
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
        const pid = getActiveProjectId();
        const switched = pid !== _lastProjectId;
        _lastProjectId = pid;

        clearSpotsLayer();
        // Only close the open details panel on a REAL project switch — a routine
        // Drive sync also fires PROJECT_CHANGED and must not slam the panel shut.
        if (switched) {
            document.getElementById('spot-details-menu')?.classList.remove('open');
            document.body.classList.remove('panel-open');
            revokeObjectUrls(); // free media URLs from the now-closed details panel
        }
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
