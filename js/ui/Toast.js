/**
 * Toast.js — Transient notification system
 *
 * Pattern : Observer / Publish-Subscribe
 *           This module is a pure subscriber: it listens for EVENTS.TOAST_SHOW on
 *           EventBus and renders the notification.  No other module needs a direct
 *           reference to Toast — they simply emit the event.
 *
 * Replaces every `alert()` call in the legacy codebase.
 *
 * CSS contract
 * ------------
 * The stylesheet defines the following classes on #toast-notification:
 *   (base)   — fixed position, off-screen right (-350px), 300 px wide
 *   .show    — slides to right: 20px (CSS transition: right 0.4s)
 *   .success — green left border
 *   .failed  — red   left border
 * The `info` type receives no extra class (dark background only).
 *
 * Usage
 * -----
 *   // In app entry point (App.js / index module):
 *   import { initToast } from './ui/Toast.js';
 *   initToast();
 *
 *   // Anywhere in the app — no Toast import needed:
 *   import EventBus, { EVENTS } from './core/EventBus.js';
 *   EventBus.emit(EVENTS.TOAST_SHOW, { message: 'Saved!', type: 'success' });
 *
 *   // Or when you have a direct reference (e.g. inside other UI modules):
 *   import { showToast } from './ui/Toast.js';
 *   showToast('Import failed.', 'failed');
 */

import EventBus, { EVENTS } from '../core/EventBus.js';
import Config                from '../core/Config.js';

// ---------------------------------------------------------------------------
// Module-private state
// ---------------------------------------------------------------------------

/** Timer handle so a new toast can clear the previous auto-hide schedule. */
let _hideTimer = null;

/** Cached DOM reference — resolved lazily on first call to showToast(). */
let _el = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve (and cache) the #toast-notification element.
 * Lazy so the module can be imported before DOMContentLoaded fires.
 *
 * @returns {HTMLElement|null}
 */
function _getElement() {
    if (!_el) _el = document.getElementById('toast-notification');
    return _el;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Display a toast notification.
 *
 * Any currently visible toast is immediately replaced by the new one and the
 * auto-hide timer is reset.
 *
 * @param {string} message  Text to display inside the toast.
 * @param {'success'|'failed'|'info'} [type='info']  Visual style variant.
 */
export function showToast(message, type = 'info') {
    const el = _getElement();
    if (!el) {
        // DOM not ready or element missing — fall back to console so we never
        // silently swallow an important message.
        console.warn(`[Toast] Element not found. Message: "${message}" (${type})`);
        return;
    }

    // Clear any pending hide timer so the previous toast doesn't cut this one short.
    if (_hideTimer) {
        clearTimeout(_hideTimer);
        _hideTimer = null;
    }

    // Reset class list to base state before applying the new type.
    el.className = '';
    if (type === 'success' || type === 'failed') {
        el.classList.add(type);
    }
    // 'info' intentionally receives no extra class — the stylesheet handles it.

    el.textContent = message;

    // Trigger slide-in on the next animation frame so CSS transition fires even
    // when toggling from a previously .show state.
    requestAnimationFrame(() => {
        el.classList.add('show');
    });

    // Auto-hide after the configured duration.
    const duration = Config.ui.toastDuration;
    _hideTimer = setTimeout(() => {
        el.classList.remove('show');
        _hideTimer = null;
    }, duration);
}

/**
 * Wire up the EventBus listener.
 *
 * Must be called once (typically from App.js) after the DOM is ready.
 * Calling it more than once is safe — EventBus deduplicates identical
 * callback references.
 *
 * @returns {Function}  Unsubscribe handle (call to remove the listener).
 */
export function initToast() {
    /**
     * EventBus envelope shape: { type, data: { message, type }, timestamp }
     * @param {{ data: { message: string, type?: string } }} envelope
     */
    const handler = ({ data }) => {
        showToast(data.message, data.type || 'info');
    };

    return EventBus.on(EVENTS.TOAST_SHOW, handler);
}
