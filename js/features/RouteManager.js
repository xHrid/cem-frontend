/**
 * RouteManager.js — GPS route tracking, display, and point annotations
 *
 * Pattern : Module Pattern (private state + narrow exported API)
 *
 * Model
 * -----
 * A route is a transect walk: an ordered, de-duplicated array of {lat,lng}
 * points. Routes are first-class LOCATION OBJECTS, treated like spots — you can
 * pin observations (photo / audio / description) to any point along the line.
 *
 *   route = {
 *     id, projectId, name, timestamp,
 *     points:      [{lat,lng}, ...],          // the walked line (stored efficiently)
 *     annotations: [{ id, latitude, longitude, description,
 *                     image_local_filename, audio_local_filename, timestamp }, ...]
 *   }
 *
 * Features
 * --------
 *  - Record a walk (live polyline) → save with a name.
 *  - "Show" toggle renders every saved route + its annotation markers.
 *  - Tap a point on a route → a highlighted circle marks the spot and a side
 *    form opens to add photo/audio/description (with "Add another").
 *  - Tap an annotation marker → view its media, add more, or delete.
 *
 * Bug history (kept): see git log. Routes previously recorded but never
 * displayed because no render path existed; annotations were not supported.
 */

import Config                   from '../core/Config.js';
import EventBus, { EVENTS }     from '../core/EventBus.js';
import {
    saveRoute,
    saveRouteAnnotation,
    deleteRouteAnnotation,
    getLocalFileUrl,
}                                from '../data/Repository.js';
import { getRoutes, getActiveProjectId } from '../data/MasterData.js';
import { getMap }               from './MapManager.js';
import { showToast }            from '../ui/Toast.js';
import { openModal, closeModal } from '../ui/ModalManager.js';
import { downscaleImage }       from '../data/imageUtils.js';
import { downloadMediaFile, getPublicUrl } from '../services/ProjectFilesSync.js';

// ---------------------------------------------------------------------------
// Module-private state — recording
// ---------------------------------------------------------------------------

/** @type {Array<{lat:number,lng:number}>} live waypoints for the current session */
let _routePoints = [];
/** @type {L.Polyline|null} live polyline drawn while recording */
let _routePolyline = null;
/** @type {boolean} */
let _isTracking = false;

/**
 * Annotations the user pins WHILE recording, before the route has an id. Each is
 * { latitude, longitude, description, imageFile, audioBlob }. Flushed onto the
 * real route (via saveRouteAnnotation) the moment the route is saved.
 * @type {Array<object>}
 */
let _pendingAnnotations = [];
/** @type {L.LayerGroup|null} shows the pending pins on the map during recording. */
let _liveAnnoLayer = null;

/** Sentinel routeId used by the annotation form while a route is still recording. */
const LIVE_ROUTE_ID = '__live__';

// ---------------------------------------------------------------------------
// Module-private state — display + annotation
// ---------------------------------------------------------------------------

/** @type {L.LayerGroup|null} holds all saved-route polylines + annotation markers */
let _routesLayer = null;
/** @type {L.CircleMarker|null} the temporary "you are adding here" highlight */
let _draftMarker = null;
/** Route + coords currently targeted by the annotation form. */
let _annotationTarget = null; // { routeId, lat, lng }

/** Last active project id — distinguishes a real switch from a sync refresh. */
let _lastProjectId = null;

// Annotation audio recording state (self-contained — independent of SpotManager)
let _mediaRecorder = null;
let _audioChunks = [];
let _recordedAudioBlob = null;

const HIGHLIGHT_COLOR = '#e91e63';   // draft point being added
const ANNOTATION_COLOR = '#ff5722';  // saved annotation markers
const ROUTE_COLOR = '#1565c0';       // saved route line

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

function _onLocationFound(e) {
    if (!_isTracking) return;
    _routePoints.push({ lat: e.latitude, lng: e.longitude });
    if (_routePolyline) _routePolyline.addLatLng(e.latlng);
}

