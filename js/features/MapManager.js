/**
 * MapManager.js — Leaflet map lifecycle and geolocation
 *
 * Pattern : Module Pattern (IIFE returning a frozen public API)
 *
 * Replaces the legacy js/map.js which leaked three mutable globals:
 *   window.map, window.currLat, window.currLng, window.myLocationMarker
 *
 * All state is now private to this module. Consumers call the exported
 * functions instead of reading window.* properties.
 *
 * Dependency on Leaflet
 * ---------------------
 * Leaflet is loaded via a plain <script> tag in index.html and exposes the
 * global `L` object. This module deliberately does NOT import it as an ES
 * module — there is no build step, and Leaflet's UMD bundle sets window.L
 * before any module scripts run (defer ordering guarantees this).
 *
 * Usage (from App.js or any feature module)
 * -----------------------------------------
 *   import { initMap, getMap, getCurrentPosition } from './features/MapManager.js';
 *   initMap();                              // call once on DOMContentLoaded
 *   const { lat, lng } = getCurrentPosition();
 *   const leafletMap   = getMap();
 */

import Config    from '../core/Config.js';
import EventBus, { EVENTS } from '../core/EventBus.js';

// ---------------------------------------------------------------------------
// Module-private state
// (previously window.map / window.currLat / window.currLng / window.myLocationMarker)
// ---------------------------------------------------------------------------

/** @type {L.Map|null} */
let _map = null;

/** @type {number} */
let _currLat = 0;

/** @type {number} */
let _currLng = 0;

/** @type {L.CircleMarker|null} */
let _locationMarker = null;

/**
 * True once a geolocation-error toast has been shown.
 * Prevents toast spam when watch:true fires `locationerror` repeatedly
 * on machines with no GPS / no location permission (e.g. lab desktops).
 * @type {boolean}
 */
let _geoErrorNotified = false;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Attach Leaflet geolocation handlers and start continuous location watching.
 *
 * `locationfound` — updates the private lat/lng, moves the blue "you are here"
 *                   marker, and refreshes the #latlon label in the sidebar.
 *
 * `locationerror` — Bug fix over legacy map.js which only logged to the
 *                   console. We now emit a TOAST_SHOW event so the user sees
 *                   an actionable message instead of silent failure.
 *
 * @param {L.Map} map
 */
function _attachLocationHandlers(map) {
    map.on('locationfound', (e) => _applyPosition(e.latitude, e.longitude));

    // Bug fix: legacy code only called console.warn — the user had no idea
    // location was unavailable and would see stale (0, 0) coordinates silently.
    map.on('locationerror', (e) => {
        console.warn('[MapManager] Geolocation error:', e.message);

        // Ignore TIMEOUT (code 3): a slow sample is not a real failure — the
        // watch keeps trying and will fire locationfound once a fix lands.
        if (e.code === 3) return;

        // watch:true keeps re-firing this on machines with no GPS dongle /
        // no location permission. Show the toast only ONCE so the user is
        // informed without being spammed. The app stays fully functional —
        // getCurrentPosition() returns the last known (or 0,0) value and the
        // spot form lets the user enter coordinates manually.
        if (_geoErrorNotified) return;
        _geoErrorNotified = true;

        EventBus.emit(EVENTS.TOAST_SHOW, {
            message : 'Location unavailable (no GPS/permission). Use the "custom location" option when adding spots.',
            type    : 'failed',
        });
    });
}

/**
 * Long-press (500ms hold) on map → copy lat,lon to clipboard + toast.
 * Cancelled by mouseup/touchend/drag before threshold.
 *
 * @param {L.Map} map
 */
