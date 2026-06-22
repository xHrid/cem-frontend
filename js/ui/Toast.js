import EventBus, { EVENTS } from '../core/EventBus.js';
import Config                from '../core/Config.js';

let _hideTimer = null;

let _el = null;

function _getElement() {
    if (!_el) _el = document.getElementById('toast-notification');
    return _el;
}

export function showToast(message, type = 'info') {
    const el = _getElement();
    if (!el) {
        console.warn(`[Toast] Element not found. Message: "${message}" (${type})`);
        return;
    }

    if (_hideTimer) {
        clearTimeout(_hideTimer);
        _hideTimer = null;
    }

    el.className = '';
    if (type === 'success' || type === 'failed') {
        el.classList.add(type);
    }

    el.textContent = message;

    _attachKeepAlive(el);

    requestAnimationFrame(() => {
        el.classList.add('show');
    });

    _scheduleHide(el);
}

function _scheduleHide(el) {
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    _hideTimer = setTimeout(() => {
        el.classList.remove('show');
        _hideTimer = null;
    }, Config.ui.toastDuration);
}

function _pauseHide() {
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
}

function _attachKeepAlive(el) {
    if (el.dataset.keepAlive === '1') return;
    el.dataset.keepAlive = '1';

    const hold   = () => _pauseHide();
    const resume = () => { if (el.classList.contains('show')) _scheduleHide(el); };

    el.addEventListener('mouseenter', hold);
    el.addEventListener('mouseleave', resume);
    el.addEventListener('touchstart', hold,   { passive: true });
    el.addEventListener('touchend',   resume);
    el.addEventListener('touchcancel', resume);
}

export function initToast() {
    const handler = ({ data }) => {
        showToast(data.message, data.type || 'info');
    };

    return EventBus.on(EVENTS.TOAST_SHOW, handler);
}
