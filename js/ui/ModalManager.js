const _knownModalIds = new Set([
    'popup-form',
    'add-site-popup-form',
    'save-route-dialog',
    'sync-modal',
    'import-media-popup',
    'analysis-popup',
    'jobs-popup',
    'external-data-viewer',
    'project-name-dialog',
]);

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
        el.style.display = 'flex';
    }
}

export function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;

    if (el instanceof HTMLDialogElement) {
        if (el.open) el.close();
    } else {
        el.style.display = 'none';
    }
}

export function closeAllModals() {
    for (const id of _knownModalIds) {
        closeModal(id);
    }
}

export function initModals() {
    _wire('open-form',  () => openModal('popup-form'));
    _wire('close-form', () => closeModal('popup-form'));

    const addSiteBtn = document.querySelector('.add_site');
    addSiteBtn?.addEventListener('click', () => openModal('add-site-popup-form'));
    _wire('close-add-site-form', () => closeModal('add-site-popup-form'));

    const menuToggle = document.getElementById('menu-toggle');
    const controls   = document.getElementById('controls');
    if (menuToggle && controls) {
        menuToggle.addEventListener('click', () => controls.classList.toggle('open'));
    }

    for (const id of _knownModalIds) {
        const el = document.getElementById(id);
        if (el instanceof HTMLDialogElement) {
            el.addEventListener('click', (e) => {
                if (e.target === el) el.close();
            });
        }
    }

    _wire('copy-watcher-cmd', () => {
        navigator.clipboard.writeText('python watcher.py');
    });

    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
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

function _wire(id, handler) {
    document.getElementById(id)?.addEventListener('click', handler);
}
