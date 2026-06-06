/**
 * ProjectManager.js — Project CRUD
 *
 * Pattern : Module Pattern
 *           All project mutation logic lives here; the rest of the app goes
 *           through this module so there is exactly one place that writes to
 *           masterData.projects.
 *
 * Responsibilities
 * ----------------
 * - Derive the safe, stable filesystem folder name for a project.
 * - Create / switch / rename / delete projects.
 * - After every mutation: persist via MasterData, emit the relevant EventBus
 *   events, and fire-and-forget a Drive push.
 *
 * Folder-name stability guarantee
 * --------------------------------
 * getProjectFolderName() derives the folder name from the project's *id*
 * (specifically the first 6 characters), not its display name.  This means
 * renameProject() does NOT change the folder name, so all stored file paths
 * remain valid across renames.
 */

import EventBus, { EVENTS }       from '../core/EventBus.js';
import * as MasterData            from './MasterData.js';
import { getProjectFolderName }   from './projectUtils.js';
import { pushMasterToDrive }      from './Repository.js';

// Re-export so existing consumers that import from ProjectManager still work.
export { getProjectFolderName };

// ---------------------------------------------------------------------------
// Import guards
// ---------------------------------------------------------------------------

/**
 * Check if a project is an imported (read-only viewer) project.
 * Editor-imported projects allow mutations.
 *
 * @param {object} project
 * @returns {boolean} True if project is imported AND viewer-only.
 */
export function isReadOnlyImport(project) {
    return !!(project?.shared?.isImported && project.shared.permission !== 'writer');
}

/**
 * Guard that throws if the project is a read-only import.
 * @param {object} project
 */
function _guardReadOnly(project) {
    if (isReadOnlyImport(project)) {
        throw new Error('Cannot modify a read-only shared project. You have viewer access only.');
    }
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/**
 * Create a new project and make it the active project.
 *
 * @param {string} name  Display name for the new project.
 * @returns {Promise<object>}  The newly created project object.
 */
export async function createProject(name) {
    const state     = MasterData.getLocalState();
    const newId     = crypto.randomUUID();
    const newProject = {
        id             : newId,
        name           : (name || 'Untitled Project').trim(),
        spots          : [],
        routes         : [],
        sites          : [],
        external_files : [],
        created_at     : new Date().toISOString()
    };

    state.projects.push(newProject);
    state.currentProjectId = newId;

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.PROJECT_CHANGED);
    pushMasterToDrive(); // fire-and-forget

    return newProject;
}

/**
 * Switch the active project.
 *
 * @param {string} projectId  UUID of the project to activate.
 * @throws {Error} If projectId does not exist in masterData.projects.
 */
export async function switchProject(projectId) {
    const state = MasterData.getLocalState();

    if (!state.projects.find(p => p.id === projectId)) {
        throw new Error(`ProjectManager.switchProject: project "${projectId}" not found.`);
    }

    MasterData.setCurrentProjectId(projectId);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.PROJECT_CHANGED);
    EventBus.emit(EVENTS.DATA_UPDATED);
    // No Drive push on switch — data hasn't changed, only the view selection.
}

/**
 * Rename an existing project.
 *
 * IMPORTANT: this does NOT change the project's folder name on disk (see
 * getProjectFolderName above).  All existing file paths remain valid.
 *
 * @param {string} projectId  UUID of the project to rename.
 * @param {string} newName    Non-empty replacement display name.
 * @throws {Error} If projectId not found or newName is blank.
 */
export async function renameProject(projectId, newName) {
    const state   = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === projectId);

    if (!project) {
        throw new Error(`ProjectManager.renameProject: project "${projectId}" not found.`);
    }

    _guardReadOnly(project);

    const trimmed = (newName || '').trim();
    if (!trimmed) {
        throw new Error('ProjectManager.renameProject: name cannot be empty.');
    }

    project.name = trimmed;

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.PROJECT_CHANGED);
    pushMasterToDrive(); // fire-and-forget
}

/**
 * Delete a project.
 *
 * Guards against deleting the last remaining project.  If the deleted project
 * was the active one, falls back to the first project in the remaining list.
 *
 * Note: this removes the project entry from masterData but does NOT delete
 * the associated files from disk.  File clean-up (if desired) must be handled
 * separately by the caller.
 *
 * @param {string} projectId  UUID of the project to delete.
 * @throws {Error} If this is the only project.
 */
export async function deleteProject(projectId) {
    const state = MasterData.getLocalState();

    if (state.projects.length <= 1) {
        throw new Error('ProjectManager.deleteProject: cannot delete the last remaining project.');
    }

    state.projects = state.projects.filter(p => p.id !== projectId);

    // If we just removed the active project, pick a new one.
    if (state.currentProjectId === projectId) {
        state.currentProjectId = state.projects[0].id;
        MasterData.setCurrentProjectId(state.currentProjectId);
    }

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.PROJECT_CHANGED);
    EventBus.emit(EVENTS.DATA_UPDATED);
    pushMasterToDrive(); // fire-and-forget

    // Reclaim the deleted project's local files (media, jobs, etc.).
    try {
        const { gcAndRefresh } = await import('../services/StorageGC.js');
        await gcAndRefresh();
    } catch (e) { console.warn('[ProjectManager] post-delete GC failed:', e.message); }
}
