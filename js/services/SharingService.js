import EventBus, { EVENTS } from '../core/EventBus.js';
import * as DriveService from './DriveService.js';
import * as MasterData from '../data/MasterData.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import { getProjectFolderName } from '../data/projectUtils.js';
import { pushProjectDataToDrive } from '../data/Repository.js';
import { getAccessToken } from './AuthService.js';
import { enumerateFileRefs } from './ProjectFilesSync.js';
import { mergeById } from '../data/mergeUtils.js';

function _remapMediaPaths(project, ownerFolderName, localFolderName) {
    if (ownerFolderName === localFolderName) return;

    const remap = (path) => {
        if (!path) return path;
        if (path.startsWith(ownerFolderName + '/')) {
            return localFolderName + path.substring(ownerFolderName.length);
        }
        return path;
    };

    for (const spot of (project.spots || [])) {
        spot.image_local_filename = remap(spot.image_local_filename);
        if (spot.images && spot.images.length > 0) {
            spot.images = spot.images.map(remap);
        }
        spot.audio_local_filename = remap(spot.audio_local_filename);
    }
    for (const site of (project.sites || [])) {
        site.kml_filename = remap(site.kml_filename);
    }
    for (const route of (project.routes || [])) {
        for (const a of (route.annotations || [])) {
            a.image_local_filename = remap(a.image_local_filename);
            a.audio_local_filename = remap(a.audio_local_filename);
        }
    }
    for (const file of (project.external_files || [])) {
        file.local_path = remap(file.local_path);
    }
    for (const job of (project.jobs || [])) {
        job.job_file = remap(job.job_file);
        for (const rf of (job.result_files || [])) {
            rf.rel_path = remap(rf.rel_path);
        }
    }
}

async function _pushAllProjectMedia(project, rootFolderId) {
    // Every locally-referenced file (spots, sites, overlays, routes AND job
    // result files) must be uploaded + made public, or an importer with only
    // drive.file scope cannot fetch it. Reuse the canonical enumeration instead
    // of a partial hand-rolled list that silently dropped analysis outputs.
    const mediaPaths = [...new Set(
        enumerateFileRefs(project).map(ref => ref.relPath).filter(Boolean)
    )];

    if (mediaPaths.length === 0) return;

    let pushed = 0;
    for (const relPath of mediaPaths) {
        try {
            const fileBlob = await StorageAdapter.getFileBlob(relPath);
            if (!fileBlob) continue;

            const parts = relPath.split('/');
            const filename = parts.pop();
            if (!filename) continue;

            let parentId = rootFolderId;
            if (parts.length > 0) {
                parentId = await DriveService.ensureDrivePath(parts, rootFolderId);
            }

            const existing = await DriveService.findFileByName(filename, parentId);
            let fileId;
            if (existing) {
                await DriveService.updateDriveFile(existing.id, fileBlob);
                fileId = existing.id;
            } else {
                const created = await DriveService.uploadFile(
                    fileBlob,
                    filename,
                    fileBlob.type || 'application/octet-stream',
                    parentId,
                    relPath
                );
                fileId = created.id;
            }

            if (fileId) {
                await DriveService.makeFilePublic(fileId);
                _setMediaDriveId(project, relPath, fileId);
            }
            pushed++;
        } catch (err) {
            console.warn(`[SharingService] Could not push media "${relPath}":`, err.message);
        }
    }

    if (pushed > 0) {
    }
}

