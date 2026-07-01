function _overlay() {
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:10000;';
    return o;
}

function _box() {
    const b = document.createElement('div');
    b.style.cssText = 'background:var(--bg-surface,#fff); color:var(--text-dark,#222); max-width:420px; width:90%; padding:20px; border-radius:10px; box-shadow:0 8px 30px rgba(0,0,0,0.3); font-size:0.92rem;';
    return b;
}

// Info dialog with an OK button. If storageKey is given, adds a "Don't show
// again" checkbox and skips the dialog once dismissed with it ticked.
export function showAckDialog({ title, message, storageKey }) {
    return new Promise((resolve) => {
        if (storageKey && localStorage.getItem(storageKey) === '1') { resolve(); return; }

        const overlay = _overlay();
        const box = _box();
        box.innerHTML = `
            <div style="font-weight:700; margin-bottom:10px;">${title}</div>
            <div style="margin-bottom:16px; line-height:1.45;">${message}</div>
            ${storageKey ? `<label style="display:flex; align-items:center; gap:8px; margin-bottom:14px; color:var(--text-muted,#666);"><input type="checkbox" id="_ack-dsa"> Don't show again</label>` : ''}
            <div style="text-align:right;"><button id="_ack-ok" style="padding:8px 18px; background:var(--accent-blue,#2196F3); color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:600;">OK</button></div>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const close = () => {
            if (storageKey && box.querySelector('#_ack-dsa')?.checked) {
                localStorage.setItem(storageKey, '1');
            }
            overlay.remove();
            resolve();
        };
        box.querySelector('#_ack-ok').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    });
}

// Confirm dialog. Resolves true on confirm, false on cancel or backdrop click.
export function showConfirmDialog({ title, message, confirmText = 'Continue', cancelText = 'Cancel' }) {
    return new Promise((resolve) => {
        const overlay = _overlay();
        const box = _box();
        box.innerHTML = `
            <div style="font-weight:700; margin-bottom:10px;">${title}</div>
            <div style="margin-bottom:16px; line-height:1.45;">${message}</div>
            <div style="display:flex; gap:10px; justify-content:flex-end;">
                <button id="_cf-cancel" style="padding:8px 16px; background:var(--bg-surface-alt,#eee); color:var(--text-dark,#222); border:1px solid var(--border-color,#ccc); border-radius:6px; cursor:pointer;">${cancelText}</button>
                <button id="_cf-ok" style="padding:8px 16px; background:var(--accent-blue,#2196F3); color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:600;">${confirmText}</button>
            </div>
        `;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const done = (val) => { overlay.remove(); resolve(val); };
        box.querySelector('#_cf-ok').addEventListener('click', () => done(true));
        box.querySelector('#_cf-cancel').addEventListener('click', () => done(false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    });
}