function _handleTrackingToggle(btn) {
    _isTracking = !_isTracking;

    if (_isTracking) {
        _routePoints = [];
        const map = getMap();
        if (_routePolyline) map.removeLayer(_routePolyline);
        _routePolyline = L.polyline([], { color: 'blue', weight: 4 }).addTo(map);

        // Let the user pin observations onto the route AS THEY WALK — same form
        // as a saved route, just buffered until the route gets an id on save.
        _routePolyline.on('click', (e) => {
            if (!_isTracking) return;
            L.DomEvent.stopPropagation(e);
            _beginAnnotation(LIVE_ROUTE_ID, e.latlng.lat, e.latlng.lng);
        });

        // Fresh recording session — drop any pins left over from an abandoned one.
        _pendingAnnotations = [];
        if (_liveAnnoLayer) map.removeLayer(_liveAnnoLayer);
        _liveAnnoLayer = L.layerGroup().addTo(map);

        showToast('Recording — tap the blue line to pin a photo or note.', 'success');

        btn.textContent      = 'Stop & Save';
        btn.style.background  = 'red';
    } else {
        btn.textContent      = 'Record';
        btn.style.background  = '';
        openModal('save-route-dialog');
    }
}

async function _handleRouteFormSubmit(e) {
    e.preventDefault();

    const name = document.getElementById('route-name')?.value?.trim();
    if (!name) {
        showToast('Please enter a name for the route.', 'failed');
        return;
    }
    if (_routePoints.length < 2) {
        showToast('At least 2 GPS points are needed to save a route.', 'failed');
        return;
    }

    try {
        const newRoute = await saveRoute({ name, points: _dedupePoints(_routePoints) });
        showToast('Route saved locally.', 'success');

        // Flush any observations the user pinned while walking onto the new route.
        if (_pendingAnnotations.length) {
            let failed = 0;
            for (const a of _pendingAnnotations) {
                try {
                    await saveRouteAnnotation(
                        newRoute.id,
                        { latitude: a.latitude, longitude: a.longitude, description: a.description },
                        a.imageFile,
                        a.audioBlob
                    );
                } catch (annErr) {
                    failed++;
                    console.error('[RouteManager] pending annotation failed:', annErr);
                }
            }
            const saved = _pendingAnnotations.length - failed;
            if (saved) showToast(`Attached ${saved} pinned observation${saved > 1 ? 's' : ''}.`, 'success');
            if (failed) showToast(`${failed} pinned observation${failed > 1 ? 's' : ''} could not be saved.`, 'failed');
        }
        _pendingAnnotations = [];
        if (_liveAnnoLayer) { getMap().removeLayer(_liveAnnoLayer); _liveAnnoLayer = null; }

        closeModal('save-route-dialog');
        _routePoints = [];

        if (_routePolyline) {
            getMap().removeLayer(_routePolyline);
            _routePolyline = null;
        }

        const routeNameInput = document.getElementById('route-name');
        if (routeNameInput) routeNameInput.value = '';

        // Show the freshly saved route immediately if the toggle is on.
        if (_isRoutesCheckboxChecked()) displayRoutes();
    } catch (err) {
        console.error('[RouteManager] saveRoute failed:', err);
        showToast(`Error saving route: ${err.message}`, 'failed');
    }
}

/**
 * Drop redundant points: skip consecutive samples closer than ~3 m so the
 * stored line stays compact (a route is "an arrow of lat/lons stored
 * efficiently — no redundant info, not very close points").
 *
 * @param {Array<{lat:number,lng:number}>} pts
 * @returns {Array<{lat:number,lng:number}>}
 */
function _dedupePoints(pts) {
    if (pts.length < 2) return pts;
    const MIN_M = 3;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        const a = out[out.length - 1];
        const b = pts[i];
        if (_haversine(a.lat, a.lng, b.lat, b.lng) >= MIN_M) out.push(b);
    }
    // Always keep the final point so the line ends where the walk ended.
    const last = pts[pts.length - 1];
    if (out[out.length - 1] !== last) out.push(last);
    return out;
}

/** Great-circle distance in metres. */
function _haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Read the show-routes toggle state. */
function _isRoutesCheckboxChecked() {
    const cb = document.getElementById('show-routes-toggle');
    return cb ? cb.checked : false;
}

/**
 * Render every saved route for the active project as a polyline, plus a marker
 * for each annotation. Rebuilds the layer from scratch on every call.
 */
