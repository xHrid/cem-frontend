/**
 * SharingUI.js — Share & Import project UI controller
 *
 * Responsibilities:
 *  - Share modal: select projects, enter emails, pick role, share
 *  - Import modal: paste link/folder ID, import
 *  - Shared project indicators in the project dropdown
 *  - Sync button for imported projects
 */

import EventBus, { EVENTS } from '../core/EventBus.js';
import { getLocalState } from '../data/MasterData.js';
import { isReadOnlyImport } from '../data/ProjectManager.js';
import {
    shareProject,
    importSharedProject,
    parseFolderIdFromInput,
    getSharingInfo,
} from '../services/SharingService.js';
import { pickSharedProjectFile } from '../services/PickerService.js';
import { showToast } from './Toast.js';
import { openModal, closeModal } from './ModalManager.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function initSharingUI() {
    _initShareButton();
    _initImportButton();
    _initShareModal();
    _initImportModal();
    // Per-project sync is now automatic (SyncEngine on project switch + edits).

    // Update project dropdown with sharing indicators
    EventBus.on(EVENTS.PROJECT_CHANGED, _decorateProjectDropdown);
    EventBus.on(EVENTS.PROJECT_SHARED, _decorateProjectDropdown);
    EventBus.on(EVENTS.PROJECT_IMPORTED, _decorateProjectDropdown);

    // Check URL for ?import= param on load
    _checkUrlForImport();
}

// ---------------------------------------------------------------------------
// Share button & modal
// ---------------------------------------------------------------------------

function _initShareButton() {
    const btn = document.getElementById('btn-share-project');
    if (!btn) return;

    btn.addEventListener('click', () => {
        _populateShareModal();
        openModal('share-project-dialog');
    });
}

function _populateShareModal() {
    const projectList = document.getElementById('share-project-list');
    if (!projectList) return;

    const state = getLocalState();
    projectList.innerHTML = '';

    for (const p of state.projects) {
        // Skip imported projects — can't reshare someone else's project
        if (p.shared?.isImported) continue;

        const div   = document.createElement('div');
        const label = document.createElement('label');
        label.className = 'share-project-item';

        const cb    = document.createElement('input');
        cb.type     = 'checkbox';
        cb.name     = 'share_project';
        cb.value    = p.id;

        // Pre-select current project
        if (p.id === state.currentProjectId) cb.checked = true;

        const info = getSharingInfo(p);
        let nameText = ` ${p.name}`;
        if (info.isShared) {
            nameText += ` (shared with ${info.collaboratorCount})`;
        }

        label.append(cb, nameText);
        div.append(label);
        projectList.appendChild(div);
    }
}

function _initShareModal() {
    const form      = document.getElementById('share-project-form');
    const cancelBtn = document.getElementById('cancel-share-btn');

    cancelBtn?.addEventListener('click', () => closeModal('share-project-dialog'));

    form?.addEventListener('submit', async (e) => {
        e.preventDefault();

        const submitBtn    = form.querySelector('button[type="submit"]');
        const originalText = submitBtn?.textContent ?? '';
        if (submitBtn) { submitBtn.textContent = 'Sharing...'; submitBtn.disabled = true; }

        try {
            // Gather selected projects
            const checkedBoxes = document.querySelectorAll(
                '#share-project-list input[name="share_project"]:checked'
            );
            const projectIds = Array.from(checkedBoxes).map(cb => cb.value);

            if (projectIds.length === 0) throw new Error('Select at least one project.');

            // Gather emails
            const emailInput = document.getElementById('share-emails-input');
            const rawEmails  = (emailInput?.value || '').split(/[,;\s]+/).filter(Boolean);
            if (rawEmails.length === 0) throw new Error('Enter at least one email address.');

            // Validate email format
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            for (const email of rawEmails) {
                if (!emailRegex.test(email)) {
                    throw new Error(`Invalid email: ${email}`);
                }
            }

            // Get role
            const roleSelect = document.getElementById('share-role-select');
            const role = roleSelect?.value || 'reader';

            // Share each project
            let totalShared = 0;
            let lastShareLink = '';

            for (const pid of projectIds) {
                const result = await shareProject(pid, rawEmails, role);
                const successes = result.results.filter(r => r.success).length;
                totalShared += successes;
                lastShareLink = result.shareLink;
            }

            // Show share link
            const linkDisplay = document.getElementById('share-link-display');
            if (linkDisplay && lastShareLink) {
                linkDisplay.textContent = lastShareLink;
                linkDisplay.parentElement.style.display = 'block';
            }

            showToast(
                `Shared ${projectIds.length} project(s) with ${totalShared} user(s).`,
                'success'
            );

            // Don't close modal — let user see/copy the link
            if (emailInput) emailInput.value = '';

        } catch (err) {
            console.error('[SharingUI] Share failed:', err);
            showToast(`Share failed: ${err.message}`, 'failed');
        } finally {
            if (submitBtn) { submitBtn.textContent = originalText; submitBtn.disabled = false; }
        }
    });

    // Copy link button
    const copyLinkBtn = document.getElementById('copy-share-link-btn');
    copyLinkBtn?.addEventListener('click', () => {
        const linkText = document.getElementById('share-link-display')?.textContent;
        if (linkText) {
            navigator.clipboard.writeText(linkText).then(
                () => showToast('Link copied!', 'success'),
                () => showToast('Failed to copy link.', 'failed')
            );
        }
    });
}

// ---------------------------------------------------------------------------
// Import button & modal
// ---------------------------------------------------------------------------

function _initImportButton() {
    const btn = document.getElementById('btn-import-project');
    if (!btn) return;

    btn.addEventListener('click', () => {
        openModal('import-project-dialog');
    });
}

