/**
 * ProjectUI.js — Project management UI controller
 *
 * Extracted from the DOMContentLoaded block of ui.js.
 *
 * Responsibilities
 * ----------------
 *  - Project dropdown: render, on-change → ProjectManager.switchProject
 *  - New project / rename → native <dialog> input (replaces blocking prompt())
 *  - Conflict modal (pull / push / merge / cancel) → SyncService.resolveMasterConflict
 *  - Import-media form → Repository.saveExternalFile (all 3 args)
 *  - Re-render dropdown on EVENTS.PROJECT_CHANGED and EVENTS.STORAGE_READY
 *  - Open conflict modal on EVENTS.MASTER_SYNC_CONFLICT
 */

import EventBus, { EVENTS }         from '../core/EventBus.js';
import {
    createProject,
    switchProject,
    renameProject,
}                                    from '../data/ProjectManager.js';
import { resolveMasterConflict }     from '../services/SyncService.js';
import { getSpots, getLocalState }   from '../data/MasterData.js';
import { saveExternalFile, saveExternalFileByReference } from '../data/Repository.js';
import { showToast }                 from './Toast.js';
import { openModal, closeModal }     from './ModalManager.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function initProjectUI() {
    _initProjectDropdown();
    _initConflictModal();
    _initImportMediaForm();

    EventBus.on(EVENTS.STORAGE_READY,  _renderProjectList);
    EventBus.on(EVENTS.PROJECT_CHANGED, _renderProjectList);

    EventBus.on(EVENTS.MASTER_SYNC_CONFLICT, ({ data }) => {
        _openConflictModal(data.localCount, data.remoteCount);
    });
}

// ---------------------------------------------------------------------------
// Project name dialog (replaces blocking prompt())
// ---------------------------------------------------------------------------

/**
 * Open the project-name <dialog> and return a Promise that resolves with
 * the entered name, or null if the user cancelled.
 *
 * @param {string} title        Dialog heading text.
 * @param {string} defaultValue Pre-filled input value.
 * @returns {Promise<string|null>}
 */
function _askProjectName(title, defaultValue = '') {
    return new Promise(resolve => {
        const dialog = document.getElementById('project-name-dialog');
        const form   = document.getElementById('project-name-form');
        const input  = document.getElementById('project-name-input');
        const heading = document.getElementById('project-name-dialog-title');
        const cancelBtn = document.getElementById('cancel-project-name');

        if (!dialog || !form || !input) {
            // Fallback for missing dialog element
            resolve(null);
            return;
        }

        if (heading) heading.textContent = title;
        input.value = defaultValue;

        // Clean up listeners on close
        const cleanup = () => {
            form.removeEventListener('submit', onSubmit);
            cancelBtn?.removeEventListener('click', onCancel);
            dialog.removeEventListener('cancel', onCancel);
        };

        const onSubmit = (e) => {
            e.preventDefault();
            const val = input.value.trim();
            cleanup();
            closeModal('project-name-dialog');
            resolve(val || null);
        };

        const onCancel = () => {
            cleanup();
            closeModal('project-name-dialog');
            resolve(null);
        };

        form.addEventListener('submit', onSubmit);
        cancelBtn?.addEventListener('click', onCancel);
        dialog.addEventListener('cancel', onCancel); // ESC key

        openModal('project-name-dialog');
        input.focus();
        input.select();
    });
}

// ---------------------------------------------------------------------------
// Project dropdown
// ---------------------------------------------------------------------------

function _renderProjectList() {
    const projectSelect = document.getElementById('project-select');
    if (!projectSelect) return;

    const state = getLocalState();
    if (!state.projects) return;

    projectSelect.innerHTML = '';
    for (const p of state.projects) {
        const opt       = document.createElement('option');
        opt.value       = p.id;
        opt.textContent = p.name;
        if (p.id === state.currentProjectId) opt.selected = true;
        projectSelect.appendChild(opt);
    }
}

function _initProjectDropdown() {
    const projectSelect    = document.getElementById('project-select');
    const btnNewProject    = document.getElementById('btn-new-project');
    const btnRenameProject = document.getElementById('btn-rename-project');

    if (!projectSelect) return;

    projectSelect.addEventListener('change', async (e) => {
        try {
            await switchProject(e.target.value);
        } catch (err) {
            showToast(err.message, 'failed');
        }
    });

    btnNewProject?.addEventListener('click', async () => {
        const name = await _askProjectName('New Project', 'New Project');
        if (!name) return;
        try {
            await createProject(name);
            _renderProjectList();
        } catch (err) {
            showToast(err.message, 'failed');
        }
    });

    btnRenameProject?.addEventListener('click', async () => {
        const state       = getLocalState();
        const currentName = projectSelect.options[projectSelect.selectedIndex]?.text || '';
        const newName     = await _askProjectName('Rename Project', currentName);

        if (!newName || newName === currentName) return;

        try {
            await renameProject(state.currentProjectId, newName);
            _renderProjectList();
        } catch (err) {
            showToast(err.message, 'failed');
        }
    });
}

// ---------------------------------------------------------------------------
// Conflict modal
// ---------------------------------------------------------------------------

function _openConflictModal(localCount, remoteCount) {
    const conflictMsg = document.getElementById('conflict-msg');

    if (conflictMsg) {
        conflictMsg.innerHTML = `
            Master Data mismatch detected.<br>
            <strong>Local Spots:</strong> ${localCount}<br>
            <strong>Drive Spots:</strong> ${remoteCount}
        `;
    }

    openModal('conflict-modal');
}

