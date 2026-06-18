/**
 * SharingService.js — Project sharing & collaboration logic
 *
 * Pattern  : Facade over DriveService sharing primitives
 *
 * Architecture (v2):
 *  - Each project stores its own `project_data.json` INSIDE its Drive folder.
 *  - When a project folder is shared, the recipient can read project_data.json
 *    directly from the shared folder — no need to access the parent root.
 *  - Share link = Google Drive folder link (not app URL).
 *  - Viewers: read-only pull from project_data.json in shared folder.
 *  - Editors: bidirectional — read & write project_data.json in shared folder.
 */

import EventBus, { EVENTS } from '../core/EventBus.js';
import * as DriveService from './DriveService.js';
import * as MasterData from '../data/MasterData.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import { getProjectFolderName } from '../data/projectUtils.js';
import { pushMasterToDrive, pushProjectDataToDrive } from '../data/Repository.js';
import { getAccessToken } from './AuthService.js';

// ---------------------------------------------------------------------------
// Media path remapping (owner folder → local folder)
// ---------------------------------------------------------------------------

/**
 * Remap all media file paths in a project's data from one folder prefix
 * to another. This is needed because imported projects get new local IDs,
 * resulting in different folder names.
 *
 * Mutates the project object in-place.
 *
 * @param {object} project         The project to remap.
 * @param {string} ownerFolderName The owner's project folder name.
 * @param {string} localFolderName Our local project folder name.
 */
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

// ---------------------------------------------------------------------------
// Bulk media push helper
// ---------------------------------------------------------------------------

/**
 * Push all existing media files for a project to Drive.
 * Called at share-time to ensure recipients can immediately access media.
 * Skips files that already exist on Drive (by name check in target folder).
 * Skips external_files (those are reference-only or manual sync).
 *
 * @param {object} project      The project object.
 * @param {string} rootFolderId The app's root folder ID on Drive.
 */
