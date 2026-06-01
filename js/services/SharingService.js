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
    for (const file of (project.external_files || [])) {
        file.local_path = remap(file.local_path);
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
            if (existing) {
                // Update content in case local version is newer
                await DriveService.updateDriveFile(existing.id, fileBlob);
            } else {
                await DriveService.uploadFile(
                    fileBlob,
                    filename,
                    fileBlob.type || 'application/octet-stream',
                    parentId,
                    relPath
                );
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

    // Ensure project folder exists on Drive
    const rootFolderId  = await DriveService.findOrCreateRootFolder();
    const projectFolder = getProjectFolderName(project);
    const folderId      = await DriveService.ensureDrivePath([projectFolder], rootFolderId);

    // Push project_data.json into the folder BEFORE sharing
    await pushProjectDataToDrive(project);

    // Push ALL existing media to Drive so recipients can pull it immediately
    await _pushAllProjectMedia(project, rootFolderId);

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
 * Import a shared project by its Drive folder ID.
 *
 * Reads `project_data.json` directly from the shared folder.
 * No need to access parent folder or owner's master_data.json.
 *
 * @param {string} folderId  Drive folder ID from the share link.
 * @returns {Promise<object>}  The imported project object.
 */
export async function importSharedProject(folderId) {
    if (!getAccessToken()) throw new Error('Not logged in.');

    // Verify we can access the folder
    let folderMeta;
    try {
        folderMeta = await DriveService.getFileMetadata(folderId);
    } catch (err) {
        throw new Error(
            'Cannot access shared folder. Make sure the link is correct and the owner has shared it with you.'
        );
    }

    if (folderMeta.mimeType !== 'application/vnd.google-apps.folder') {
        throw new Error('The provided ID is not a folder.');
    }

    // Determine our permission level on this folder
    const myRole = await _detectMyRole(folderId);

    // Read project_data.json from INSIDE the shared folder
    let sharedProject = null;
    const projectFile = await DriveService.findFileByName('project_data.json', folderId);

    if (projectFile) {
        try {
            const text = await DriveService.readDriveTextFile(projectFile.id);
            sharedProject = JSON.parse(text);
            console.log('[SharingService] Read project_data.json from shared folder.');
        } catch (err) {
            console.warn('[SharingService] Could not parse project_data.json:', err);
        }
    }

    // Fallback: build minimal project from folder name
    if (!sharedProject) {
        console.warn('[SharingService] No project_data.json found — building from folder name.');
        sharedProject = {
            id: crypto.randomUUID(),
            name: folderMeta.name.replace(/_[a-f0-9]{6}$/, '').replace(/_/g, ' '),
            spots: [],
            routes: [],
            sites: [],
            external_files: [],
            created_at: new Date().toISOString(),
        };
    }

    // Check if already imported
    const state = MasterData.getLocalState();
    const existing = state.projects.find(p =>
        p.shared?.isImported && p.shared?.sourceFolderId === folderId
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
            sourceFolderId: folderId,        // The shared project folder
            sourceProjectId: sharedProject.id,
            ownerEmail: folderMeta.owners?.[0]?.emailAddress || 'unknown',
            permission: myRole,
            lastSyncedAt: new Date().toISOString(),
            projectDataFileId: projectFile?.id || null,
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

    // Add to local state
    state.projects.push(importedProject);
    await MasterData.saveMasterData();

    EventBus.emit(EVENTS.PROJECT_IMPORTED, {
        projectId: importedProject.id,
        sourceFolderId: folderId,
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

    const { sourceFolderId } = project.shared;

    // Read project_data.json from the shared folder
    let updatedProject = null;
    const projectFile = await DriveService.findFileByName('project_data.json', sourceFolderId);

    if (projectFile) {
        try {
            const text = await DriveService.readDriveTextFile(projectFile.id);
            updatedProject = JSON.parse(text);
        } catch (err) {
            console.warn('[SharingService] Could not read project_data.json for sync:', err);
        }
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
        project.external_files = _mergeArray(project.external_files, remoteForMerge.external_files);

        // Update scalar fields from remote
        project.name       = updatedProject.name       || project.name;
        project.created_at = updatedProject.created_at || project.created_at;

        project.id = localId; // Keep local ID
        project.shared = {
            ...localShared,
            ownerFolderName: ownerFolder,
            lastSyncedAt: new Date().toISOString(),
            projectDataFileId: projectFile.id,
        };

        await MasterData.saveMasterData();
        EventBus.emit(EVENTS.SHARED_PROJECT_SYNCED, { projectId });
        EventBus.emit(EVENTS.DATA_UPDATED);
        EventBus.emit(EVENTS.PROJECT_CHANGED);

        // Auto-pull media files from the shared folder
        await _pullMediaFromSharedFolder(project);
    } else {
        throw new Error('Could not find project_data.json in shared folder. Owner may not have synced yet.');
    }
}

/**
 * Pull media files from the shared folder that we don't have locally.
 * Runs after project_data.json sync — downloads images, audio, KMLs, etc.
 * Skips external_files (manual sync).
 *
 * @param {object} project  The imported project (already merged with remote data).
 * @returns {Promise<void>}
 */
async function _pullMediaFromSharedFolder(project) {
    const { sourceFolderId, ownerFolderName } = project.shared;
    if (!sourceFolderId) return;

    const localFolder = getProjectFolderName(project);
    const ownerFolder = ownerFolderName || localFolder;

    // Collect all media paths referenced by the project (non-external)
    const mediaPaths = [];

    for (const spot of (project.spots || [])) {
        if (spot.image_local_filename) mediaPaths.push(spot.image_local_filename);
        if (spot.audio_local_filename) mediaPaths.push(spot.audio_local_filename);
    }
    for (const site of (project.sites || [])) {
        if (site.kml_filename) mediaPaths.push(site.kml_filename);
    }
    // Skip external_files — those are manual sync only

    // For each path, check if we have it locally; if not, try to download from shared folder
    let downloaded = 0;
    for (const localPath of mediaPaths) {
        try {
            const exists = await StorageAdapter.checkFileExists(localPath);
            if (exists) continue; // Already have it

            // Map local path → owner path → find in shared folder
            let ownerPath = localPath;
            if (localPath.startsWith(localFolder + '/')) {
                ownerPath = ownerFolder + localPath.substring(localFolder.length);
            }

            // Remove project folder prefix to get subfolder path inside shared folder
            const subPath = ownerPath.startsWith(ownerFolder + '/')
                ? ownerPath.substring(ownerFolder.length + 1)
                : ownerPath;

            // Walk the subfolder path to find the file on Drive
            const parts = subPath.split('/');
            const filename = parts.pop();

            let parentId = sourceFolderId;
            // Navigate to parent folder
            for (const folderName of parts) {
                const folder = await DriveService.findFileByName(folderName, parentId);
                if (!folder) { parentId = null; break; }
                parentId = folder.id;
            }

            if (!parentId) continue; // Folder path doesn't exist on Drive yet

            // Find the file
            const driveFile = await DriveService.findFileByName(filename, parentId);
            if (!driveFile) continue; // File not on Drive yet (owner hasn't synced it)

            // Download and save locally
            const blob = await DriveService.downloadBlob(driveFile.id);
            const localParts = localPath.split('/');
            const localFilename = localParts.pop();
            await StorageAdapter.saveFile(blob, localFilename, localParts);

            downloaded++;
        } catch (err) {
            console.warn(`[SharingService] Could not pull media "${localPath}":`, err.message);
        }
    }

    if (downloaded > 0) {
        console.log(`[SharingService] Auto-pulled ${downloaded} media file(s) from shared folder.`);
        EventBus.emit(EVENTS.DATA_UPDATED);
    }
}

/**
 * Push local changes from an imported editor project back to the shared folder.
 *
 * Creates/updates `editor_contributions.json` — a file OWNED by the editor.
 * Because `drive.file` scope can only update files the app itself created,
 * editors cannot modify the owner's `project_data.json`. Instead, each editor
 * writes their own contribution file which the owner merges on sync.
 *
 * Strategy:
 *  - Find existing `editor_contributions.json` owned by ME → update it.
 *  - If none found → create a new one in the shared folder.
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

    const { sourceFolderId, sourceProjectId } = project.shared;

    // Build contribution payload — editor's current view of all data
    // Remap local paths back to owner's folder paths for compatibility
    const contribution = {
        sourceProjectId,
        editorLocalId: project.id,
        contributedAt: new Date().toISOString(),
        spots: JSON.parse(JSON.stringify(project.spots || [])),
        routes: JSON.parse(JSON.stringify(project.routes || [])),
        sites: JSON.parse(JSON.stringify(project.sites || [])),
        external_files: JSON.parse(JSON.stringify(project.external_files || [])),
    };

    const localFolder = getProjectFolderName(project);
    const ownerFolder = project.shared.ownerFolderName;
    if (ownerFolder) {
        _remapMediaPaths(contribution, localFolder, ownerFolder);
    }

    const blob = new Blob(
        [JSON.stringify(contribution, null, 2)],
        { type: 'application/json' }
    );

    // Try to find OUR existing contribution file (we own it → can update)
    // NOTE: drive.file scope can only see files created by THIS app.
    // We search with 'me' in owners so we only find our own file.
    let myFile = null;
    try {
        myFile = await DriveService.findMyFileByName(
            'editor_contributions.json',
            sourceFolderId
        );
    } catch (err) {
        // drive.file scope may not find files in shared folders via query —
        // fall through to create path
        console.warn('[SharingService] findMyFileByName failed (expected with drive.file):', err.message);
    }

    if (myFile) {
        // Update our own file (drive.file allows this — we created it)
        await DriveService.updateDriveFile(myFile.id, blob);
        console.log('[SharingService] Updated existing editor_contributions.json:', myFile.id);
    } else {
        // Check if we previously stored the contribution file ID
        if (project.shared.contributionFileId) {
            try {
                await DriveService.updateDriveFile(project.shared.contributionFileId, blob);
                console.log('[SharingService] Updated editor_contributions.json via stored ID:', project.shared.contributionFileId);
            } catch (updateErr) {
                console.warn('[SharingService] Stored file ID stale, creating new:', updateErr.message);
                const newFile = await DriveService.uploadFile(
                    blob,
                    'editor_contributions.json',
                    'application/json',
                    sourceFolderId
                );
                project.shared.contributionFileId = newFile.id;
                console.log('[SharingService] Created new editor_contributions.json:', newFile.id);
            }
        } else {
            // Create new contribution file in shared folder
            const newFile = await DriveService.uploadFile(
                blob,
                'editor_contributions.json',
                'application/json',
                sourceFolderId
            );
            // Store the file ID so we can update it next time without needing to query
            project.shared.contributionFileId = newFile.id;
            console.log('[SharingService] Created new editor_contributions.json:', newFile.id);
        }
    }

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
 * Pull editor contributions from a shared project folder (owner-side).
 *
 * Reads all `editor_contributions.json` files in the project folder,
 * merges their data into the local project, then pushes updated
 * `project_data.json` back to Drive.
 *
 * @param {string} projectId  Local UUID of the owner's project.
 * @returns {Promise<{merged: boolean, contributionCount: number}>}
 */
export async function pullEditorContributions(projectId) {
    const state   = MasterData.getLocalState();
    const project = state.projects.find(p => p.id === projectId);

    if (!project) throw new Error(`Project "${projectId}" not found.`);

    // Determine folder ID — owner's project uses sharing.driveFolderId
    const folderId = project.sharing?.driveFolderId;
    if (!folderId) {
        return { merged: false, contributionCount: 0 };
    }

    // Find all editor_contributions.json files in folder
    const contribFiles = await DriveService.findFilesByPrefix(
        'editor_contributions',
        folderId
    );

    if (contribFiles.length === 0) {
        return { merged: false, contributionCount: 0 };
    }

    let mergedAny = false;

    for (const file of contribFiles) {
        try {
            const text = await DriveService.readDriveTextFile(file.id);
            const contrib = JSON.parse(text);

            // Merge each collection
            project.spots          = _mergeArray(project.spots,          contrib.spots);
            project.routes         = _mergeArray(project.routes,         contrib.routes);
            project.sites          = _mergeArray(project.sites,          contrib.sites);
            project.external_files = _mergeArray(project.external_files, contrib.external_files);

            mergedAny = true;
            console.log(`[SharingService] Merged contributions from ${file.name} (${file.id})`);
        } catch (err) {
            console.warn(`[SharingService] Failed to read contribution ${file.id}:`, err);
        }
    }

    if (mergedAny) {
        await MasterData.saveMasterData();

        // Push updated project_data.json back to Drive so editors get merged view
        await pushProjectDataToDrive(project);

        EventBus.emit(EVENTS.DATA_UPDATED);
        EventBus.emit(EVENTS.PROJECT_CHANGED);

        // Auto-pull media uploaded by editors into the shared folder
        await _pullEditorMediaFromSharedFolder(project, folderId);
    }

    return { merged: mergedAny, contributionCount: contribFiles.length };
}

/**
 * Pull media files that editors uploaded into the shared project folder.
 * Owner-side: downloads any media in the shared folder that we don't have locally.
 *
 * @param {object} project   Owner's project.
 * @param {string} folderId  Drive folder ID of the shared project folder.
 */
async function _pullEditorMediaFromSharedFolder(project, folderId) {
    const projectFolder = getProjectFolderName(project);

    // List all files in shared folder recursively
    let allFiles;
    try {
        allFiles = await DriveService.listAllFilesInFolder(folderId);
    } catch (err) {
        console.warn('[SharingService] Could not list shared folder for media pull:', err);
        return;
    }

    // Build folder-ID-to-path map
    const folderMap = new Map();
    folderMap.set(folderId, '');
    for (const f of allFiles) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
            const parentId = f.parents?.[0];
            const parentPath = folderMap.get(parentId) ?? '';
            folderMap.set(f.id, parentPath ? `${parentPath}/${f.name}` : f.name);
        }
    }

    let downloaded = 0;

    for (const file of allFiles) {
        // Skip folders and metadata files
        if (file.mimeType === 'application/vnd.google-apps.folder') continue;
        if (file.name === 'project_data.json') continue;
        if (file.name === 'editor_contributions.json') continue;

        // Determine local path
        const parentId = file.parents?.[0];
        const parentPath = folderMap.get(parentId);
        if (parentPath === undefined) continue;

        const subPath = parentPath ? `${parentPath}/${file.name}` : file.name;
        const localPath = `${projectFolder}/${subPath}`;

        // Skip if we already have it
        try {
            const exists = await StorageAdapter.checkFileExists(localPath);
            if (exists) continue;
        } catch { continue; }

        // Download and save locally
        try {
            const blob = await DriveService.downloadBlob(file.id);
            const parts = localPath.split('/');
            const filename = parts.pop();
            await StorageAdapter.saveFile(blob, filename, parts);
            downloaded++;
        } catch (err) {
            console.warn(`[SharingService] Could not download editor media "${file.name}":`, err.message);
        }
    }

    if (downloaded > 0) {
        console.log(`[SharingService] Auto-pulled ${downloaded} editor media file(s).`);
        EventBus.emit(EVENTS.DATA_UPDATED);
    }
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