function _initConflictModal() {
    const close = () => closeModal('conflict-modal');

    _wireConflictBtn('btn-conflict-pull',   async () => {
        await resolveMasterConflict('pull');
        close();
    });

    _wireConflictBtn('btn-conflict-push',   async () => {
        await resolveMasterConflict('push');
        close();
    });

    _wireConflictBtn('btn-conflict-merge',  async () => {
        await resolveMasterConflict('merge');
        close();
    });

    _wireConflictBtn('btn-conflict-cancel', close);
}

function _wireConflictBtn(id, handler) {
    document.getElementById(id)?.addEventListener('click', async () => {
        try {
            await handler();
        } catch (err) {
            showToast(`Conflict resolution failed: ${err.message}`, 'failed');
        }
    });
}

// ---------------------------------------------------------------------------
// Import-media form
// ---------------------------------------------------------------------------

function _initImportMediaForm() {
    const importBtn       = document.getElementById('import-media-btn');
    const spotContainer   = document.getElementById('spot-selection-container');
    const importForm      = document.getElementById('import-media-form');
    const cancelImportBtn = document.getElementById('cancel-import-btn');

    if (!importBtn) return;

    // Toggle base-directory input visibility when reference checkbox changes
    const refCheckbox    = document.getElementById('import-as-reference');
    const baseDirContainer = document.getElementById('reference-base-dir-container');
    if (refCheckbox && baseDirContainer) {
        refCheckbox.addEventListener('change', () => {
            baseDirContainer.style.display = refCheckbox.checked ? 'block' : 'none';
        });
    }

    importBtn.addEventListener('click', () => {
        const spots = getSpots();
        if (!spotContainer) return;

        spotContainer.innerHTML = '';
        if (!spots || spots.length === 0) {
            spotContainer.innerHTML = '<p>No spots found. Create a spot first.</p>';
        } else {
            for (const spot of spots) {
                const div     = document.createElement('div');
                const label   = document.createElement('label');
                const cb      = document.createElement('input');
                // Radio (not checkbox): imported media attaches to ONE spot only.
                cb.type       = 'radio';
                cb.name       = 'selected_spot';
                cb.value      = spot.spotId;
                label.append(cb, ` ${spot.name}`);
                div.append(label);
                spotContainer.appendChild(div);
            }
        }

        openModal('import-media-popup');
    });

    cancelImportBtn?.addEventListener('click', () => closeModal('import-media-popup'));

    importForm?.addEventListener('submit', async (e) => {
        e.preventDefault();

        const submitBtn    = importForm.querySelector('button[type="submit"]');
        const originalText = submitBtn?.textContent ?? '';
        if (submitBtn) {
            submitBtn.textContent = 'Importing...';
            submitBtn.disabled    = true;
        }

        try {
            const checkedBoxes    = spotContainer
                ? spotContainer.querySelectorAll('input[name="selected_spot"]:checked')
                : [];
            const selectedSpotIds = Array.from(checkedBoxes).map(cb => cb.value);

            const fileInput = document.getElementById('external-file-input');
            const files     = fileInput ? Array.from(fileInput.files) : [];
            const importAsRef = document.getElementById('import-as-reference')?.checked || false;

            if (selectedSpotIds.length === 0) throw new Error('Please select at least one spot.');
            if (files.length === 0)           throw new Error('Please select files.');

            let importDate       = new Date();
            const useCurrentCb   = document.getElementById('import-use-current-time');
            if (useCurrentCb && !useCurrentCb.checked) {
                const cDate = document.getElementById('import-custom-date')?.value;
                const cTime = document.getElementById('import-custom-time')?.value || '00:00:00';
                if (cDate) importDate = new Date(`${cDate}T${cTime}`);
            }

            // For reference imports, build full path from user-supplied base directory
            let baseDir = '';
            if (importAsRef) {
                baseDir = (document.getElementById('reference-base-dir')?.value || '').trim();
                if (!baseDir) throw new Error('Please enter the base directory path for reference imports.');
                // Normalise: strip trailing slashes/backslashes
                baseDir = baseDir.replace(/[\\/]+$/, '');
            }

            for (const file of files) {
                if (importAsRef) {
                    // Build full absolute path: baseDir + separator + filename
                    // Use webkitRelativePath (folder picker) if available, else just filename
                    const relPart  = file.webkitRelativePath || file.name;
                    const filePath = baseDir + '/' + relPart;
                    await saveExternalFileByReference(
                        file.name, filePath, file.type, selectedSpotIds, importDate
                    );
                } else {
                    await saveExternalFile(file, selectedSpotIds, importDate);
                }
            }

            showToast(`${importAsRef ? 'Referenced' : 'Imported'} ${files.length} file(s) successfully.`, 'success');
            closeModal('import-media-popup');
            importForm.reset();

            // Reset toggleable sections (form.reset() doesn't fire change events)
            const refBaseDirEl = document.getElementById('reference-base-dir-container');
            if (refBaseDirEl) refBaseDirEl.style.display = 'none';

            const importUseCurrentCb = document.getElementById('import-use-current-time');
            if (importUseCurrentCb) importUseCurrentCb.checked = true;
            const customTimeFields = document.getElementById('import-custom-time-fields');
            if (customTimeFields) customTimeFields.style.display = 'none';

        } catch (err) {
            console.error('[ProjectUI] Import failed:', err);
            showToast(`Import Failed: ${err.message}`, 'failed');
        } finally {
            if (submitBtn) {
                submitBtn.textContent = originalText;
                submitBtn.disabled    = false;
            }
        }
    });
}
