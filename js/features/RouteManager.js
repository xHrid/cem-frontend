/**
 * RouteManager.js — GPS route tracking and persistence
 *
 * Pattern : Module Pattern (private state + narrow exported API)
 *
 * Replaces the legacy js/route.js. Bugs fixed:
 *
 *  Bug 1 — window.map.on('locationfound', ...) was called at module top level
 *           (import time), before the map had been initialised by MapManager.
 *           Race condition: if this module was imported before initMap() ran,
 *           the call threw "Cannot read properties of null". Fixed: the
 *           locationfound listener is attached inside initRoutes(), which is
 *           called after initMap() in the App bootstrap.
 *
 *  Bug 2 — The save-route dialog was shown with display:"block" which left it
 *           left-aligned instead of centred. Fixed: display:"flex" matches the
 *           .modal CSS which uses flexbox centering (justify-content:center /
 *           align-items:center on a full-viewport overlay).
 *
 *  Bug 3 — No validation for empty route name or fewer than 2 recorded points.
 *           A zero-point route produced a corrupt GeoJSON record.
 *           Fixed: validate before saving and show a toast on failure.
 *
 *  Bug 4 — alert("Route Saved to Drive!") was factually wrong — the route is
 *           saved locally via Repository.saveRoute() (Drive push is fire-and-
 *           forget). Fixed: showToast("Route saved locally", "success").
 *
 * Import graph
 * ------------
 *   EventBus, EVENTS  → ../core/EventBus.js
 *   saveRoute         → ../data/Repository.js
 *   getMap            → ./MapManager.js
 *   showToast         → ../ui/Toast.js
 */

import EventBus, { EVENTS } from '../core/EventBus.js';
import { saveRoute }        from '../data/Repository.js';
import { getMap }           from './MapManager.js';
import { showToast }        from '../ui/Toast.js';
import { openModal, closeModal } from '../ui/ModalManager.js';

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

/** Recorded GPS waypoints for the current tracking session.
 *  @type {Array<{lat: number, lng: number}>} */
let _routePoints = [];

/** @type {L.Polyline|null} — live polyline drawn on the map during tracking */
let _routePolyline = null;

/** @type {boolean} — whether GPS tracking is currently active */
let _isTracking = false;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Handler for Leaflet's locationfound event.
 *
 * Appends the new coordinate to _routePoints and extends the polyline.
 * Only acts when _isTracking is true so the listener can remain attached
 * permanently without accumulating points between sessions.
 *
 * @param {L.LocationEvent} e
 */
function _onLocationFound(e) {
    if (!_isTracking) return;
    _routePoints.push({ lat: e.latitude, lng: e.longitude });
    if (_routePolyline) _routePolyline.addLatLng(e.latlng);
}

/**
 * Show the save-route dialog.
 *
 * Bug 2 fix: uses display:"flex" so the .modal CSS overlay centres the dialog
 * via justify-content:center + align-items:center, matching all other dialogs
 * in the app that use the same pattern.
 */
function _showSaveDialog() {
    openModal('save-route-dialog');
}

/**
 * Hide the save-route dialog.
 */
function _hideSaveDialog() {
    closeModal('save-route-dialog');
}

// ---------------------------------------------------------------------------
// Private — tracking toggle
// ---------------------------------------------------------------------------

/**
 * Toggle GPS tracking on or off.
 *
 * When starting: clears previous points, creates a fresh polyline on the map.
 * When stopping:  shows the save dialog so the user can name the route.
 *
 * @param {HTMLButtonElement} btn — the #toggle-tracking button element
 */
function _handleTrackingToggle(btn) {
    _isTracking = !_isTracking;

    if (_isTracking) {
        // --- Start a new recording session ---
        _routePoints = [];
        const map = getMap();   // Bug 1 fix: getMap() called here, not at import time
        if (_routePolyline) map.removeLayer(_routePolyline);
        _routePolyline = L.polyline([], { color: 'blue' }).addTo(map);

        btn.textContent  = 'Stop & Save';
        btn.style.background = 'red';
    } else {
        // --- Stop and prompt the user to save ---
        btn.textContent      = 'Record';
        btn.style.background = '';
        _showSaveDialog();
    }
}

// ---------------------------------------------------------------------------
// Private — route form submission
// ---------------------------------------------------------------------------

/**
 * Handle the #route-form submit event.
 *
 * Bug 3 fix: validates that a non-empty name was entered and that at least
 *            2 GPS points were recorded before calling saveRoute().
 *
 * Bug 4 fix: shows "Route saved locally" toast instead of the factually
 *            incorrect "Saved to Drive!" alert.
 *
 * @param {SubmitEvent} e
 */
async function _handleRouteFormSubmit(e) {
    e.preventDefault();

    const name = document.getElementById('route-name')?.value?.trim();

    // Bug 3 fix: validate name
    if (!name) {
        showToast('Please enter a name for the route.', 'failed');
        return;
    }

    // Bug 3 fix: validate minimum points
    if (_routePoints.length < 2) {
        showToast('At least 2 GPS points are needed to save a route.', 'failed');
        return;
    }

    try {
        await saveRoute({ name, points: _routePoints });

        // Bug 4 fix: honest, local-save confirmation
        showToast('Route saved locally.', 'success');

        _hideSaveDialog();
        _routePoints = [];

        // Clear the in-progress polyline from the map
        if (_routePolyline) {
            getMap().removeLayer(_routePolyline);
            _routePolyline = null;
        }

        // Reset the name field for the next session
        const routeNameInput = document.getElementById('route-name');
        if (routeNameInput) routeNameInput.value = '';

    } catch (err) {
        console.error('[RouteManager] saveRoute failed:', err);
        showToast(`Error saving route: ${err.message}`, 'failed');
    }
}

// ---------------------------------------------------------------------------
// Public — module initialisation
// ---------------------------------------------------------------------------

/**
 * Wire all DOM event listeners for the Routes feature.
 *
 * Must be called exactly once from App.js after both DOMContentLoaded AND
 * initMap() have completed. This ordering guarantees getMap() succeeds when
 * the locationfound listener is attached to the Leaflet map instance.
 *
 * Sequence in App.js bootstrap:
 *   initMap();       // MapManager — creates L.Map
 *   initRoutes();    // RouteManager — attaches to the now-live map
 */
export function initRoutes() {
    const map = getMap(); // Bug 1 fix: deferred until initRoutes() call time

    // Attach the location listener to the live map instance (Bug 1 fix)
    map.on('locationfound', _onLocationFound);

    // --- Record / Stop & Save toggle button ---
    const toggleBtn = document.getElementById('toggle-tracking');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => _handleTrackingToggle(toggleBtn));
    }

    // --- Route name form submission ---
    const routeForm = document.getElementById('route-form');
    if (routeForm) {
        routeForm.addEventListener('submit', _handleRouteFormSubmit);
    }

    // --- Dialog close (X) button ---
    const closeBtn = document.querySelector('#save-route-dialog .close');
    if (closeBtn) {
        closeBtn.addEventListener('click', _hideSaveDialog);
    }

    console.log('[RouteManager] Initialised.');
}
