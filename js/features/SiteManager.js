import { saveSite, deleteSite } from '../data/Repository.js';
import { showToast }            from '../ui/Toast.js';
import { closeModal, openModal } from '../ui/ModalManager.js';
import { getMap }               from './MapManager.js';
import { getActiveProject, getSites } from '../data/MasterData.js';
import * as StorageAdapter      from '../data/StorageAdapter.js';
import EventBus, { EVENTS }     from '../core/EventBus.js';
import Config                   from '../core/Config.js';
import { isConfigured as serverConfigured } from '../services/ServerService.js';
import { authHeaders } from '../services/AuthService.js';

const _layers = new Map();

const _visible = new Map();

async function _parseKmlCoords(kmlFile) {
    const text   = await kmlFile.text();
    const parser = new DOMParser();
    const doc    = parser.parseFromString(text, 'application/xml');

    const coordEl = doc.querySelector('coordinates');
    if (!coordEl) throw new Error('No <coordinates> element found in KML.');

    const raw = coordEl.textContent.trim();
    const coords = raw.split(/\s+/).map(triple => {
        const [lon, lat] = triple.split(',').map(Number);
        return [lat, lon];
    }).filter(([lat, lon]) => !isNaN(lat) && !isNaN(lon));

    if (coords.length < 3) throw new Error('KML polygon has fewer than 3 valid coordinates.');
    return coords;
}

const OUTLINE_STYLE = {
    color:       '#2e7d32',
    weight:      2.5,
    opacity:     0.85,
    fillColor:   '#2e7d32',
    fillOpacity: 0.08,
};

function _addOutline(siteId, coords, siteName, fitBounds = false) {
    const map = getMap();
    if (!map) return;

    if (_layers.has(siteId)) {
        map.removeLayer(_layers.get(siteId));
    }

    const polygon = L.polygon(coords, OUTLINE_STYLE);
    polygon.bindTooltip(siteName, { sticky: true, className: 'site-tooltip' });
    polygon.addTo(map);
    _layers.set(siteId, polygon);
    _visible.set(siteId, true);

    if (fitBounds) {
        map.fitBounds(polygon.getBounds(), { padding: [30, 30] });
    }
}

function _removeOutline(siteId) {
    const map = getMap();
    const layer = _layers.get(siteId);
    if (layer && map) map.removeLayer(layer);
    _layers.delete(siteId);
    _visible.delete(siteId);
}

function _toggleOutline(siteId) {
    const map   = getMap();
    const layer = _layers.get(siteId);
    if (!layer || !map) return;

    const isVisible = _visible.get(siteId);
    if (isVisible) {
        map.removeLayer(layer);
        _visible.set(siteId, false);
    } else {
        layer.addTo(map);
        _visible.set(siteId, true);
    }
    return !isVisible;
}

function _renderSiteList() {
    const panel   = document.getElementById('site-list-panel');
    const listEl  = document.getElementById('site-list');
    if (!panel || !listEl) return;

    const sites = getSites();
    if (!sites || sites.length === 0) {
        panel.style.display = 'none';
        listEl.innerHTML = '';
        return;
    }

    panel.style.display = '';
    listEl.innerHTML = '';

    for (const site of sites) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:4px 0; font-size:0.82rem;';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = _visible.get(site.id) !== false;
        cb.title = 'Show / hide on map';
        cb.addEventListener('change', () => {
            _toggleOutline(site.id);
        });

        const label = document.createElement('span');
        label.textContent = site.name;
        label.style.cssText = 'flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer;';
        label.title = 'Zoom to site';
        label.addEventListener('click', () => {
            const layer = _layers.get(site.id);
            if (layer) {
                if (!_visible.get(site.id)) {
                    _toggleOutline(site.id);
                    cb.checked = true;
                }
                getMap()?.fitBounds(layer.getBounds(), { padding: [30, 30] });
            }
        });

        const del = document.createElement('button');
        del.textContent = '×';
        del.title = 'Delete site';
        del.style.cssText = 'border:none; background:none; color:var(--danger-red,#dc3545); font-size:1.1rem; cursor:pointer; padding:0 2px; line-height:1;';
        del.addEventListener('click', async () => {
            if (!confirm(`Delete site "${site.name}"?`)) return;
            try {
                _removeOutline(site.id);
                await deleteSite(site.id);
                showToast(`Site "${site.name}" deleted.`, 'success');
                _renderSiteList();
            } catch (err) {
                console.error('[SiteManager] deleteSite failed:', err);
                showToast(`Error deleting site: ${err.message}`, 'failed');
            }
        });

        row.appendChild(cb);
        row.appendChild(label);
        row.appendChild(del);
        listEl.appendChild(row);
    }
}