async function _pushAllProjectMedia(project, rootFolderId) {
    const projectFolder = getProjectFolderName(project);

    // Collect all non-external media paths
    const mediaPaths = [];
    for (const spot of (project.spots || [])) {
        if (spot.image_local_filename) mediaPaths.push(spot.image_local_filename);
        if (spot.audio_local_filename) mediaPaths.push(spot.audio_local_filename);
    }
    for (const site of (project.sites || [])) {
        if (site.kml_filename) mediaPaths.push(site.kml_filename);
    }
    for (const route of (project.routes || [])) {
        for (const a of (route.annotations || [])) {
            if (a.image_local_filename) mediaPaths.push(a.image_local_filename);
            if (a.audio_local_filename) mediaPaths.push(a.audio_local_filename);
        }
    }

    if (mediaPaths.length === 0) return;

    console.log(`[SharingService] Pushing ${mediaPaths.length} media file(s) to Drive...`);

    let pushed = 0;
    for (const relPath of mediaPaths) {
        try {
            const fileBlob = await StorageAdapter.getFileBlob(relPath);
            if (!fileBlob) continue; // File doesn't exist locally

            // Split path into folder chain + filename
            const parts = relPath.split('/');
            const filename = parts.pop();
            if (!filename) continue;

            // Ensure folder structure under root
            let parentId = rootFolderId;
            if (parts.length > 0) {
                parentId = await DriveService.ensureDrivePath(parts, rootFolderId);
            }

            // Check if already on Drive (skip duplicate uploads)
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

            // Publish + record the Drive ID so collaborators can display it via
            // a public URL (they can't list our folder under drive.file).
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
        console.log(`[SharingService] Pushed ${pushed}/${mediaPaths.length} media files to Drive.`);
    }
}

/**
 * Stamp a media file's public Drive ID onto its spot/site record (mutates in
 * place; caller persists). Lets collaborators display media via a public URL.
 *
 * @param {object} project
 * @param {string} relPath
 * @param {string} fileId
 */
function _setMediaDriveId(project, relPath, fileId) {
    // Bump timestamp alongside the drive_id so the version carrying the public
    // ID always wins last-write-wins merges (see SharedMediaSync._recordDriveId).
    const now = new Date().toISOString();
    for (const spot of (project.spots || [])) {
        if (spot.image_local_filename === relPath) { spot.image_drive_id = fileId; spot.timestamp = now; }
        if (spot.audio_local_filename === relPath) { spot.audio_drive_id = fileId; spot.timestamp = now; }
    }
    for (const site of (project.sites || [])) {
        if (site.kml_filename === relPath) { site.kml_drive_id = fileId; site.timestamp = now; }
    }
    for (const route of (project.routes || [])) {
        for (const a of (route.annotations || [])) {
            if (a.image_local_filename === relPath) { a.image_drive_id = fileId; a.timestamp = now; route.timestamp = now; }
            if (a.audio_local_filename === relPath) { a.audio_drive_id = fileId; a.timestamp = now; route.timestamp = now; }
        }
    }
}

// ---------------------------------------------------------------------------
// Share a project
// ---------------------------------------------------------------------------

/**
 * Share a project with one or more Gmail users.
 *
 * 1. Ensures project_data.json exists in the project's Drive folder.
 * 2. Grants Drive permissions on the folder to each email.
 * 3. Returns a Google Drive folder link as the share link.
 *
 * @param {string}   projectId  UUID of the project to share.
 * @param {string[]} emails     Gmail addresses to share with.
 * @param {'reader'|'writer'} role  Permission level.
 * @returns {Promise<{folderId: string, shareLink: string, results: Array}>}
 */
export async function shareProject(projectId, emails, role) {
    if (!getAccessToken()) throw new Error('Not logged in.');

    const state   = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === projectId);
    if (!project) throw new Error(`Project "${projectId}" not found.`);

    // -----------------------------------------------------------------------
    // Re-share path: this is a project shared TO us that we edit.
    // We grant additional Drive permissions on the SAME shared folder, so the
    // original owner is unchanged (A stays owner; B and C become editors). We
    // never create a copy in our own Drive.
    // -----------------------------------------------------------------------
    if (project.shared?.isImported) {
        if (project.shared.permission !== 'writer') {
            throw new Error('You have viewer access only — you cannot share this project.');
        }

        // CRITICAL: under the drive.file scope our token can only touch files
        // this app created or the user opened via the Picker. When we imported,
        // that was the project_data.json FILE — NOT its parent folder. Calling
        // permissions on the folder ID 404s ("File not found"). So we grant
        // access on the project_data.json file itself, which we CAN reach. The
        // recipient imports it by file ID exactly like we did; media travels
        // inline inside that file, so they get everything. The owner is
        // unchanged — we're only adding a permission to the owner's file.
        const shareId = project.shared.projectDataFileId || project.shared.sourceFolderId;
        if (!shareId) {
            throw new Error('Missing shared-file reference — re-import the project, then share.');
        }

        // Best-effort: push our pending edits first so recipients open current data.
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

        // Record who we re-shared with (display only; ownership stays with owner).
        project.shared.resharedWith = project.shared.resharedWith || [];
        const known = new Set(project.shared.resharedWith.map(s => s.email));
        for (const r of results) {
            if (r.success && !known.has(r.email)) {
                project.shared.resharedWith.push({ email: r.email, role, sharedAt: new Date().toISOString() });
            }
        }
        await MasterData.saveMasterData();

        // Recipient imports by file ID (the "project_data.json file ID" field in
        // the Import dialog), so hand back that ID as the share reference.
        EventBus.emit(EVENTS.PROJECT_SHARED, { projectId, emails, role, folderId: shareId });
        return { folderId: shareId, shareLink: shareId, results };
    }

    // Ensure project folder exists on Drive
    const rootFolderId  = await DriveService.findOrCreateRootFolder();
    const projectFolder = getProjectFolderName(project);
    const folderId      = await DriveService.ensureDrivePath([projectFolder], rootFolderId);

    // Mark shared NOW so pushProjectDataToDrive uses the merge path and the
    // media push knows to publish public links.
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

    // Push media FIRST — this publishes each file and stamps its public Drive
    // ID onto the spot/site records. Non-fatal: a media/data push hiccup must
    // not block granting access (this is what blocked re-sharing an already-
    // shared project before).
    try {
        await _pushAllProjectMedia(project, rootFolderId);
        // ...then push project_data.json so it carries those Drive IDs for editors.
        await pushProjectDataToDrive(project);
    } catch (e) {
        console.warn('[SharingService] pre-share media/data push failed (continuing):', e.message);
    }

    // Share with each email
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

    // Store sharing metadata on the project
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

    // Update shared-with list (avoid duplicates)
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
    pushMasterToDrive(); // fire-and-forget

    // Share link = Google Drive folder link (not localhost!)
    const shareLink = generateShareLink(folderId);

    EventBus.emit(EVENTS.PROJECT_SHARED, { projectId, emails, role, folderId });

    return { folderId, shareLink, results };
}