function _setMediaDriveId(project, relPath, fileId) {
    const now = new Date().toISOString();
    for (const spot of (project.spots || [])) {
        const imgPaths = spot.images && spot.images.length > 0
            ? spot.images
            : (spot.image_local_filename ? [spot.image_local_filename] : []);
        const imgIdx = imgPaths.indexOf(relPath);
        if (imgIdx >= 0) {
            if (!spot.image_drive_ids) spot.image_drive_ids = [];
            while (spot.image_drive_ids.length < imgPaths.length) spot.image_drive_ids.push(null);
            spot.image_drive_ids[imgIdx] = fileId;
            if (imgIdx === 0) spot.image_drive_id = fileId;
            spot.updated_at = now;
        }
        if (spot.audio_local_filename === relPath) { spot.audio_drive_id = fileId; spot.updated_at = now; }
    }
    for (const site of (project.sites || [])) {
        if (site.kml_filename === relPath) { site.kml_drive_id = fileId; site.updated_at = now; }
        for (const ov of (site.strat_overlays || [])) {
            if (ov.rel_path === relPath) { ov.drive_id = fileId; site.updated_at = now; }
        }
    }
    for (const route of (project.routes || [])) {
        for (const a of (route.annotations || [])) {
            if (a.image_local_filename === relPath) { a.image_drive_id = fileId; route.updated_at = now; }
            if (a.audio_local_filename === relPath) { a.audio_drive_id = fileId; route.updated_at = now; }
        }
    }
    for (const job of (project.jobs || [])) {
        if (job.job_file === relPath) { job.job_file_drive_id = fileId; job.updated_at = now; }
        for (const rf of (job.result_files || [])) {
            if (rf.rel_path === relPath) { rf.drive_id = fileId; job.updated_at = now; }
        }
    }
}

// The owner's project_data.json is the sole authority for media that lives in
// the owner's folder. A collaborator can read project_data.json by its picked
// file id but cannot enumerate the folder under the drive.file scope, so we
// never scan the directory: we adopt the drive_ids the remote already carries.
// Gap-fill only - never overwrite a present local id or drop a local-only path,
// so an editor's own not-yet-pushed media is preserved.
function _adoptRemoteMediaIds(project, remote) {
    if (!remote) return;

    const remoteSpots = new Map(
        (remote.spots || []).map(s => [s.spotId || s.id, s])
    );
    for (const spot of (project.spots || [])) {
        const r = remoteSpots.get(spot.spotId || spot.id);
        if (!r) continue;

        const paths = spot.images && spot.images.length > 0
            ? spot.images
            : (spot.image_local_filename ? [spot.image_local_filename] : []);
        if (paths.length > 0) {
            const rPaths = r.images && r.images.length > 0
                ? r.images
                : (r.image_local_filename ? [r.image_local_filename] : []);
            const rIds = r.image_drive_ids || [];
            const rByPath = new Map();
            rPaths.forEach((p, i) => {
                const id = rIds[i] || (i === 0 ? r.image_drive_id : null);
                if (id) rByPath.set(p, id);
            });

            if (!spot.image_drive_ids) spot.image_drive_ids = [];
            while (spot.image_drive_ids.length < paths.length) spot.image_drive_ids.push(null);
            paths.forEach((p, i) => {
                if (!spot.image_drive_ids[i] && rByPath.has(p)) {
                    spot.image_drive_ids[i] = rByPath.get(p);
                }
            });
            spot.image_drive_id = spot.image_drive_ids[0] || spot.image_drive_id || null;
        }
        if (!spot.audio_drive_id && r.audio_drive_id) spot.audio_drive_id = r.audio_drive_id;
    }

    const remoteSites = new Map((remote.sites || []).map(s => [s.id, s]));
    for (const site of (project.sites || [])) {
        const r = remoteSites.get(site.id);
        if (r && !site.kml_drive_id && r.kml_drive_id) site.kml_drive_id = r.kml_drive_id;
    }

    const remoteRoutes = new Map((remote.routes || []).map(r => [r.id, r]));
    for (const route of (project.routes || [])) {
        const r = remoteRoutes.get(route.id);
        if (!r) continue;
        const rAnns = new Map((r.annotations || []).map(a => [a.id, a]));
        for (const a of (route.annotations || [])) {
            const ra = rAnns.get(a.id);
            if (!ra) continue;
            if (!a.image_drive_id && ra.image_drive_id) a.image_drive_id = ra.image_drive_id;
            if (!a.audio_drive_id && ra.audio_drive_id) a.audio_drive_id = ra.audio_drive_id;
        }
    }

    const remoteJobs = new Map((remote.jobs || []).map(j => [j.job_id || j.id, j]));
    for (const job of (project.jobs || [])) {
        const r = remoteJobs.get(job.job_id || job.id);
        if (!r) continue;
        if (!job.job_file_drive_id && r.job_file_drive_id) job.job_file_drive_id = r.job_file_drive_id;
        const rRes = new Map((r.result_files || []).map(f => [f.rel_path || f.id, f]));
        for (const rf of (job.result_files || [])) {
            const rr = rRes.get(rf.rel_path || rf.id);
            if (rr && !rf.drive_id && rr.drive_id) rf.drive_id = rr.drive_id;
        }
    }
}