function _clearAllLayers() {
    const map = getMap();
    for (const [, layer] of _layers) {
        if (map) map.removeLayer(layer);
    }
    _layers.clear();
    _visible.clear();
}

async function _loadProjectSites() {
    _clearAllLayers();

    const sites = getSites();
    if (!sites || sites.length === 0) {
        _renderSiteList();
        return;
    }

    for (const site of sites) {
        if (!site.kml_filename) continue;
        try {
            const blob = await StorageAdapter.getFileBlob(site.kml_filename);
            if (!blob) {
                console.warn(`[SiteManager] KML not found locally for site "${site.name}"`);
                continue;
            }
            const coords = await _parseKmlCoords(blob);
            _addOutline(site.id, coords, site.name);
        } catch (err) {
            console.warn(`[SiteManager] Failed to load site "${site.name}":`, err.message);
        }
    }

    _renderSiteList();
}

let _pendingKmlFile = null;

let _stratLayers = {};
let _stratControl = null;

function _clearStrat() {
    const map = getMap();
    for (const layer of Object.values(_stratLayers)) {
        if (map && map.hasLayer(layer)) map.removeLayer(layer);
    }
    _stratLayers = {};
    if (map && _stratControl) map.removeControl(_stratControl);
    _stratControl = null;
}

function _setStratLayer(k) {
    const map = getMap();
    if (!map) return;
    for (const layer of Object.values(_stratLayers)) {
        if (map.hasLayer(layer)) map.removeLayer(layer);
    }
    if (k && _stratLayers[k]) _stratLayers[k].addTo(map);
}

function _showStratPanel(counts, activeK) {
    const map = getMap();
    if (!map) return;
    if (_stratControl) { map.removeControl(_stratControl); _stratControl = null; }

    const ctrl = L.control({ position: 'bottomright' });
    ctrl.onAdd = function () {
        const div = L.DomUtil.create('div');
        div.style.cssText = 'background:var(--bg-surface,#fff); color:var(--text-dark,#222); padding:8px 10px; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.3); font-size:0.85rem;';
        div.innerHTML =
            '<div style="font-weight:700; margin-bottom:6px;">Clusters</div>' +
            counts.map(k => `<label style="display:block; cursor:pointer; margin:2px 0;"><input type="radio" name="strat-k" value="${k}" ${k === activeK ? 'checked' : ''}> ${k}</label>`).join('') +
            '<label style="display:block; cursor:pointer; margin-top:4px; border-top:1px solid var(--border-color,#ccc); padding-top:4px;"><input type="radio" name="strat-k" value="0"> None</label>';
        L.DomEvent.disableClickPropagation(div);
        div.addEventListener('change', (e) => {
            if (e.target.name === 'strat-k') _setStratLayer(parseInt(e.target.value, 10));
        });
        return div;
    };
    ctrl.addTo(map);
    _stratControl = ctrl;
}

async function _handleSiteFormSubmit(e) {
    e.preventDefault();
    const form = e.target;

    const name = (form.siteName?.value || '').trim();
    if (!name) {
        showToast('Please enter a site name.', 'failed');
        return;
    }

    const fileInput = document.getElementById('kml-upload');
    const file      = fileInput?.files?.[0] || null;
    if (!file) {
        showToast('Please select a KML file before submitting.', 'failed');
        return;
    }

    const statusEl = document.getElementById('add-site-status');

    try {
        if (statusEl) statusEl.textContent = 'Saving…';

        const coords = await _parseKmlCoords(file);
        const siteRecord = await saveSite(name, file, null);
        _addOutline(siteRecord.id, coords, name, true);

        showToast(`Site "${name}" added.`, 'success');
        closeModal('add-site-popup-form');
        form.reset();
        const kmlLabel = document.getElementById('kml-file-name');
        if (kmlLabel) kmlLabel.textContent = 'Choose KML file…';
        _renderSiteList();

        if (serverConfigured()) {
            _pendingKmlFile = file;
            _showStratifyChoice(siteRecord.id);
        }

    } catch (err) {
        console.error('[SiteManager] saveSite failed:', err);
        showToast(`Error saving site: ${err.message}`, 'failed');
    } finally {
        if (statusEl) statusEl.textContent = '';
    }
}