function _attachLongPressCopy(map) {
    const HOLD_MS = 500;
    let _timer = null;
    let _startLatLng = null;

    const _clear = () => {
        if (_timer) { clearTimeout(_timer); _timer = null; }
        _startLatLng = null;
    };

    const _onStart = (e) => {
        _clear();
        _startLatLng = e.latlng;
        _timer = setTimeout(() => {
            if (!_startLatLng) return;
            const lat = _startLatLng.lat.toFixed(6);
            const lng = _startLatLng.lng.toFixed(6);
            const text = `${lat}, ${lng}`;

            navigator.clipboard.writeText(text).then(() => {
                EventBus.emit(EVENTS.TOAST_SHOW, {
                    message: `Copied: ${text}`,
                    type: 'success',
                });
            }).catch(() => {
                EventBus.emit(EVENTS.TOAST_SHOW, {
                    message: 'Clipboard access denied.',
                    type: 'failed',
                });
            });

            _startLatLng = null;
        }, HOLD_MS);
    };

    const _onMove = (e) => {
        // Cancel if dragged more than ~10px worth of lat/lng
        if (_startLatLng && e.latlng) {
            const d = _startLatLng.distanceTo(e.latlng); // metres
            if (d > 20) _clear();
        }
    };

    map.on('mousedown',  _onStart);
    map.on('mousemove',  _onMove);
    map.on('mouseup',    _clear);
    map.on('dragstart',  _clear);

    // Touch support
    map.on('touchstart', (e) => {
        if (e.latlng) _onStart(e);
    });
    map.on('touchmove',  (e) => {
        if (e.latlng) _onMove(e);
    });
    map.on('touchend',   _clear);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create the Leaflet map, add the tile layer, and start geolocation watching.
 *
 * Must be called exactly once, after the DOM element `#map` exists.
 * Subsequent calls are no-ops (the map is already initialised).
 *
 * Configuration values (centre, zoom, min/max zoom) are read from Config
 * (Configuration Objects pattern) so they never appear as magic
 * numbers scattered through the feature modules.
 */
export function initMap() {
    if (_map) {
        console.warn('[MapManager] initMap() called more than once — ignoring.');
        return;
    }

    _map = L.map('map', {
        minZoom     : Config.map.minZoom,
        maxZoom     : Config.map.maxZoom,
        zoomControl : false,
    }).setView(Config.map.defaultCenter, Config.map.defaultZoom);

    const _tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom      : 19,
        attribution  : '&copy; OpenStreetMap contributors',
        crossOrigin  : true,
        // Preload 4 tiles beyond the visible edge so panning feels instant.
        keepBuffer   : 4,
        // On HiDPI / Retina screens, request standard 256px tiles and let
        // Leaflet upscale them. Without this, some devices request 512px
        // tiles that OSM doesn't serve → systematic missing-tile pattern.
        detectRetina : false,
        // Spread requests across all three subdomains to avoid the browser's
        // per-host connection limit (6 in Chrome). Explicit for clarity.
        subdomains   : ['a', 'b', 'c'],
        // Transparent 1px PNG shown instead of a broken-image icon when a
        // tile request times out. OSM occasionally throttles / a lab
        // firewall may stall requests — this keeps the map usable; tiles
        // re-fetch on the next pan/zoom.
        errorTileUrl : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    }).addTo(_map);

    // Auto-retry failed tiles once after a short delay.
    // OSM throttle is transient — a single retry usually succeeds and
    // eliminates the "checkerboard holes" pattern the user reported.
    _tileLayer.on('tileerror', (ev) => {
        const tile = ev.tile;
        const src  = tile?._origSrc || tile?.src;
        if (src && !tile._retried) {
            tile._retried = true;
            setTimeout(() => { tile.src = src; }, 1500);
        } else {
            console.warn('[MapManager] Tile failed to load after retry:', ev?.coords);
        }
    });

    // Dedicated high pane so the "you are here" marker always sits ABOVE spot
    // and route layers (all of which live in the default overlayPane, z-index
    // 400). 650 keeps us over them but under popups (700).
    _map.createPane('userLocation');
    _map.getPane('userLocation').style.zIndex = 650;

    _attachLocationHandlers(_map);
    _attachLongPressCopy(_map);
    _attachLatLonPillClick();

    _startGeolocation();

    console.log('[MapManager] Map initialised.');
}

/**
 * Make the lat/lon pill a "center on me" control: tapping it flies the map to
 * the user's current location.
 */
function _attachLatLonPillClick() {
    const pill = document.getElementById('latlon');
    if (!pill) return;
    pill.addEventListener('click', () => centerOnCurrentLocation());
}