// Make every already-uploaded media reference public by its drive_id, reading
// refs straight from the project (never the folder). Owner-only path, run at
// share time so collaborators can stream every file from its public link.
async function _publishReferencedMedia(project) {
    let refs;
    try {
        const { enumerateFileRefs } = await import('./ProjectFilesSync.js');
        refs = enumerateFileRefs(project);
    } catch (e) {
        console.warn('[SharingService] could not enumerate refs to publish:', e.message);
        return;
    }
    const seen = new Set();
    for (const ref of refs) {
        if (!ref.driveId || seen.has(ref.driveId)) continue;
        seen.add(ref.driveId);
        try { await DriveService.makeFilePublic(ref.driveId); } catch { }
    }
}

export async function shareProject(projectId, emails, role) {
    if (!getAccessToken()) throw new Error('Not logged in.');

    const state   = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === projectId);
    if (!project) throw new Error(`Project "${projectId}" not found.`);

    if (project.shared?.isImported) {
        if (project.shared.permission !== 'writer') {
            throw new Error('You have viewer access only — you cannot share this project.');
        }

        const shareId = project.shared.projectDataFileId || project.shared.sourceFolderId;
        if (!shareId) {
            throw new Error('Missing shared-file reference — re-import the project, then share.');
        }

        try { await pushToSharedProject(project.id); }
        catch (e) { console.warn('[SharingService] pre-share push failed:', e.message); }

        const results = [];
        for (const email of emails) {
            try {
                const perm = await DriveService.shareWithUser(shareId, email.trim(), role);
                results.push({ email: email.trim(), success: true, permissionId: perm.id });
            } catch (err) {
                console.error(`[SharingService] Failed to re-share with ${email}:`, err);
                results.push({ email: email.trim(), success: false, error: err.message });
            }
        }

        project.shared.resharedWith = project.shared.resharedWith || [];
        const known = new Set(project.shared.resharedWith.map(s => s.email));
        for (const r of results) {
            if (r.success && !known.has(r.email)) {
                project.shared.resharedWith.push({ email: r.email, role, sharedAt: new Date().toISOString() });
            }
        }
        await MasterData.saveMasterData();

        EventBus.emit(EVENTS.PROJECT_SHARED, { projectId, emails, role, folderId: shareId });
        return { folderId: shareId, shareLink: shareId, results };
    }

    const rootFolderId  = await DriveService.findOrCreateRootFolder();
    const projectFolder = getProjectFolderName(project);
    const folderId      = await DriveService.ensureDrivePath([projectFolder], rootFolderId);

    if (!project.sharing) {
        project.sharing = {
            isShared: true,
            driveFolderId: folderId,
            sharedWith: [],
            sharedAt: new Date().toISOString(),
        };
    }
    project.sharing.isShared = true;
    project.sharing.driveFolderId = folderId;

    try {
        await _pushAllProjectMedia(project, rootFolderId);
        await _publishReferencedMedia(project);
        await pushProjectDataToDrive(project);
    } catch (e) {
        console.warn('[SharingService] pre-share media/data push failed (continuing):', e.message);
    }

    const results = [];
    for (const email of emails) {
        try {
            const perm = await DriveService.shareWithUser(folderId, email.trim(), role);
            results.push({ email: email.trim(), success: true, permissionId: perm.id });
        } catch (err) {
            console.error(`[SharingService] Failed to share with ${email}:`, err);
            results.push({ email: email.trim(), success: false, error: err.message });
        }
    }

    if (!project.sharing) {
        project.sharing = {
            isShared: true,
            driveFolderId: folderId,
            sharedWith: [],
            sharedAt: new Date().toISOString(),
        };
    }
    project.sharing.isShared = true;
    project.sharing.driveFolderId = folderId;

    const existingEmails = new Set(project.sharing.sharedWith.map(s => s.email));
    for (const r of results) {
        if (r.success && !existingEmails.has(r.email)) {
            project.sharing.sharedWith.push({
                email: r.email,
                role,
                permissionId: r.permissionId,
                sharedAt: new Date().toISOString(),
            });
        }
    }

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);

    const shareLink = generateShareLink(folderId);

    EventBus.emit(EVENTS.PROJECT_SHARED, { projectId, emails, role, folderId });

    return { folderId, shareLink, results };
}

