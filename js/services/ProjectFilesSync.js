/**
 * ProjectFilesSync.js — One model for syncing ALL project file artifacts
 *
 * Architecture (v3 — on-demand pull):
 *   project_data.json lists every file a project owns — spot photos/audio,
 *   site KML, and completed-job records with their result files. Each entry
 *   carries a Drive file ID. When the project is shared those files are made
 *   link-public (by SharedMediaSync).
 *
 *   PUSH is automatic: SharedMediaSync uploads media + publishes + stamps
 *   drive_id back on the entity record.
 *
 *   PULL is on-demand: the UI shows a placeholder for files that are on Drive
 *   but not local, with a download button. Clicking it calls
 *   downloadMediaFile() which fetches the blob (API for own files, public URL
 *   for cross-account images), saves it locally, and returns a local URL.
 *   For audio/text where CORS blocks the public download host, we fall back
 *   to opening the file in a new tab so the user can save it manually.
 *
 * Exports:
 *   enumerateFileRefs(project)        — every {relPath, driveId, kind} the project references
 *   recordCompletedJobs(project)      — owner: fold completed jobs + results into project.jobs[]
 *   downloadMediaFile(driveId, relPath, kind) — on-demand single-file download
 *   getPublicUrl(driveId, kind)       — public hot-link URL for display / download
 *   reconcileProjectFiles(project)    — push local-only files (upload direction only)
 */

import EventBus, { EVENTS } from '../core/EventBus.js';
import Config from '../core/Config.js';
import * as DriveService from './DriveService.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import * as MasterData from '../data/MasterData.js';
import { getProjectFolderName } from '../data/projectUtils.js';
import { getAccessToken } from './AuthService.js';
import { getAllJobs, getJobResultFiles } from '../data/Repository.js';

/** Drive IDs that failed to fetch this session — skip to avoid hammering. */
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
    for (const rt of (project.routes || [])) {
        for (const a of (rt.annotations || [])) {
            if (a.image_local_filename) refs.push({ relPath: a.image_local_filename, driveId: a.image_drive_id || null, kind: 'image' });
            if (a.audio_local_filename) refs.push({ relPath: a.audio_local_filename, driveId: a.audio_drive_id || null, kind: 'audio' });
        }
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

// ---------------------------------------------------------------------------
// On-demand single-file download
// ---------------------------------------------------------------------------

/**
 * Build a PUBLIC (unauthenticated) hot-link URL for a Drive media file.
 *
 * Images use the thumbnail CDN (sends CORS headers → <img> works cross-origin).
 * Everything else uses the usercontent download host. When a Cloudflare Worker
 * proxy is configured (Config.proxy.workerUrl), non-image URLs are routed
 * through /drive?id=… which adds CORS headers — enabling inline <audio>
 * playback and fetch() for text/CSV/JSON that otherwise fail cross-origin.
 *
 * @param {string} fileId  Drive file ID (must be link-public).
 * @param {string} [kind]  'image' | 'audio' | 'kml' | 'job' | 'result'
 * @returns {string}
 */
export function getPublicUrl(fileId, kind = '') {
    if (kind === 'image') {
        return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;
    }
    const proxy = Config.proxy?.workerUrl;
    if (proxy) {
        // Route through CORS proxy → audio plays inline, text fetches work
        return `${proxy}/drive?id=${fileId}`;
    }
    return `https://drive.usercontent.google.com/download?id=${fileId}&export=download`;
}

/**
 * Download a SINGLE media file on demand: fetch from Drive (authenticated API
 * first, then public URL), save to local storage, and return a usable local
 * object URL.
 *
 * Returns `{ url, source }` on success, `null` when every fetch path fails
 * (e.g. CORS blocks the public download host for audio/text). Callers should
 * show a "Open in Drive" fallback link in that case.
 *
 * @param {string} driveId   Drive file ID (link-public for shared projects).
 * @param {string} relPath   Local relative path to save under.
 * @param {string} [kind]    'image' | 'audio' | 'kml' | 'job' | 'result'
 * @returns {Promise<{url: string, source: 'local'}|null>}
 */
export async function downloadMediaFile(driveId, relPath, kind = '') {
    if (!driveId) return null;

    // Already local?
    try {
        if (await StorageAdapter.checkFileExists(relPath)) {
            const url = await StorageAdapter.getFileUrl(relPath);
            if (url) return { url, source: 'local' };
        }
    } catch { /* fall through */ }

    // Skip IDs that already failed this session
    if (_unfetchable.has(driveId)) return null;

    // Try fetching: authenticated API → public URL → CORS proxy fallback
    try {
        let blob = await DriveService.fetchPublicBlob(driveId, kind);

        // If DriveService failed and we have a CORS proxy, try that
        if ((!blob || blob.size === 0) && Config.proxy?.workerUrl) {
            try {
                const proxyUrl = `${Config.proxy.workerUrl}/drive?id=${driveId}`;
                const resp = await fetch(proxyUrl);
                if (resp.ok) blob = await resp.blob();
            } catch { /* fall through */ }
        }

        if (!blob || blob.size === 0) {
            _unfetchable.add(driveId);
            return null;
        }

        // Save locally so future renders use the local copy
        const parts = relPath.split('/');
        const name  = parts.pop();
        await StorageAdapter.saveFile(blob, name, parts);

        const url = await StorageAdapter.getFileUrl(relPath);
        if (url) {
            console.log(`[ProjectFilesSync] Downloaded on-demand: ${relPath}`);
            return { url, source: 'local' };
        }
    } catch (e) {
        _unfetchable.add(driveId);
        console.warn(`[ProjectFilesSync] On-demand download failed "${relPath}":`, e.message);
    }

    return null;
}

// ---------------------------------------------------------------------------
// Push-only reconcile (no auto-pull)
// ---------------------------------------------------------------------------

/**
 * Push-side reconcile: queue any locally-present file that has no Drive ID yet
 * for upload. Called after conflict resolution or project switch so media that
 * exists locally but wasn't uploaded yet gets pushed.
 *
 * Pull is intentionally absent — media download is on-demand only (UI-driven).
 *
 * @param {object} project
 * @returns {Promise<void>}
 */
export async function reconcileProjectFiles(project) {
    if (!project) return;

    for (const ref of enumerateFileRefs(project)) {
        if (ref.driveId) continue;
        try {
            if (await StorageAdapter.checkFileExists(ref.relPath)) {
                EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: ref.relPath, isExternal: false });
            }
        } catch { /* ignore */ }
    }
}
