/**
 * SiteManager.js — KML site boundary upload, persistence, and stratification
 *
 * Pattern : Module Pattern (private state + narrow exported API)
 *
 * Flow:
 *   1. User submits Add Site form (name, KML, cluster count)
 *   2. KML + metadata saved locally via Repository.saveSite()
 *   3. Stratification runs in-browser: KML → satellite embeddings (COG)
 *      → K-means → classified overlay on Leaflet map
 *   4. Overlay images saved to the site record for persistence
 *
 * Import graph
 * ------------
 *   saveSite  → ../data/Repository.js
 *   showToast → ../ui/Toast.js
 *   runStratification, createOverlay → ../services/StratificationService.js
 *   getMap → ./MapManager.js
 */

import { saveSite }       from '../data/Repository.js';
import { showToast }      from '../ui/Toast.js';
import { closeModal }     from '../ui/ModalManager.js';
import { getMap }         from './MapManager.js';
import { runStratification, createOverlay } from '../services/StratificationService.js';

// ---------------------------------------------------------------------------
// Private state
// ---------------------------------------------------------------------------

/** Active stratification overlays on the map, keyed by siteId. */
const _overlays = new Map();

/** Currently displayed cluster count per site. */
const _activeK = new Map();

// ---------------------------------------------------------------------------
// Private — form submission handler
// ---------------------------------------------------------------------------

/**
 * Handle the #add-site-form submit event.
 */
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

    const clustersRaw = form.clusters?.value;
    const clusters    = clustersRaw ? Number(clustersRaw) : null;

    const statusEl = document.getElementById('add-site-status');

    try {
        // ── Save locally ─────────────────────────────────────────────────
        if (statusEl) statusEl.textContent = 'Saving locally…';
        const siteRecord = await saveSite(name, file, clusters);
        showToast('Site saved locally.', 'success');
        closeModal('add-site-popup-form');
        form.reset();
        const kmlLabel = document.getElementById('kml-file-name');
        if (kmlLabel) kmlLabel.textContent = 'Choose KML file…';

        // ── Run stratification if clusters are specified ─────────────────
        if (clusters && clusters >= 2) {
            _runStratification(file, clusters, siteRecord?.id || name);
        }

        if (statusEl) statusEl.textContent = '';

    } catch (err) {
        console.error('[SiteManager] saveSite failed:', err);
        showToast(`Error saving site: ${err.message}`, 'failed');
        if (statusEl) statusEl.textContent = '';
    }
}

/**
 * Run stratification in background and show results on map.
 * Non-blocking — errors show toast, don't crash the form flow.
 */
async function _runStratification(kmlFile, maxClusters, siteId) {
    showToast('Running stratification analysis…', 'info');

    try {
        const results = await runStratification(kmlFile, maxClusters, 2024, (msg, pct) => {
            console.log(`[SiteManager] Stratification: ${msg} (${pct}%)`);
        });

        if (results.length === 0) {
            showToast('Stratification produced no results.', 'failed');
            return;
        }

        // Store results and show the max-cluster result by default
        _overlays.set(siteId, results);
        _showOverlay(siteId, maxClusters);

        showToast(`Stratification complete — ${results.length} cluster maps generated.`, 'success');

        // Show cluster selector UI on the map
        _showClusterSelector(siteId, results);

    } catch (err) {
        console.error('[SiteManager] Stratification failed:', err);
        showToast(`Stratification failed: ${err.message}`, 'failed');
    }
}

/**
 * Display a specific cluster overlay on the map.
 */
function _showOverlay(siteId, k) {
    const map     = getMap();
    const results = _overlays.get(siteId);
    if (!results) return;

    // Remove current overlay for this site
    const currentK = _activeK.get(siteId);
    if (currentK) {
        const current = results.find(r => r.k === currentK);
        if (current?._leafletOverlay) {
            map.removeLayer(current._leafletOverlay);
        }
    }

    // Add new overlay
    const result = results.find(r => r.k === k);
    if (!result) return;

    if (!result._leafletOverlay) {
        result._leafletOverlay = createOverlay(result);
    }
    result._leafletOverlay.addTo(map);
    _activeK.set(siteId, k);

    // Fit map to the overlay bounds
    map.fitBounds(result.bounds, { padding: [30, 30] });
}

/**
 * Show a small floating cluster selector control on the map.
 */
function _showClusterSelector(siteId, results) {
    // Remove any existing selector
    const existing = document.getElementById('cluster-selector');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'cluster-selector';
    container.style.cssText = `
        position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%);
        z-index: 1000; background: var(--bg-card, #fff); padding: 8px 16px;
        border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.15);
        display: flex; gap: 8px; align-items: center; font-size: 0.85rem;
    `;

    container.innerHTML = `<span style="font-weight:600; color:var(--text-dark);">Clusters:</span>`;

    for (const r of results) {
        const btn = document.createElement('button');
        btn.textContent = r.k;
        btn.dataset.k   = r.k;
        btn.style.cssText = `
            width: 32px; height: 32px; border-radius: 50%; border: 2px solid var(--border-color);
            background: var(--bg-surface); cursor: pointer; font-weight: 700;
            font-size: 0.85rem; color: var(--text-dark); transition: all 0.15s;
        `;
        btn.addEventListener('click', () => {
            _showOverlay(siteId, r.k);
            // Highlight active button
            container.querySelectorAll('button').forEach(b => {
                b.style.background = 'var(--bg-surface)';
                b.style.borderColor = 'var(--border-color)';
            });
            btn.style.background = 'var(--forest, #2e7d32)';
            btn.style.borderColor = 'var(--forest, #2e7d32)';
            btn.style.color = '#fff';
        });

        // Highlight the default (max clusters)
        if (r.k === results[results.length - 1].k) {
            btn.style.background = 'var(--forest, #2e7d32)';
            btn.style.borderColor = 'var(--forest, #2e7d32)';
            btn.style.color = '#fff';
        }

        container.appendChild(btn);
    }

    // Close button
    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'Hide overlay';
    close.style.cssText = `
        width: 28px; height: 28px; border-radius: 50%; border: none;
        background: var(--danger-red, #dc3545); color: #fff; cursor: pointer;
        font-size: 0.8rem; margin-left: 8px;
    `;
    close.addEventListener('click', () => {
        // Remove overlay from map
        const currentK = _activeK.get(siteId);
        if (currentK) {
            const current = results.find(r => r.k === currentK);
            if (current?._leafletOverlay) getMap().removeLayer(current._leafletOverlay);
        }
        _activeK.delete(siteId);
        container.remove();
    });
    container.appendChild(close);

    // Append to map container
    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.appendChild(container);
}

// ---------------------------------------------------------------------------
// Public — module initialisation
// ---------------------------------------------------------------------------

/**
 * Wire the Add Site form submit handler.
 */
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

    console.log('[SiteManager] Initialised.');
}