/**
 * Fly to + center on the user's current location. No-op (with a hint) before a
 * fix exists.
 */
export function centerOnCurrentLocation() {
    if (!_map) return;
    if (!_locationMarker || (_currLat === 0 && _currLng === 0)) {
        EventBus.emit(EVENTS.TOAST_SHOW, {
            message: 'Still finding your location — try again in a moment.',
            type: 'info',
        });
        return;
    }
    const targetZoom = Math.max(_map.getZoom(), 16);
    _map.flyTo([_currLat, _currLng], targetZoom, { duration: 0.6 });
    _locationMarker.bringToFront();
}

/**
 * Begin geolocation.
 *
 * Bug fix: the previous call used `enableHighAccuracy:false` with a 10s timeout.
 * On phones where network/Wi-Fi positioning is unavailable (common when only
 * GPS is enabled), the coarse provider never returns and the request times out
 * even though the device has a working GPS and full permission. We now:
 *   1. Fire a single high-accuracy `getCurrentPosition` with a generous timeout
 *      to get a real GPS fix (a cold fix can take 20–30s).
 *   2. Start Leaflet's continuous watch with high accuracy too, so the marker
 *      keeps updating as the user moves.
 */
function _startGeolocation() {
    // Continuous location watch via Leaflet (feeds locationfound → _applyPosition,
    // and RouteManager's recorder). No `timeout` key: a slow GPS sample should
    // make the watch wait, not throw "Timeout expired".
    _map.locate({
        watch              : true,
        enableHighAccuracy : true,
        maximumAge         : 30000,
    });
}

/**
 * Apply a freshly-resolved position: update state, the sidebar label, and the
 * "you are here" marker. Shared by the one-shot seed and Leaflet's watch.
 *
 * @param {number} lat
 * @param {number} lng
 */
function _applyPosition(lat, lng) {
    _currLat = lat;
    _currLng = lng;
    _geoErrorNotified = false; // a good fix arrived — allow future error toasts again

    const label = document.querySelector('#latlon label');
    // Leading crosshair hints the pill is tappable ("center on me").
    if (label) label.textContent = `◎ Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(5)}`;

    const latlng = L.latLng(lat, lng);
    if (!_locationMarker) {
        _locationMarker = L.circleMarker(latlng, {
            radius: 8, color: '#ffffff', fillColor: '#2196F3', fillOpacity: 1, weight: 2,
            pane: 'userLocation',   // always render above spots/routes
            // Non-interactive: the marker still renders ON TOP (pane z-index 650)
            // but no longer swallows taps. Without this, a spot/route sitting
            // under the blue dot was impossible to tap — the location marker ate
            // the click. interactive:false drops the leaflet-interactive class so
            // pointer events fall through to the layers below.
            interactive: false,
        }).addTo(_map);
    } else {
        _locationMarker.setLatLng(latlng);
    }
}

/**
 * Return the Leaflet map instance.
 *
 * Throws if called before `initMap()` so callers get an immediate, clear error
 * rather than a confusing "cannot call method on null" stack trace.
 *
 * @returns {L.Map}
 * @throws  {Error}  When called before initMap().
 */
export function getMap() {
    if (!_map) {
        throw new Error(
            '[MapManager] getMap() called before initMap(). ' +
            'Call initMap() once from your App bootstrap.'
        );
    }
    return _map;
}

/**
 * Return the most recently observed device coordinates.
 *
 * Before the first `locationfound` event fires both values will be 0.
 * Consumers should check whether the values are non-zero before using them
 * in records that require a real position.
 *
 * @returns {{ lat: number, lng: number }}
 */
export function getCurrentPosition() {
    return { lat: _currLat, lng: _currLng };
}

/**
 * Return the "you are here" CircleMarker, or null if location has not yet
 * been found.
 *
 * Exposed so other modules (e.g. RouteManager) can hook into the same marker
 * without creating a duplicate.
 *
 * @returns {L.CircleMarker|null}
 */
export function getLocationMarker() {
    return _locationMarker;
}
