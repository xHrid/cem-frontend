/**
 * ModalManager.js — Centralised modal coordination using native <dialog>
 *
 * Uses the HTML5 <dialog> element's showModal() / close() API which provides:
 *   - Free focus trapping (Tab stays inside the dialog)
 *   - Native ::backdrop styling (no manual overlay div needed)
 *   - Built-in ESC key dismissal (cancel event)
 *   - Proper accessibility (role="dialog", aria-modal="true" automatic)
 *   - Top-layer stacking (no z-index wars)
 *
 * Backwards compat: if a modal ID resolves to a non-<dialog> element
 * (e.g. a legacy div), falls back to display flex/none toggling so
 * the SyncDashboard runtime-built modals continue to work.
 */

// ---------------------------------------------------------------------------
// Module-private registry
// ---------------------------------------------------------------------------

/**
 * Set of every modal element ID known to this module.
 * @type {Set<string>}
 */
const _knownModalIds = new Set([
    'popup-form',
    'add-site-popup-form',
    'save-route-dialog',
    'sync-modal',
    'import-media-popup',
    'conflict-modal',
    'analysis-popup',
    'jobs-popup',
    'external-data-viewer',
    'project-name-dialog',
]);

// ---------------------------------------------------------------------------
// Core primitives
// ---------------------------------------------------------------------------

/**
 * Show a modal by element ID.
 *
 * For <dialog> elements: uses showModal() for proper modal behaviour.
 * For other elements: falls back to display: 'flex' (legacy compat).
 *
 * @param {string} id  The `id` attribute of the modal element to show.
 */
export function openModal(id) {
    const el = document.getElementById(id);
    if (!el) {
        console.warn(`[ModalManager] openModal: element "${id}" not found.`);
        return;
    }
    _knownModalIds.add(id);

    if (el instanceof HTMLDialogElement) {
        if (!el.open) el.showModal();
    } else {
        // Legacy fallback for runtime-created div modals
        el.style.display = 'flex';
    }
}

/**
 * Hide a modal by element ID.
 *
 * @param {string} id  The `id` attribute of the modal element to hide.
 */
export function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;

    if (el instanceof HTMLDialogElement) {
        if (el.open) el.close();
    } else {
        el.style.display = 'none';
    }
}

/**
 * Close every modal that this mediator knows about.
 */
export function closeAllModals() {
    for (const id of _knownModalIds) {
        closeModal(id);
    }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Attach all popup open/close event handlers.
 * Must be called once after DOMContentLoaded.
 */
export function initModals() {
    // ── Spot / observation form ──────────────────────────────────────────
    _wire('open-form',  () => openModal('popup-form'));
    _wire('close-form', () => closeModal('popup-form'));

    // ── Add site form ───────────────────────────────────────────────────
    const addSiteBtn = document.querySelector('.add_site');
    addSiteBtn?.addEventListener('click', () => openModal('add-site-popup-form'));
    _wire('close-add-site-form', () => closeModal('add-site-popup-form'));

    // ── Hamburger menu toggle ───────────────────────────────────────────
    const menuToggle = document.getElementById('menu-toggle');
    const controls   = document.getElementById('controls');
    if (menuToggle && controls) {
        menuToggle.addEventListener('click', () => controls.classList.toggle('open'));
    }

    // ── Dialog backdrop click-to-close ──────────────────────────────────
    // Native <dialog> fires a 'click' on the dialog itself when the
    // backdrop is clicked. We close if the click target IS the dialog
    // (not a child element).
    for (const id of _knownModalIds) {
        const el = document.getElementById(id);
        if (el instanceof HTMLDialogElement) {
            el.addEventListener('click', (e) => {
                if (e.target === el) el.close();
            });
        }
    }

    // ── Copy watcher command button ─────────────────────────────────────
    _wire('copy-watcher-cmd', () => {
        navigator.clipboard.writeText('python watcher.py');
    });

    // ── Theme toggle ───────────────────────────────────────────────────
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        // Set initial icon based on current theme
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
        themeToggle.textContent = currentTheme === 'dark' ? '☀️' : '🌙';

        themeToggle.addEventListener('click', () => {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            const newTheme = isDark ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('cem-theme', newTheme);
            themeToggle.textContent = newTheme === 'dark' ? '☀️' : '🌙';
        });
    }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Find an element by ID and attach a click handler.
 * Silent no-op when the element does not exist.
 *
 * @param {string}   id       Target element ID.
 * @param {Function} handler  Click handler to attach.
 */
function _wire(id, handler) {
    document.getElementById(id)?.addEventListener('click', handler);
}
