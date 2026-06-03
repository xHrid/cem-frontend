/**
 * ProjectFilesSync.js — One model for syncing ALL project file artifacts
 *
 * Single source of truth: project_data.json lists every file a project owns —
 * spot photos/audio, site KML, and (new) completed-job records with their
 * result files. Each entry carries a Drive file ID. When the project is shared
 * those files are made link-public (by SharedMediaSync), so a collaborator can
 * download the bytes from the public URL into their OWN local storage and the
 * existing render code (spot popups, Jobs dashboard) works unchanged — no
 * "open file" buttons, no per-account Drive API access required.
 *
 * Exports:
 *   enumerateFileRefs(project)      — every {relPath, driveId, kind} the project references
 *   recordCompletedJobs(project)    — owner: fold completed jobs + results into project.jobs[]
 *   materializeProjectFiles(project)— download any drive_id'd file missing locally
 *   reconcileProjectFiles(project)  — materialize (pull) + push local-only files (bidirectional)
 */

import EventBus, { EVENTS } from '../core/EventBus.js';
import * as DriveService from './DriveService.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import * as MasterData from '../data/MasterData.js';
import { getProjectFolderName } from '../data/projectUtils.js';
import { getAccessToken } from './AuthService.js';
import { getAllJobs, getJobResultFiles } from '../data/Repository.js';

/** Drive IDs that failed to fetch this session — skip to avoid hammering each poll. */
const _unfetchable = new Set();

/**
 * Enumerate every file the project references, as {relPath, driveId, kind}.
 * Covers spot image/audio, site KML, and job (json + result files).
 *
 * @param {object} project
 * @returns {Array<{relPath:string, driveId:string|null, kind:string}>}
 */
export function enumerateFileRefs(project) {
    const refs = [];
    for (const s of (project.spots || [])) {
        if (s.image_local_filename) refs.push({ relPath: s.image_local_filename, driveId: s.image_drive_id || null, kind: 'image' });
        if (s.audio_local_filename) refs.push({ relPath: s.audio_local_filename, driveId: s.audio_drive_id || null, kind: 'audio' });
    }
    for (const st of (project.sites || [])) {
        if (st.kml_filename) refs.push({ relPath: st.kml_filename, driveId: st.kml_drive_id || null, kind: 'kml' });
    }
    for (const j of (project.jobs || [])) {
        if (j.job_file) refs.push({ relPath: j.job_file, driveId: j.job_file_drive_id || null, kind: 'job' });
        for (const rf of (j.result_files || [])) {
            if (rf.rel_path) refs.push({ relPath: rf.rel_path, driveId: rf.drive_id || null, kind: 'result' });
        }
    }
    return refs;
}

/**
 * OWNER side: find completed jobs on disk that aren't recorded on the project
 * yet, fold them into project.jobs[] (with their result-file manifest), and
 * queue every result file + the job JSON for upload. For SHARED projects
 * SharedMediaSync then publishes each file and stamps its Drive ID back onto
 * the job record (via _recordDriveId), so collaborators can pull them.
 *
 * @param {object} project
 * @returns {Promise<number>} number of newly recorded jobs
 */
export async function recordCompletedJobs(project) {
    if (!project) return 0;
    const folder = getProjectFolderName(project);

    let jobs;
    try { jobs = await getAllJobs(); } catch { return 0; }

    project.jobs = project.jobs || [];
    const known = new Set(project.jobs.map(j => j.job_id));

    let added = 0;
    for (const j of jobs) {
        if (j.current_status !== 'completed') continue;
        if (known.has(j.job_id)) continue;

        let resFiles = [];
        try { resFiles = await getJobResultFiles(j.job_id); } catch { resFiles = []; }

        const entry = {
            id:                j.job_id,        // so generic id-based merges work
            job_id:            j.job_id,
            job_name:          j.job_name || j.job_id,
            script_name:       j.script_name || null,
            status:            'completed',
            timestamp:         new Date().toISOString(),
            completed_at:      j.created_at || new Date().toISOString(),
            job_file:          `${folder}/jobs/completed/${j.job_id}.json`,
            job_file_drive_id: null,
            result_files:      resFiles.map(f => ({ name: f.name, rel_path: f.path, drive_id: null })),
        };
        project.jobs.push(entry);
        added++;

        // Queue the job JSON + every result file for Drive upload. SharedMediaSync
        // publishes + stamps drive_id for shared projects; for non-shared owner
        // projects it just backs them up (no public/id needed).
        EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: entry.job_file, isExternal: false });
        for (const rf of entry.result_files) {
            EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: rf.rel_path, isExternal: false });
        }
    }

    if (added > 0) {
        await MasterData.saveMasterData();
        EventBus.emit(EVENTS.DATA_UPDATED); // re-push project_data.json with jobs[]
    }
    return added;
}

/**
 * Download any file the project references that has a Drive ID but is missing
 * from local storage. Fetches the bytes from the public URL (cross-account) or
 * the Drive API (own files), then saves them at the referenced relative path so
 * the normal local-file render path works — for spot media AND job results.
 *
 * @param {object} project
 * @returns {Promise<number>} number of files downloaded
 */
export async function materializeProjectFiles(project) {
    if (!project || !getAccessToken()) return 0;

    let got = 0;
    for (const ref of enumerateFileRefs(project)) {
        if (!ref.driveId || _unfetchable.has(ref.driveId)) continue;
        try {
            if (await StorageAdapter.checkFileExists(ref.relPath)) continue;
            const blob = await DriveService.fetchPublicBlob(ref.driveId, ref.kind);
            if (!blob || blob.size === 0) { _unfetchable.add(ref.driveId); continue; }

            const parts = ref.relPath.split('/');
            const name  = parts.pop();
            await StorageAdapter.saveFile(blob, name, parts);
            got++;
        } catch (e) {
            _unfetchable.add(ref.driveId);
            console.warn(`[ProjectFilesSync] Could not materialize "${ref.relPath}":`, e.message);
        }
    }

    if (got > 0) {
        console.log(`[ProjectFilesSync] Materialized ${got} file(s) locally.`);
        EventBus.emit(EVENTS.DATA_UPDATED);
    }
    return got;
}

/**
 * Bidirectional reconcile for a project: download anything on Drive missing
 * locally, then queue anything local that has no Drive ID yet for upload.
 * Used after a conflict resolution (Drive-wins / merge) and on shared sync so
 * media + results actually follow the metadata.
 *
 * @param {object} project
 * @returns {Promise<number>} files downloaded
 */
export async function reconcileProjectFiles(project) {
    if (!project) return 0;
    const got = await materializeProjectFiles(project);

    // Push direction: any locally-present file that isn't on Drive yet.
    for (const ref of enumerateFileRefs(project)) {
        if (ref.driveId) continue;
        try {
            if (await StorageAdapter.checkFileExists(ref.relPath)) {
                EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: ref.relPath, isExternal: false });
            }
        } catch { /* ignore */ }
    }
    return got;
}