export function displayRoutes() {
    const map = getMap();
    if (_routesLayer) map.removeLayer(_routesLayer);
    _routesLayer = L.layerGroup().addTo(map);

    const routes = getRoutes();
    if (!routes || routes.length === 0) return;

    for (const route of routes) {
        const latlngs = (route.points || [])
            .filter(p => p && p.lat != null && p.lng != null)
            .map(p => [p.lat, p.lng]);
        if (latlngs.length < 2) continue;

        const line = L.polyline(latlngs, {
            color: ROUTE_COLOR,
            weight: 4,
            opacity: 0.85,
        }).addTo(_routesLayer);

        line.bindTooltip(route.name || 'Route', { sticky: true });

        // Tap the line → start adding an annotation at the tapped point.
        line.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            _beginAnnotation(route.id, e.latlng.lat, e.latlng.lng);
        });

        // Render existing annotation markers.
        for (const a of (route.annotations || [])) {
            if (a.latitude == null || a.longitude == null) continue;
            const marker = L.circleMarker([a.latitude, a.longitude], {
                color: '#000',
                fillColor: ANNOTATION_COLOR,
                fillOpacity: 0.9,
                radius: 7,
                weight: 1,
            }).addTo(_routesLayer);
            marker.bindTooltip(a.description ? a.description.slice(0, 40) : 'Observation', { direction: 'top' });
            marker.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                _showAnnotationDetails(route, a);
            });
        }
    }
}

/** Remove the routes layer from the map entirely. */
export function clearRoutesLayer() {
    if (_routesLayer) {
        getMap().removeLayer(_routesLayer);
        _routesLayer = null;
    }
    _clearDraftMarker();
}

function _clearDraftMarker() {
    if (_draftMarker) {
        getMap().removeLayer(_draftMarker);
        _draftMarker = null;
    }
}

// ---------------------------------------------------------------------------
// Annotation — side panel form
// ---------------------------------------------------------------------------

/**
 * Begin annotating a point: drop a highlighted circle at the tapped location
 * and open the side form. Mirrors the spot "add" experience.
 */
function _beginAnnotation(routeId, lat, lng) {
    _annotationTarget = { routeId, lat, lng };

    _clearDraftMarker();
    _draftMarker = L.circleMarker([lat, lng], {
        color: '#fff',
        fillColor: HIGHLIGHT_COLOR,
        fillOpacity: 1,
        radius: 9,
        weight: 3,
    }).addTo(getMap());

    _resetAnnotationAudio();
    _renderAnnotationForm(lat, lng);
    _openRoutePanel();
}

/** Build the form markup inside the route side panel. */
function _renderAnnotationForm(lat, lng) {
    const content = document.getElementById('route-panel-content');
    if (!content) return;

    content.innerHTML = `
        <h2 style="margin-top:0;">Add to route</h2>
        <p style="font-size:0.85rem; color:var(--text-muted);">
            Point: (${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)})
        </p>
        <form id="route-annotation-form">
            <textarea id="route-ann-desc" placeholder="Description / notes"
                style="width:100%; min-height:70px; box-sizing:border-box; margin-bottom:8px;"></textarea>

            <div class="media-controls" style="display:flex; gap:10px; align-items:center; margin-bottom:8px;">
                <label for="route-ann-image" class="custom-upload" style="cursor:pointer;"><span>📷</span></label>
                <input type="file" id="route-ann-image" accept="image/*" capture="environment" style="display:none;" />
                <label id="route-ann-audio-toggle" class="custom-upload" style="cursor:pointer;"><span>🎤</span></label>
                <audio id="route-ann-playback" controls style="height:32px;"></audio>
            </div>
            <div id="route-ann-image-name" style="font-size:0.8rem; color:var(--text-muted); margin-bottom:8px;"></div>

            <div class="button-group" style="display:flex; gap:8px;">
                <button type="submit" class="popup-btn">Save</button>
                <button type="button" id="route-ann-cancel" class="popup-btn cancel-btn">Cancel</button>
            </div>
        </form>
    `;

    document.getElementById('route-annotation-form')
        ?.addEventListener('submit', _handleAnnotationSubmit);
    document.getElementById('route-ann-cancel')
        ?.addEventListener('click', () => { _closeRoutePanel(); _clearDraftMarker(); });
    document.getElementById('route-ann-image')
        ?.addEventListener('change', (e) => {
            const f = e.target.files[0];
            const el = document.getElementById('route-ann-image-name');
            if (el) el.textContent = f ? `Photo: ${f.name}` : '';
        });
    _bindAnnotationAudioToggle();
}