function _showStratifyChoice(siteId) {
    const dialog = document.getElementById('stratify-choice-dialog');
    if (!dialog) return;
    dialog.dataset.siteId = siteId;
    openModal('stratify-choice-dialog');
}

async function _runServerStratification(siteId) {
    if (!_pendingKmlFile) {
        showToast('No KML file available.', 'failed');
        return;
    }

    const statusEl = document.getElementById('stratify-status');
    const btn = document.getElementById('btn-stratify-yes');
    if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
    if (statusEl) statusEl.textContent = 'Sending KML to server for GEE stratification…';

    try {
        const kmlText = await _pendingKmlFile.text();
        const base64 = btoa(unescape(encodeURIComponent(kmlText)));
        const base = (Config.server?.baseUrl || '').replace(/\/+$/, '');
        const maxClusters = parseInt(document.getElementById('stratify-max-clusters')?.value || '5', 10);

        const resp = await fetch(`${base}/api/v1/stratify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true', ...authHeaders() },
            body: JSON.stringify({ kml_content: base64, max_clusters: maxClusters, year: 2024 }),
        });

        if (!resp.ok) {
            const body = await resp.json().catch(() => ({}));
            throw new Error(body.detail || `${resp.status} ${resp.statusText}`);
        }

        const data = await resp.json();
        const results = data.results || [];

        if (statusEl) statusEl.textContent = `Downloading ${results.length} overlay(s)…`;

        _clearStrat();
        const counts = [];
        for (const r of results) {
            const imgUrl = `${base}/api/v1/stratify/overlay/${r.overlay_id}`;
            const imgResp = await fetch(imgUrl, {
                headers: { 'ngrok-skip-browser-warning': 'true' },
            });
            if (!imgResp.ok) continue;

            const blob = await imgResp.blob();
            const fname = `stratify_k${r.cluster_count}_${r.overlay_id}.png`;
            await StorageAdapter.saveFile(blob, fname, ['stratification']);

            const dataUrl = URL.createObjectURL(blob);
            const bounds = L.latLngBounds(
                [r.bounds[0][0], r.bounds[0][1]],
                [r.bounds[1][0], r.bounds[1][1]],
            );
            _stratLayers[r.cluster_count] = L.imageOverlay(dataUrl, bounds, { opacity: 0.7, interactive: false });
            counts.push(r.cluster_count);
        }

        counts.sort((a, b) => a - b);
        if (counts.length) {
            const first = counts[0];
            _setStratLayer(first);
            _showStratPanel(counts, first);
        }

        showToast(`Stratification complete: ${counts.length} overlay(s). Use the panel to switch.`, 'success');
        closeModal('stratify-choice-dialog');
    } catch (e) {
        showToast(`Stratification failed: ${e.message}`, 'failed');
        if (statusEl) statusEl.textContent = `Failed: ${e.message}`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Stratify via Server'; }
        _pendingKmlFile = null;
    }
}

export function initSites() {
    const form = document.getElementById('add-site-form');
    if (!form) {
        console.warn('[SiteManager] #add-site-form not found in DOM — initSites() aborted.');
        return;
    }

    form.addEventListener('submit', _handleSiteFormSubmit);

    const kmlInput = document.getElementById('kml-upload');
    const kmlLabel = document.getElementById('kml-file-name');
    if (kmlInput && kmlLabel) {
        kmlInput.addEventListener('change', () => {
            kmlLabel.textContent = kmlInput.files[0]?.name || 'Choose KML file…';
        });
    }

    document.getElementById('btn-stratify-yes')?.addEventListener('click', () => {
        const dialog = document.getElementById('stratify-choice-dialog');
        const siteId = dialog?.dataset.siteId;
        _runServerStratification(siteId);
    });

    document.getElementById('btn-stratify-no')?.addEventListener('click', () => {
        _pendingKmlFile = null;
        closeModal('stratify-choice-dialog');
    });

    EventBus.on(EVENTS.PROJECT_CHANGED, () => _loadProjectSites());
    EventBus.on(EVENTS.DATA_UPDATED, () => _renderSiteList());

    if (getActiveProject()) {
        _loadProjectSites();
    }
}
