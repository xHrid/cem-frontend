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
    map.on('locationfound', (e) => {
        _currLat = e.latitude;
        _currLng = e.longitude;

        // Update the sidebar coordinate label
        const label = document.querySelector('#latlon label');
        if (label) {
            label.textContent = `Lat: ${e.latitude.toFixed(5)}, Lng: ${e.longitude.toFixed(5)}`;
        }

        // Create or reposition the "you are here" marker
        if (!_locationMarker) {
            _locationMarker = L.circleMarker(e.latlng, {
                radius      : 8,
                color       : '#ffffff',
                fillColor   : '#2196F3',
                fillOpacity : 1,
                weight      : 2,
            }).addTo(map).bindPopup('You are here');
        } else {
            _locationMarker.setLatLng(e.latlng);
        }
    });

    // Bug fix: legacy code only called console.warn — the user had no idea
    // location was unavailable and would see stale (0, 0) coordinates silently.
    map.on('locationerror', (e) => {
        console.warn('[MapManager] Geolocation error:', e.message);

        // watch:true keeps re-firing this on machines with no GPS dongle /
        // no location permission. Show the toast only ONCE so the user is
        // informed without being spammed. The app stays fully functional —
        // getCurrentPosition() simply returns the last known (or 0,0) value
        // and the spot form lets the user enter coordinates manually.
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
        // crossOrigin lets the browser reuse cached tiles cleanly.
        crossOrigin  : true,
        // Transparent 1px PNG shown instead of a broken-image icon when a
        // tile request times out. OSM occasionally throttles / a lab
        // firewall may stall requests — this keeps the map usable; tiles
        // re-fetch on the next pan/zoom.
        errorTileUrl : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    }).addTo(_map);

    // Quietly log tile timeouts (do NOT toast — they are transient and the
    // errorTileUrl already prevents broken-image icons).
    _tileLayer.on('tileerror', (ev) => {
        console.warn('[MapManager] Tile failed to load:', ev?.coords);
    });

    _attachLocationHandlers(_map);
    _attachLongPressCopy(_map);

    // Start continuous location watching.
    //  - enableHighAccuracy:false → don't wait on a GPS fix (lab desktops
    //    have no GPS; IP/Wi-Fi positioning is enough and far faster).
    //  - timeout:10000 → give up a single attempt after 10s instead of hanging.
    //  - maximumAge:60000 → accept a cached position up to 1 min old.
    _map.locate({
        watch              : true,
        enableHighAccuracy : false,
        timeout            : 10000,
        maximumAge         : 60000,
    });

    console.log('[MapManager] Map initialised.');
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