export async function unshareProject(projectId, email) {
    const state   = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === projectId);
    if (!project?.sharing) return;

    const entry = project.sharing.sharedWith.find(s => s.email === email);
    if (!entry) return;

    try {
        await DriveService.removePermission(project.sharing.driveFolderId, entry.permissionId);
    } catch (err) {
        console.warn(`[SharingService] Could not remove Drive permission for ${email}:`, err);
    }

    project.sharing.sharedWith = project.sharing.sharedWith.filter(s => s.email !== email);

    if (project.sharing.sharedWith.length === 0) {
        project.sharing.isShared = false;
    }

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
}

export async function importSharedProject(projectFileId) {
    if (!getAccessToken()) throw new Error('Not logged in.');

    let fileMeta;
    try {
        fileMeta = await DriveService.getFileMetadata(
            projectFileId,
            'id,name,mimeType,parents,owners,capabilities(canEdit)'
        );
    } catch (err) {
        throw new Error(
            'Cannot access the selected file. Re-open the shared folder in the picker ' +
            'and select the file named project_data.json.'
        );
    }

    // Under the drive.file scope we can only read files the user explicitly
    // picked - the shared folder itself cannot be listed. So import is strictly
    // file-based: the user must pick the project_data.json file, not the folder.
    if (fileMeta.mimeType === 'application/vnd.google-apps.folder') {
        throw new Error(
            'Open the shared folder in the picker and select the project_data.json ' +
            'FILE inside it (not the folder). The folder itself cannot be read.'
        );
    }
    const sourceFolderId    = fileMeta.parents?.[0] || null;
    const myRole            = fileMeta.capabilities?.canEdit ? 'writer' : 'reader';
    const projectDataFileId = projectFileId;

    let sharedProject = null;
    try {
        sharedProject = JSON.parse(await DriveService.readDriveTextFile(projectDataFileId));
    } catch (err) {
        throw new Error('Could not read project_data.json from the shared folder.');
    }

    const state = MasterData.getLocalState();
    const existing = state.projects.find(p =>
        p.shared?.isImported && p.shared?.projectDataFileId === projectDataFileId
    );
    if (existing) {
        throw new Error(`Project "${existing.name}" is already imported.`);
    }

    const importedProject = {
        ...sharedProject,
        id: crypto.randomUUID(),
        shared: {
            isImported: true,
            sourceFolderId,
            sourceProjectId: sharedProject.id,
            ownerEmail: fileMeta.owners?.[0]?.emailAddress || 'unknown',
            permission: myRole,
            lastSyncedAt: new Date().toISOString(),
            projectDataFileId: projectDataFileId,
            ownerFolderName: null,
        },
    };

    const ownerFolder = getProjectFolderName({
        ...sharedProject,
        id: sharedProject.id,
    });
    const localFolder = getProjectFolderName(importedProject);
    importedProject.shared.ownerFolderName = ownerFolder;
    _remapMediaPaths(importedProject, ownerFolder, localFolder);

    delete importedProject.inline_files;

    state.projects.push(importedProject);
    await MasterData.saveMasterData();

    EventBus.emit(EVENTS.PROJECT_IMPORTED, {
        projectId: importedProject.id,
        sourceFolderId,
    });
    EventBus.emit(EVENTS.PROJECT_CHANGED);

    return importedProject;
}

