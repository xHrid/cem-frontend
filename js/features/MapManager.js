import Config    from '../core/Config.js';
import EventBus, { EVENTS } from '../core/EventBus.js';

let _map = null;

let _currLat = 0;

let _currLng = 0;

let _locationMarker = null;

let _geoErrorNotified = false;

function _attachLocationHandlers(map) {
    map.on('locationfound', (e) => _applyPosition(e.latitude, e.longitude));

    map.on('locationerror', (e) => {
        console.warn('[MapManager] Geolocation error:', e.message);

        if (e.code === 3) return;

        if (_geoErrorNotified) return;
        _geoErrorNotified = true;

        EventBus.emit(EVENTS.TOAST_SHOW, {
            message : 'Location unavailable (no GPS/permission). Use the "custom location" option when adding spots.',
            type    : 'failed',
        });
    });
}

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
        if (_startLatLng && e.latlng) {
            const d = _startLatLng.distanceTo(e.latlng);
            if (d > 20) _clear();
        }
    };

    map.on('mousedown',  _onStart);
    map.on('mousemove',  _onMove);
    map.on('mouseup',    _clear);
    map.on('dragstart',  _clear);

    map.on('touchstart', (e) => {
        if (e.latlng) _onStart(e);
    });
    map.on('touchmove',  (e) => {
        if (e.latlng) _onMove(e);
    });
    map.on('touchend',   _clear);
}

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
        keepBuffer   : 4,
        detectRetina : false,
        subdomains   : ['a', 'b', 'c'],
        errorTileUrl : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    }).addTo(_map);

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

    _map.createPane('userLocation');
    _map.getPane('userLocation').style.zIndex = 650;

    _attachLocationHandlers(_map);
    _attachLongPressCopy(_map);
    _attachLatLonPillClick();

    _startGeolocation();

}

function _attachLatLonPillClick() {
    const pill = document.getElementById('latlon');
    if (!pill) return;
    pill.addEventListener('click', () => centerOnCurrentLocation());
}

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

function _startGeolocation() {
    _map.locate({
        watch              : true,
        enableHighAccuracy : true,
        maximumAge         : 30000,
    });
}

function _applyPosition(lat, lng) {
    _currLat = lat;
    _currLng = lng;
    _geoErrorNotified = false;

    const label = document.querySelector('#latlon label');
    if (label) label.textContent = `◎ Lat: ${lat.toFixed(5)}, Lng: ${lng.toFixed(5)}`;

    const latlng = L.latLng(lat, lng);
    if (!_locationMarker) {
        _locationMarker = L.circleMarker(latlng, {
            radius: 8, color: '#ffffff', fillColor: '#2196F3', fillOpacity: 1, weight: 2,
            pane: 'userLocation',
            interactive: false,
        }).addTo(_map);
    } else {
        _locationMarker.setLatLng(latlng);
    }
}

export function getMap() {
    if (!_map) {
        throw new Error(
            '[MapManager] getMap() called before initMap(). ' +
            'Call initMap() once from your App bootstrap.'
        );
    }
    return _map;
}

export function getCurrentPosition() {
    return { lat: _currLat, lng: _currLng };
}

export function getLocationMarker() {
    return _locationMarker;
}