async function _handleAnnotationSubmit(e) {
    e.preventDefault();
    if (!_annotationTarget) return;

    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving...'; }

    try {
        let imageFile = document.getElementById('route-ann-image')?.files[0] || null;
        if (imageFile) imageFile = await downscaleImage(imageFile);

        const desc = document.getElementById('route-ann-desc')?.value || '';
        const { routeId, lat, lng } = _annotationTarget;

        if (routeId === LIVE_ROUTE_ID) {
            // Route not saved yet — buffer the observation and pin it on the map.
            // It gets persisted onto the real route in _handleRouteFormSubmit.
            _pendingAnnotations.push({
                latitude: lat, longitude: lng, description: desc,
                imageFile, audioBlob: _recordedAudioBlob,
            });
            if (_liveAnnoLayer) {
                L.circleMarker([lat, lng], {
                    color: '#000', fillColor: ANNOTATION_COLOR, fillOpacity: 0.9, radius: 7, weight: 1,
                }).addTo(_liveAnnoLayer)
                  .bindTooltip(desc ? desc.slice(0, 40) : 'Observation', { direction: 'top' });
            }
            showToast('Pinned — saves with the route when you stop.', 'success');
        } else {
            await saveRouteAnnotation(
                routeId,
                { latitude: lat, longitude: lng, description: desc },
                imageFile,
                _recordedAudioBlob
            );
            showToast('Added to route.', 'success');
        }

        _resetAnnotationAudio();
        _clearDraftMarker();
        _closeRoutePanel();

        if (_isRoutesCheckboxChecked()) displayRoutes();
    } catch (err) {
        console.error('[RouteManager] saveRouteAnnotation failed:', err);
        showToast(`Could not save: ${err.message}`, 'failed');
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Save'; }
    }
}

// ---------------------------------------------------------------------------
// Annotation — details view
// ---------------------------------------------------------------------------

