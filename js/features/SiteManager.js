/**
 * SiteManager.js — KML site boundary upload and persistence
 *
 * Pattern : Module Pattern (private state + narrow exported API)
 *
 * Replaces the legacy js/sites.js. Bugs fixed:
 *
 *  Bug 1 — alert("Site KML Saved to Drive!") was factually wrong. The site is
 *           saved locally via Repository.saveSite(); a Drive push is
 *           fire-and-forget. Fixed: showToast("Site saved locally", "success").
 *
 *  Bug 2 — The <select name="clusters"> value was never read. saveSite() was
 *           called with only 2 arguments, silently discarding the cluster
 *           selection. Fixed: the clusters value is read and passed as the 3rd
 *           argument, which Repository.saveSite() now accepts (also fixed
 *           there per the refactor spec).
 *
 *  Bug 3 — No input validation. The form could be submitted with an empty site
 *           name or no file chosen, producing a corrupt record in master_data.
 *           Fixed: validate both fields before calling saveSite(), show a toast
 *           describing which field is missing.
 *
 * Import graph
 * ------------
 *   saveSite  → ../data/Repository.js
 *   showToast → ../ui/Toast.js
 */

import { saveSite } from '../data/Repository.js';
import { showToast } from '../ui/Toast.js';
import { closeModal } from '../ui/ModalManager.js';

// ---------------------------------------------------------------------------
// Private — form submission handler
// ---------------------------------------------------------------------------

/**
 * Handle the #add-site-form submit event.
 *
 * Validates name and KML file presence (Bug 3 fix), reads the clusters
 * dropdown value (Bug 2 fix), delegates persistence to Repository.saveSite(),
 * and shows a toast on success or failure (Bug 1 fix).
 *
 * @param {SubmitEvent} e
 */
async function _handleSiteFormSubmit(e) {
    e.preventDefault();
    const form = e.target;

    const name = (form.siteName?.value || '').trim();

    // Bug 3 fix: require a site name
    if (!name) {
        showToast('Please enter a site name.', 'failed');
        return;
    }

    const fileInput = document.getElementById('kml-upload');
    const file      = fileInput?.files?.[0] || null;

    // Bug 3 fix: require a KML file
    if (!file) {
        showToast('Please select a KML file before submitting.', 'failed');
        return;
    }

    // Bug 2 fix: read the clusters select value (was silently ignored before)
    // The <select name="clusters"> lives inside the same form element.
    const clustersRaw = form.clusters?.value;
    // Convert to a number when present; keep null when the placeholder is selected.
    const clusters = clustersRaw ? Number(clustersRaw) : null;

    const statusEl = document.getElementById('add-site-status');
    if (statusEl) statusEl.textContent = 'Saving locally…';

    try {
        // Bug 2 fix: pass clusters as 3rd arg — Repository.saveSite() now accepts it
        await saveSite(name, file, clusters);

        // Bug 1 fix: accurate, local-save confirmation instead of "Saved to Drive!"
        showToast('Site saved locally.', 'success');

        // Close the popup and reset the form
        closeModal('add-site-popup-form');
        form.reset();

        // Reset the KML filename display label if present
        const kmlLabel = document.getElementById('kml-file-name');
        if (kmlLabel) kmlLabel.textContent = 'Choose KML file…';

        if (statusEl) statusEl.textContent = '';

    } catch (err) {
        console.error('[SiteManager] saveSite failed:', err);
        showToast(`Error saving site: ${err.message}`, 'failed');
        if (statusEl) statusEl.textContent = '';
    }
}

// ---------------------------------------------------------------------------
// Public — module initialisation
// ---------------------------------------------------------------------------

/**
 * Wire the Add Site form submit handler.
 *
 * Must be called exactly once from App.js after DOMContentLoaded fires so that
 * document.getElementById() reliably finds the form element.
 *
 * All DOM queries are deferred to this call (no top-level queries at import
 * time), consistent with the pattern used by SpotManager and RouteManager.
 */
export function initSites() {
    const form = document.getElementById('add-site-form');
    if (!form) {
        console.warn('[SiteManager] #add-site-form not found in DOM — initSites() aborted.');
        return;
    }

    form.addEventListener('submit', _handleSiteFormSubmit);

    // Optional: update the KML filename label when a file is chosen, providing
    // visual feedback since the native file input is hidden in favour of the
    // styled <label class="kml-upload-area">.
    const kmlInput = document.getElementById('kml-upload');
    const kmlLabel = document.getElementById('kml-file-name');
    if (kmlInput && kmlLabel) {
        kmlInput.addEventListener('change', () => {
            kmlLabel.textContent = kmlInput.files[0]?.name || 'Choose KML file…';
        });
    }

    console.log('[SiteManager] Initialised.');
}
