import EventBus, { EVENTS }       from '../core/EventBus.js';
import * as MasterData            from './MasterData.js';
import { getProjectFolderName }   from './projectUtils.js';
import { pushMasterToDrive }      from './Repository.js';

export { getProjectFolderName };

export function isReadOnlyImport(project) {
    return !!(project?.shared?.isImported && project.shared.permission !== 'writer');
}

function _guardReadOnly(project) {
    if (isReadOnlyImport(project)) {
        throw new Error('Cannot modify a read-only shared project. You have viewer access only.');
    }
}

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
    pushMasterToDrive();

    return newProject;
}

export async function switchProject(projectId) {
    const state = MasterData.getLocalState();

    if (!state.projects.find(p => p.id === projectId)) {
        throw new Error(`ProjectManager.switchProject: project "${projectId}" not found.`);
    }

    MasterData.setCurrentProjectId(projectId);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.PROJECT_CHANGED);
    EventBus.emit(EVENTS.DATA_UPDATED);
}

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
    pushMasterToDrive();
}

export async function deleteProject(projectId) {
    const state = MasterData.getLocalState();

    if (state.projects.length <= 1) {
        throw new Error('ProjectManager.deleteProject: cannot delete the last remaining project.');
    }

    state.projects = state.projects.filter(p => p.id !== projectId);

    if (state.currentProjectId === projectId) {
        state.currentProjectId = state.projects[0].id;
        MasterData.setCurrentProjectId(state.currentProjectId);
    }

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.PROJECT_CHANGED);
    EventBus.emit(EVENTS.DATA_UPDATED);
    pushMasterToDrive();

    try {
        const { gcAndRefresh } = await import('../services/StorageGC.js');
        await gcAndRefresh();
    } catch (e) { console.warn('[ProjectManager] post-delete GC failed:', e.message); }
}