/**
 * Remove a collaborator's access from a shared project.
 *
 * @param {string} projectId  UUID of the project.
 * @param {string} email      Email to remove.
 * @returns {Promise<void>}
 */
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
    pushMasterToDrive();
}

// ---------------------------------------------------------------------------
// Import a shared project
// ---------------------------------------------------------------------------

/**
 * Import a shared project from the picked `project_data.json` FILE.
 *
 * The editor selects project_data.json via the Picker, which grants drive.file
 * read+write to that exact file. We read it by ID (no folder listing — which
 * drive.file can't do for the owner's files) and derive the shared folder ID
 * from the file's `parents`, so media uploads/downloads still have a target.
 *
 * @param {string} projectFileId  Drive file ID of the shared project_data.json.
 * @returns {Promise<object>}     The imported project object.
 */
export async function importSharedProject(projectFileId) {
    if (!getAccessToken()) throw new Error('Not logged in.');

    // Read metadata of the picked file (id is now app-authorized via the Picker).
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

    // Accept EITHER the shared folder (preferred) or a project_data.json file
    // (back-compat). A folder pick grants drive.file access to the folder AND its
    // contents, so we can list it, read project_data.json, AND download every
    // media/result file via the API — no CORS, no restricted scope.
    let sourceFolderId, projectDataFileId, myRole;
    if (fileMeta.mimeType === 'application/vnd.google-apps.folder') {
        sourceFolderId    = fileMeta.id;
        myRole            = fileMeta.capabilities?.canEdit ? 'writer' : 'reader';
        const pdFile      = await DriveService.findFileByName('project_data.json', sourceFolderId);
        if (!pdFile) {
            throw new Error('Cannot list this folder under drive.file. Re-open it in the picker ' +
                'and select the project_data.json FILE inside instead.');
        }
        projectDataFileId = pdFile.id;
    } else {
        sourceFolderId    = fileMeta.parents?.[0] || null;
        myRole            = fileMeta.capabilities?.canEdit ? 'writer' : 'reader';
        projectDataFileId = projectFileId;
    }

    // Read the project JSON by file ID.
    let sharedProject = null;
    try {
        sharedProject = JSON.parse(await DriveService.readDriveTextFile(projectDataFileId));
        console.log('[SharingService] Read shared project_data.json.');
    } catch (err) {
        throw new Error('Could not read project_data.json from the shared folder.');
    }

    // Already imported? (key off the project_data.json file id)
    const state = MasterData.getLocalState();
    const existing = state.projects.find(p =>
        p.shared?.isImported && p.shared?.projectDataFileId === projectDataFileId
    );
    if (existing) {
        throw new Error(`Project "${existing.name}" is already imported.`);
    }

    // Tag with import metadata
    const importedProject = {
        ...sharedProject,
        id: crypto.randomUUID(), // New local ID to avoid collisions
        shared: {
            isImported: true,
            sourceFolderId,                  // derived from the file's parent
            sourceProjectId: sharedProject.id,
            ownerEmail: fileMeta.owners?.[0]?.emailAddress || 'unknown',
            permission: myRole,
            lastSyncedAt: new Date().toISOString(),
            projectDataFileId: projectDataFileId,
            ownerFolderName: null, // Set below — needed for path remapping
        },
    };

    // Remap media paths from owner's folder to our local folder
    const ownerFolder = getProjectFolderName({
        ...sharedProject,
        id: sharedProject.id,
    });
    const localFolder = getProjectFolderName(importedProject);
    importedProject.shared.ownerFolderName = ownerFolder;
    _remapMediaPaths(importedProject, ownerFolder, localFolder);

    // Strip any legacy inline_files payload — media is on-demand now.
    delete importedProject.inline_files;

    // Add to local state
    state.projects.push(importedProject);
    await MasterData.saveMasterData();

    EventBus.emit(EVENTS.PROJECT_IMPORTED, {
        projectId: importedProject.id,
        sourceFolderId,
    });
    EventBus.emit(EVENTS.PROJECT_CHANGED);

    return importedProject;
}