async function _showAnnotationDetails(route, ann) {
    const content = document.getElementById('route-panel-content');
    if (!content) return;

    content.innerHTML = `
        <h2 style="margin-top:0;">Route observation</h2>
        <p style="font-size:0.85rem; color:var(--text-muted);">
            ${route.name || 'Route'} — (${Number(ann.latitude).toFixed(5)}, ${Number(ann.longitude).toFixed(5)})<br>
            <small>${new Date(ann.timestamp || Date.now()).toLocaleString()}</small>
        </p>
        <p><strong>Description:</strong> <span id="route-ann-desc-view"></span></p>
        <div id="route-ann-img" style="margin:10px 0;"></div>
        <div id="route-ann-aud" style="margin:10px 0;"></div>
        <div class="button-group" style="display:flex; gap:8px; flex-wrap:wrap;">
            <button type="button" id="route-ann-addmore" class="popup-btn" style="background:#4CAF50; color:#fff;">+ Add here</button>
            <button type="button" id="route-ann-delete" class="popup-btn" style="background:#dc3545; color:#fff;">Delete</button>
            <button type="button" id="route-ann-close" class="popup-btn cancel-btn">Close</button>
        </div>
    `;
    content.querySelector('#route-ann-desc-view').textContent = ann.description || 'No notes';

    // ── Image (local first, public URL for Drive-only — no CORS issue with <img>) ──
    const imgBox = content.querySelector('#route-ann-img');
    if (ann.image_local_filename || ann.image_drive_id) {
        const url = ann.image_local_filename ? await getLocalFileUrl(ann.image_local_filename) : null;
        if (url) {
            imgBox.innerHTML = `<img src="${url}" style="max-width:100%; border-radius:8px;">`;
        } else if (ann.image_drive_id) {
            const src = getPublicUrl(ann.image_drive_id, 'image');
            imgBox.innerHTML =
                `<img src="${src}" referrerpolicy="no-referrer" style="max-width:100%; border-radius:8px;">` +
                `<button class="on-demand-dl" data-drive-id="${ann.image_drive_id}" data-rel-path="${ann.image_local_filename || ''}" data-kind="image" style="font-size:0.78rem; background:none; border:1px solid var(--border-color); border-radius:6px; padding:4px 10px; margin-top:4px; cursor:pointer; color:var(--text-muted);">⬇ Save locally</button>`;
        }
    }

    // ── Audio (on-demand: CORS blocks public URL playback) ──
    const audBox = content.querySelector('#route-ann-aud');
    if (ann.audio_local_filename || ann.audio_drive_id) {
        const url = ann.audio_local_filename ? await getLocalFileUrl(ann.audio_local_filename) : null;
        if (url) {
            audBox.innerHTML = `<audio controls src="${url}" style="width:100%;"></audio>`;
        } else if (ann.audio_drive_id) {
            const dl = getPublicUrl(ann.audio_drive_id, 'audio');
            if (Config.proxy?.workerUrl) {
                // Proxy adds CORS headers → inline <audio> works
                audBox.innerHTML =
                    `<audio controls src="${dl}" style="width:100%;"></audio>` +
                    `<button class="on-demand-dl" data-drive-id="${ann.audio_drive_id}" data-rel-path="${ann.audio_local_filename || ''}" data-kind="audio" style="font-size:0.78rem; background:none; border:1px solid var(--border-color); border-radius:6px; padding:4px 10px; margin-top:4px; cursor:pointer; color:var(--text-muted);">⬇ Save locally</button>`;
            } else {
                audBox.innerHTML =
                    `<div class="on-demand-audio" style="display:flex; align-items:center; gap:8px; padding:8px 12px; background:var(--bg-surface-alt, #f5f5f5); border-radius:8px; margin-top:4px;">` +
                        `<span style="font-size:1.1rem;">🎤</span>` +
                        `<span style="flex:1; font-size:0.85rem; color:var(--text-dark);">Audio on Drive</span>` +
                        `<button class="on-demand-dl" data-drive-id="${ann.audio_drive_id}" data-rel-path="${ann.audio_local_filename || ''}" data-kind="audio" style="font-size:0.82rem; padding:5px 12px; border-radius:6px; border:none; background:var(--forest, #2e7d32); color:#fff; cursor:pointer; font-weight:600;">⬇ Download</button>` +
                        `<a href="${dl}" target="_blank" rel="noopener" style="font-size:0.78rem; color:var(--text-muted); text-decoration:none;" title="Open in browser">↗</a>` +
                    `</div>`;
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
                    _showAnnotationDetails(route, ann); // re-render
                } else {
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

    content.querySelector('#route-ann-close')?.addEventListener('click', _closeRoutePanel);
    content.querySelector('#route-ann-addmore')?.addEventListener('click', () => {
        // Add another observation at the same point — same flow as spots' "Add More".
        _beginAnnotation(route.id, ann.latitude, ann.longitude);
    });
    content.querySelector('#route-ann-delete')?.addEventListener('click', async () => {
        if (!confirm('Delete this observation? This cannot be undone.')) return;
        try {
            await deleteRouteAnnotation(route.id, ann.id);
            showToast('Observation deleted.', 'success');
            _closeRoutePanel();
            if (_isRoutesCheckboxChecked()) displayRoutes();
        } catch (err) {
            showToast(`Delete failed: ${err.message}`, 'failed');
        }
    });

    _openRoutePanel();
}

// ---------------------------------------------------------------------------
// Annotation — audio capture (independent of SpotManager)
// ---------------------------------------------------------------------------

function _bindAnnotationAudioToggle() {
    const toggle = document.getElementById('route-ann-audio-toggle');
    if (!toggle) return;
    toggle.addEventListener('click', async () => {
        const idle = !_mediaRecorder || _mediaRecorder.state === 'inactive';
        if (idle) {
            await _startAnnotationRecording();
            if (_mediaRecorder) toggle.style.backgroundColor = 'red';
        } else {
            if (_mediaRecorder.state !== 'inactive') _mediaRecorder.stop();
            toggle.style.backgroundColor = '';
        }
    });
}

async function _startAnnotationRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        _audioChunks = [];
        _recordedAudioBlob = null;
        _mediaRecorder = new MediaRecorder(stream);
        _mediaRecorder.ondataavailable = (e) => _audioChunks.push(e.data);
        _mediaRecorder.onstop = () => {
            _recordedAudioBlob = new Blob(_audioChunks, { type: 'audio/webm' });
            const pb = document.getElementById('route-ann-playback');
            if (pb) pb.src = URL.createObjectURL(_recordedAudioBlob);
        };
        _mediaRecorder.start();
    } catch (err) {
        showToast(`Mic error: ${err.message}`, 'failed');
        _mediaRecorder = null;
    }
}

function _resetAnnotationAudio() {
    _recordedAudioBlob = null;
    _mediaRecorder = null;
    _audioChunks = [];
}

// ---------------------------------------------------------------------------
// Side panel show/hide + injection
// ---------------------------------------------------------------------------

function _openRoutePanel() {
    document.getElementById('route-side-panel')?.classList.add('open');
    document.body.classList.add('panel-open');
}
function _closeRoutePanel() {
    document.getElementById('route-side-panel')?.classList.remove('open');
    document.body.classList.remove('panel-open');
}

/**
 * Inject the route side panel once. Reuses the same slide-in styling contract
 * as the spot-details panel (#spot-details-menu) so it matches the app.
 */
function _ensureSidePanel() {
    if (document.getElementById('route-side-panel')) return;
    const aside = document.createElement('aside');
    aside.id = 'route-side-panel';
    aside.setAttribute('aria-label', 'Route observation');
    aside.innerHTML = `
        <button id="route-panel-close" aria-label="Close">x</button>
        <div id="route-panel-content"></div>
    `;
    document.body.appendChild(aside);
    document.getElementById('route-panel-close')
        ?.addEventListener('click', () => { _closeRoutePanel(); _clearDraftMarker(); });

    // Minimal styling injected once — mirrors #spot-details-menu behaviour but
    // is self-contained so it works even if the stylesheet lacks a rule for it.
    if (!document.getElementById('route-panel-style')) {
        const style = document.createElement('style');
        style.id = 'route-panel-style';
        style.textContent = `
            #route-side-panel {
                position: fixed; top: 0; right: 0; height: 100%; width: 320px;
                max-width: 85vw; background: var(--bg-surface, #fff);
                color: var(--text-dark, #222); box-shadow: -2px 0 12px rgba(0,0,0,0.25);
                transform: translateX(105%); transition: transform 0.3s ease;
                z-index: 1200; padding: 18px; box-sizing: border-box; overflow-y: auto;
            }
            #route-side-panel.open { transform: translateX(0); }
            #route-panel-close {
                position: absolute; top: 10px; right: 12px; border: none;
                background: none; font-size: 1.3rem; cursor: pointer; color: inherit;
            }
        `;
        document.head.appendChild(style);
    }
}

// ---------------------------------------------------------------------------
// Public — module initialisation
// ---------------------------------------------------------------------------

export function initRoutes() {
    const map = getMap();
    map.on('locationfound', _onLocationFound);

    _ensureSidePanel();

    const toggleBtn = document.getElementById('toggle-tracking');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => _handleTrackingToggle(toggleBtn));
    }

    const routeForm = document.getElementById('route-form');
    if (routeForm) routeForm.addEventListener('submit', _handleRouteFormSubmit);

    const closeBtn = document.querySelector('#save-route-dialog .close, #save-route-dialog .cancel-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => closeModal('save-route-dialog'));

    // --- Show Routes toggle ---
    const showCb = document.getElementById('show-routes-toggle');
    if (showCb) {
        showCb.addEventListener('change', (e) => {
            if (e.target.checked) displayRoutes();
            else clearRoutesLayer();
        });
    }

    // --- EventBus: keep the layer fresh, only when the toggle is on ---
    EventBus.on(EVENTS.PROJECT_CHANGED, () => {
        const pid = getActiveProjectId();
        const switched = pid !== _lastProjectId;
        _lastProjectId = pid;

        // A background sync also fires PROJECT_CHANGED — don't tear down the
        // annotation panel the user is filling in unless the project truly changed.
        if (switched) {
            _closeRoutePanel();
            _clearDraftMarker();
        }
        if (_isRoutesCheckboxChecked()) displayRoutes();
        else clearRoutesLayer();
    });
    EventBus.on(EVENTS.DATA_UPDATED, () => {
        if (_isRoutesCheckboxChecked()) displayRoutes();
    });
    EventBus.on(EVENTS.STORAGE_READY, () => {
        if (_isRoutesCheckboxChecked()) displayRoutes();
    });

    console.log('[RouteManager] Initialised.');
}