function _initImportModal() {
    const form      = document.getElementById('import-project-form');
    const cancelBtn = document.getElementById('cancel-import-project-btn');
    const pickBtn   = document.getElementById('btn-pick-drive-folder');

    cancelBtn?.addEventListener('click', () => closeModal('import-project-dialog'));

    // --- Primary path: pick the shared folder via Google Picker -----------
    // With the drive.file scope, selecting the folder here is what grants the
    // app access to it. This is the "popup asking to work in the shared
    // folder" flow.
    pickBtn?.addEventListener('click', async () => {
        const originalText = pickBtn.textContent;
        pickBtn.textContent = 'Opening Drive...';
        pickBtn.disabled = true;

        // CRITICAL: the import dialog is a native <dialog> shown with
        // showModal(), which lives in the browser top-layer. The Google Picker
        // is a normal DOM overlay and would render BEHIND it. Close the dialog
        // first so the Picker is visible and clickable.
        closeModal('import-project-dialog');

        try {
            const file = await pickSharedProjectFile();
            if (!file) return; // user cancelled the picker

            const project = await importSharedProject(file.id);
            showToast(`Imported "${project.name}" successfully!`, 'success');
        } catch (err) {
            console.error('[SharingUI] Picker import failed:', err);
            showToast(`Import failed: ${err.message}`, 'failed');
        } finally {
            pickBtn.textContent = originalText;
            pickBtn.disabled = false;
        }
    });

    // --- Secondary path: paste a link / folder ID -------------------------
    // Only succeeds if the folder was already opened via the picker (drive.file
    // limitation). On an access error we point the user back to the picker.
    form?.addEventListener('submit', async (e) => {
        e.preventDefault();

        const submitBtn    = form.querySelector('button[type="submit"]');
        const originalText = submitBtn?.textContent ?? '';
        if (submitBtn) { submitBtn.textContent = 'Importing...'; submitBtn.disabled = true; }

        try {
            const linkInput = document.getElementById('import-link-input');
            const rawInput  = linkInput?.value || '';

            const folderId = parseFolderIdFromInput(rawInput);
            if (!folderId) {
                throw new Error('Invalid link or folder ID. Paste the share link or Drive folder ID.');
            }

            const project = await importSharedProject(folderId);

            showToast(`Imported "${project.name}" successfully!`, 'success');
            closeModal('import-project-dialog');
            if (linkInput) linkInput.value = '';

        } catch (err) {
            console.error('[SharingUI] Import failed:', err);
            // drive.file can't read a folder the user hasn't picked — hint them.
            const accessIssue = /40[34]|access|permission|not.*found/i.test(err.message);
            const hint = accessIssue
                ? ' Use "Select Shared Folder from Drive" above to grant access first.'
                : '';
            showToast(`Import failed: ${err.message}${hint}`, 'failed');
        } finally {
            if (submitBtn) { submitBtn.textContent = originalText; submitBtn.disabled = false; }
        }
    });
}

// ---------------------------------------------------------------------------
// Project dropdown decoration
// ---------------------------------------------------------------------------

function _decorateProjectDropdown() {
    const select = document.getElementById('project-select');
    if (!select) return;

    const state = getLocalState();

    for (const opt of select.options) {
        const project = state.projects.find(p => p.id === opt.value);
        if (!project) continue;

        let suffix = '';
        if (project.shared?.isImported) {
            const role = project.shared.permission === 'writer' ? 'editor' : 'viewer';
            suffix = ` [${role}]`;
        } else if (project.sharing?.isShared) {
            suffix = ` [shared]`;
        }

        // Strip old suffixes and re-add
        const baseName = project.name;
        opt.textContent = baseName + suffix;
    }

    // Also toggle read-only UI hints
    _updateReadOnlyHints();
}

function _updateReadOnlyHints() {
    const state   = getLocalState();
    const project = state.projects.find(p => p.id === state.currentProjectId);
    const isRO    = isReadOnlyImport(project);

    // Disable mutation buttons for read-only imports
    const mutationButtons = [
        'btn-rename-project',
        'open-form',          // Add spot
        'toggle-tracking',    // Record route
        'import-media-btn',   // Import media
    ];

    for (const id of mutationButtons) {
        const el = document.getElementById(id);
        if (el) {
            el.disabled = isRO;
            el.title = isRO ? 'Read-only shared project' : '';
        }
    }

    // Show read-only banner
    let banner = document.getElementById('readonly-banner');
    if (isRO && !banner) {
        banner = document.createElement('div');
        banner.id = 'readonly-banner';
        banner.className = 'readonly-banner';
        banner.textContent = `👁 Viewing shared project from ${project.shared.ownerEmail}`;
        const controls = document.getElementById('controls');
        const projectSection = controls?.querySelector('.control-section');
        if (projectSection) {
            projectSection.after(banner);
        }
    } else if (!isRO && banner) {
        banner.remove();
    }
}

// ---------------------------------------------------------------------------
// Auto-import from URL
// ---------------------------------------------------------------------------

function _checkUrlForImport() {
    const params = new URLSearchParams(globalThis.location?.search || '');
    const importId = params.get('import');

    if (importId) {
        // Delay slightly to let app finish initializing
        setTimeout(async () => {
            try {
                const project = await importSharedProject(importId);
                showToast(`Imported "${project.name}" from share link!`, 'success');

                // Clean the URL
                const url = new URL(globalThis.location.href);
                url.searchParams.delete('import');
                globalThis.history.replaceState({}, '', url.toString());
            } catch (err) {
                if (err.message.includes('already imported')) {
                    showToast(err.message, 'info');
                } else {
                    showToast(`Auto-import failed: ${err.message}`, 'failed');
                }
            }
        }, 2000);
    }
}