// ---------------------------------------------------------------------------
// Merge helper
// ---------------------------------------------------------------------------

/**
 * Merge two item arrays by ID (spotId or id), keeping the item with the
 * later timestamp when both sides have the same ID.
 * Items unique to either side are kept.
 *
 * @param {object[]} localArr   Local items.
 * @param {object[]} remoteArr  Remote items.
 * @returns {object[]}          Merged result.
 */
function _mergeArray(localArr = [], remoteArr = []) {
    const map = new Map();

    // Add local items first
    for (const item of localArr) {
        const id = item.spotId || item.id;
        if (id) map.set(id, item);
    }

    // Merge remote — newer timestamps win
    for (const item of remoteArr) {
        const id = item.spotId || item.id;
        if (!id) continue;

        const existing = map.get(id);
        if (!existing) {
            map.set(id, item);
        } else {
            const existingTime = new Date(existing.timestamp || 0).getTime();
            const remoteTime   = new Date(item.timestamp    || 0).getTime();
            if (remoteTime > existingTime) {
                map.set(id, item);
            }
        }
    }

    return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Sync imported projects
// ---------------------------------------------------------------------------

/**
 * Pull latest data for an imported project from the shared folder's project_data.json.
 *
 * @param {string} projectId  Local UUID of the imported project.
 * @returns {Promise<void>}
 */
export async function syncImportedProject(projectId) {
    const state   = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === projectId);

    if (!project?.shared?.isImported) {
        throw new Error('Not an imported project.');
    }

    // Read the shared project_data.json by its KNOWN file ID. drive.file can't
    // list the owner's folder, so we never search by name here.
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
        // MERGE instead of overwrite — preserve locally-added items
        const localShared = { ...project.shared };
        const localId = project.id;

        // Remap remote media paths to local folder before merging
        const ownerFolder = localShared.ownerFolderName
            || getProjectFolderName({ ...updatedProject, id: updatedProject.id });
        const localFolder = getProjectFolderName(project);

        // Remap remote data paths before merge
        const remoteForMerge = { ...updatedProject };
        _remapMediaPaths(remoteForMerge, ownerFolder, localFolder);

        // Merge each collection using last-write-wins by ID
        project.spots          = _mergeArray(project.spots,          remoteForMerge.spots);
        project.routes         = _mergeArray(project.routes,         remoteForMerge.routes);
        project.sites          = _mergeArray(project.sites,          remoteForMerge.sites);
        project.jobs           = _mergeArray(project.jobs,           remoteForMerge.jobs);
        project.external_files = _mergeArray(project.external_files, remoteForMerge.external_files);

        // Update scalar fields from remote
        project.name       = updatedProject.name       || project.name;
        project.created_at = updatedProject.created_at || project.created_at;

        project.id = localId; // Keep local ID
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

        // Media pull is ON-DEMAND now — the UI shows placeholders for missing
        // files with download buttons. No auto-pull here.
    } else {
        throw new Error('Could not read the shared project_data.json (file may have been removed).');
    }
}