const _mergeArray = (localArr = [], remoteArr = []) => mergeById(localArr, remoteArr);

export async function syncImportedProject(projectId) {
    const state   = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === projectId);

    if (!project?.shared?.isImported) {
        throw new Error('Not an imported project.');
    }

    const fileId = project.shared.projectDataFileId;
    if (!fileId) {
        throw new Error('Missing shared file reference — re-import the shared project.');
    }

    let updatedProject = null;
    try {
        updatedProject = JSON.parse(await DriveService.readDriveTextFile(fileId));
    } catch (err) {
        console.warn('[SharingService] Could not read project_data.json for sync:', err.message);
    }

    if (updatedProject) {
        const localShared = { ...project.shared };
        const localId = project.id;

        const ownerFolder = localShared.ownerFolderName
            || getProjectFolderName({ ...updatedProject, id: updatedProject.id });
        const localFolder = getProjectFolderName(project);

        const remoteForMerge = { ...updatedProject };
        _remapMediaPaths(remoteForMerge, ownerFolder, localFolder);

        project.spots          = _mergeArray(project.spots,          remoteForMerge.spots);
        project.routes         = _mergeArray(project.routes,         remoteForMerge.routes);
        project.sites          = _mergeArray(project.sites,          remoteForMerge.sites);
        project.jobs           = _mergeArray(project.jobs,           remoteForMerge.jobs);
        project.external_files = _mergeArray(project.external_files, remoteForMerge.external_files);

        _adoptRemoteMediaIds(project, remoteForMerge);

        project.name       = updatedProject.name       || project.name;
        project.created_at = updatedProject.created_at || project.created_at;

        project.id = localId;
        project.shared = {
            ...localShared,
            ownerFolderName: ownerFolder,
            lastSyncedAt: new Date().toISOString(),
            projectDataFileId: fileId,
        };

        await MasterData.saveMasterData();
        EventBus.emit(EVENTS.SHARED_PROJECT_SYNCED, { projectId });
        EventBus.emit(EVENTS.DATA_UPDATED);
        EventBus.emit(EVENTS.PROJECT_CHANGED);

    } else {
        throw new Error('Could not read the shared project_data.json (file may have been removed).');
    }
}