/**
 * Push an editor's local changes back into the shared project_data.json.
 *
 * Single-file model: there is ONE project_data.json per shared folder, and
 * everyone (owner + editors) reads/merges/writes the same file. The editor
 * gained drive.file WRITE access to it by opening the folder via the Picker,
 * so no separate `editor_contributions.json` is needed anymore.
 *
 * Read-modify-write: we pull the current remote, merge our local data in
 * (last-write-wins by item timestamp), and PATCH the same file — so we never
 * clobber edits made by the owner or other editors.
 *
 * @param {string} projectId  Local UUID of the imported project.
 * @returns {Promise<void>}
 */
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

    // Locate the single shared project_data.json — the owner's file.
    let fileId = project.shared.projectDataFileId || null;
    if (!fileId) {
        const f = await DriveService.findFileByName('project_data.json', sourceFolderId);
        fileId = f?.id || null;
    }

    // CRITICAL: never CREATE a project_data.json here. If we don't have the
    // owner's file ID, the import never truly read it (drive.file can't list
    // the owner's file) — creating one would make a duplicate + fork the data.
    // Bail out instead.
    if (!fileId) {
        throw new Error(
            'Cannot push: the shared project_data.json is not accessible to this app. ' +
            'Re-import the shared folder, or the app needs broader read permission.'
        );
    }

    // Read current remote so the merge doesn't clobber others' edits.
    let remote = { spots: [], routes: [], sites: [], external_files: [] };
    try {
        remote = JSON.parse(await DriveService.readDriveTextFile(fileId));
    } catch (e) {
        console.warn('[SharingService] Could not read shared project_data.json:', e.message);
    }

    // Our local data uses OUR folder namespace; the shared file uses the
    // owner's. Remap local → owner before merging.
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
    delete remote.external_files; // external media is never shared — strip paths
    delete remote.shared;         // never leak local collaboration metadata
    delete remote.sharing;

    // Media bytes travel via Drive files (public links), not inline in the JSON.
    // Strip any legacy inline_files from the remote before writing back.
    delete remote.inline_files;

    const blob = new Blob([JSON.stringify(remote, null, 2)], { type: 'application/json' });

    // Write back to the SAME file by ID (PATCH). Do NOT use findFileByName/
    // upsert here — under drive.file the editor can't list the owner's file,
    // so a name lookup would miss it and create a duplicate.
    await DriveService.updateDriveFile(fileId, blob);

    project.shared.projectDataFileId = fileId;
    project.shared.lastPushedAt = new Date().toISOString();
    project.shared.lastSyncedAt = new Date().toISOString();
    await MasterData.saveMasterData();

    EventBus.emit(EVENTS.SHARED_PROJECT_SYNCED, { projectId });
}

/**
 * Push a local media file to the shared project folder on Drive.
 *
 * Unlike SyncService.syncUp (which pushes to YOUR root folder), this pushes
 * directly into the shared folder so the owner and other editors can see it.
 *
 * @param {string} projectId  Local UUID of the imported project.
 * @param {string} relPath    App-relative path of the local file.
 * @returns {Promise<void>}
 */
export async function pushMediaToSharedFolder(projectId, relPath) {
    const state   = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === projectId);

    if (!project?.shared?.isImported) {
        throw new Error('Not an imported project.');
    }
    if (project.shared.permission !== 'writer') {
        throw new Error('You only have viewer access. Cannot push media.');
    }

    const { sourceFolderId } = project.shared;

    const fileBlob = await StorageAdapter.getFileBlob(relPath);
    if (!fileBlob) throw new Error(`Local file not found: ${relPath}`);

    // Remap path: local project folder → owner's folder structure
    const localFolder = getProjectFolderName(project);
    const ownerFolder = project.shared.ownerFolderName || localFolder;

    let targetPath = relPath;
    if (relPath.startsWith(localFolder + '/')) {
        targetPath = ownerFolder + relPath.substring(localFolder.length);
    }

    // Resolve subfolder path inside the shared folder
    const parts    = targetPath.split('/');
    const _projectRoot = parts.shift(); // Remove the project folder name (it IS the shared folder)
    const filename = parts.pop();

    // Create subfolders inside shared folder if needed
    let parentId = sourceFolderId;
    if (parts.length > 0) {
        parentId = await DriveService.ensureDrivePath(parts, sourceFolderId);
    }

    // Upload with relativePath appProperty so owner's sync can find it
    await DriveService.uploadFile(
        fileBlob,
        filename,
        fileBlob.type || 'application/octet-stream',
        parentId,
        targetPath
    );

    console.log(`[SharingService] Pushed media "${filename}" to shared folder.`);
}

/**
 * Owner-side pull: read the shared project_data.json (which editors now edit
 * directly) and merge their changes into the local project.
 *
 * Single-file model — no editor_contributions.json. The owner's folder
 * namespace equals the local namespace, so no path remapping is needed.
 *
 * @param {string} projectId  Local UUID of the owner's project.
 * @returns {Promise<{merged: boolean, contributionCount: number}>}
 */
export async function pullEditorContributions(projectId) {
    const state   = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === projectId);

    if (!project) throw new Error(`Project "${projectId}" not found.`);

    const folderId = project.sharing?.driveFolderId;
    if (!folderId) {
        return { merged: false, contributionCount: 0 };
    }

    // Owner: fold any locally-completed analysis jobs into the project and queue
    // their results for upload, so collaborators receive them automatically
    // (no need to open the Jobs dashboard first).
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

    // Merge editor edits into local (same namespace).
    project.spots          = _mergeArray(project.spots,          remote.spots);
    project.routes         = _mergeArray(project.routes,         remote.routes);
    project.sites          = _mergeArray(project.sites,          remote.sites);
    project.jobs           = _mergeArray(project.jobs,           remote.jobs);
    project.external_files = _mergeArray(project.external_files, remote.external_files);

    await MasterData.saveMasterData();
    EventBus.emit(EVENTS.DATA_UPDATED);
    EventBus.emit(EVENTS.PROJECT_CHANGED);

    // Media pull is ON-DEMAND — the UI shows download buttons for missing media.
    // No auto-pull of editor media here.

    return { merged: true, contributionCount: 1 };
}

// ---------------------------------------------------------------------------
// Link helpers
// ---------------------------------------------------------------------------

/**
 * Generate a shareable link from a Drive folder ID.
 * Uses Google Drive folder URL — domain-independent.
 *
 * @param {string} folderId  Drive folder ID.
 * @returns {string}  Google Drive folder URL.
 */
export function generateShareLink(folderId) {
    return `https://drive.google.com/drive/folders/${folderId}`;
}

/**
 * Extract a Drive folder ID from a shareable link or raw ID.
 *
 * Handles:
 *  - Raw folder IDs
 *  - App links: https://...?import=FOLDER_ID
 *  - Drive links: https://drive.google.com/drive/folders/FOLDER_ID
 *  - Drive links with query params: .../FOLDER_ID?usp=sharing
 *
 * @param {string} input  Link or folder ID.
 * @returns {string|null}  Extracted folder ID or null.
 */
export function parseFolderIdFromInput(input) {
    if (!input) return null;
    const trimmed = input.trim();

    // App link with ?import= param
    const importMatch = trimmed.match(/[?&]import=([a-zA-Z0-9_-]+)/);
    if (importMatch) return importMatch[1];

    // Google Drive folder link (with optional query params)
    const driveMatch = trimmed.match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/);
    if (driveMatch) return driveMatch[1];

    // Raw folder ID (alphanumeric + dashes + underscores, typically 25-45 chars)
    if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;

    return null;
}

// ---------------------------------------------------------------------------
// Utility: detect user's role on a shared file
// ---------------------------------------------------------------------------

/**
 * Detect the current user's permission role on a shared file/folder.
 *
 * @param {string} fileId  Drive file/folder ID.
 * @returns {Promise<'owner'|'writer'|'reader'|'unknown'>}
 */
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

/**
 * Check whether a project is an imported shared project.
 *
 * @param {object} project
 * @returns {boolean}
 */
export function isImportedProject(project) {
    return !!project?.shared?.isImported;
}

/**
 * Check whether an imported project has editor (writer) access.
 *
 * @param {object} project
 * @returns {boolean}
 */
export function hasEditorAccess(project) {
    return project?.shared?.permission === 'writer';
}

/**
 * Get sharing info summary for a project.
 *
 * @param {object} project
 * @returns {{ isShared: boolean, isImported: boolean, collaboratorCount: number, permission: string|null }}
 */
export function getSharingInfo(project) {
    return {
        isShared: !!project?.sharing?.isShared,
        isImported: !!project?.shared?.isImported,
        collaboratorCount: project?.sharing?.sharedWith?.length || 0,
        permission: project?.shared?.permission || null,
        ownerEmail: project?.shared?.ownerEmail || null,
    };
}