export async function pushToSharedProject(projectId) {
    const state   = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === projectId);

    if (!project?.shared?.isImported) {
        throw new Error('Not an imported project.');
    }
    if (project.shared.permission !== 'writer') {
        throw new Error('You only have viewer access. Cannot push changes.');
    }

    const { sourceFolderId } = project.shared;

    let fileId = project.shared.projectDataFileId || null;
    if (!fileId) {
        const f = await DriveService.findFileByName('project_data.json', sourceFolderId);
        fileId = f?.id || null;
    }

    if (!fileId) {
        throw new Error(
            'Cannot push: the shared project_data.json is not accessible to this app. ' +
            'Re-import the shared folder, or the app needs broader read permission.'
        );
    }

    let remote = { spots: [], routes: [], sites: [], external_files: [] };
    try {
        remote = JSON.parse(await DriveService.readDriveTextFile(fileId));
    } catch (e) {
        console.warn('[SharingService] Could not read shared project_data.json:', e.message);
    }

    const localFolder = getProjectFolderName(project);
    const ownerFolder = project.shared.ownerFolderName || localFolder;
    const localNs = JSON.parse(JSON.stringify(project));
    _remapMediaPaths(localNs, localFolder, ownerFolder);

    remote.spots          = _mergeArray(remote.spots,          localNs.spots);
    remote.routes         = _mergeArray(remote.routes,         localNs.routes);
    remote.sites          = _mergeArray(remote.sites,          localNs.sites);
    remote.jobs           = _mergeArray(remote.jobs,           localNs.jobs);
    remote.name       = remote.name       || project.name;
    remote.created_at = remote.created_at || project.created_at;
    delete remote.external_files;
    delete remote.shared;
    delete remote.sharing;

    delete remote.inline_files;

    const blob = new Blob([JSON.stringify(remote, null, 2)], { type: 'application/json' });

    await DriveService.updateDriveFile(fileId, blob);

    project.shared.projectDataFileId = fileId;
    project.shared.lastPushedAt = new Date().toISOString();
    project.shared.lastSyncedAt = new Date().toISOString();
    await MasterData.saveMasterData();

    EventBus.emit(EVENTS.SHARED_PROJECT_SYNCED, { projectId });
}

export async function pullEditorContributions(projectId) {
    const state   = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === projectId);

    if (!project) throw new Error(`Project "${projectId}" not found.`);

    const folderId = project.sharing?.driveFolderId;
    if (!folderId) {
        return { merged: false, contributionCount: 0 };
    }

    try {
        const { recordCompletedJobs } = await import('./ProjectFilesSync.js');
        await recordCompletedJobs(project);
    } catch (e) {
        console.warn('[SharingService] recordCompletedJobs failed:', e.message);
    }

    const file = await DriveService.findFileByName('project_data.json', folderId);
    if (!file) {
        return { merged: false, contributionCount: 0 };
    }

    let remote;
    try {
        remote = JSON.parse(await DriveService.readDriveTextFile(file.id));
    } catch (err) {
        console.warn('[SharingService] Could not read project_data.json:', err.message);
        return { merged: false, contributionCount: 0 };
    }

    project.spots          = _mergeArray(project.spots,          remote.spots);
    project.routes         = _mergeArray(project.routes,         remote.routes);
    project.sites          = _mergeArray(project.sites,          remote.sites);
    project.jobs           = _mergeArray(project.jobs,           remote.jobs);
    project.external_files = _mergeArray(project.external_files, remote.external_files);

    _adoptRemoteMediaIds(project, remote);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
    EventBus.emit(EVENTS.PROJECT_CHANGED);

    return { merged: true, contributionCount: 1 };
}

export function generateShareLink(folderId) {
    return `https://drive.google.com/drive/folders/${folderId}`;
}

export function parseFolderIdFromInput(input) {
    if (!input) return null;
    const trimmed = input.trim();

    const importMatch = trimmed.match(/[?&]import=([a-zA-Z0-9_-]+)/);
    if (importMatch) return importMatch[1];

    const driveMatch = trimmed.match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/);
    if (driveMatch) return driveMatch[1];

    if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;

    return null;
}

async function _detectMyRole(fileId) {
    try {
        const meta = await DriveService.getFileMetadata(fileId, 'capabilities');
        if (meta.capabilities?.canEdit) return 'writer';
        if (meta.capabilities?.canComment) return 'reader';
        return 'reader';
    } catch {
        return 'unknown';
    }
}

export function isImportedProject(project) {
    return !!project?.shared?.isImported;
}

export function hasEditorAccess(project) {
    return project?.shared?.permission === 'writer';
}

export function getSharingInfo(project) {
    return {
        isShared: !!project?.sharing?.isShared,
        isImported: !!project?.shared?.isImported,
        collaboratorCount: project?.sharing?.sharedWith?.length || 0,
        permission: project?.shared?.permission || null,
        ownerEmail: project?.shared?.ownerEmail || null,
    };
}
