import EventBus, { EVENTS } from '../core/EventBus.js';
import Config from '../core/Config.js';
import * as DriveService from './DriveService.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import * as MasterData from '../data/MasterData.js';
import { getProjectFolderName } from '../data/projectUtils.js';
import { getAccessToken } from './AuthService.js';
import { getAllJobs, getJobResultFiles } from '../data/Repository.js';
import { touch, isDeleted } from '../data/mergeUtils.js';

const _unfetchable = new Set();

export function enumerateFileRefs(project) {
    const refs = [];
    for (const s of (project.spots || [])) {
        if (isDeleted(s)) continue;
        const imgPaths = s.images && s.images.length > 0
            ? s.images
            : (s.image_local_filename ? [s.image_local_filename] : []);
        const imgDriveIds = s.image_drive_ids || [];
        for (let i = 0; i < imgPaths.length; i++) {
            refs.push({ relPath: imgPaths[i], driveId: imgDriveIds[i] || (i === 0 ? s.image_drive_id : null) || null, kind: 'image' });
        }
        if (s.audio_local_filename) refs.push({ relPath: s.audio_local_filename, driveId: s.audio_drive_id || null, kind: 'audio' });
    }
    for (const st of (project.sites || [])) {
        if (isDeleted(st)) continue;
        if (st.kml_filename) refs.push({ relPath: st.kml_filename, driveId: st.kml_drive_id || null, kind: 'kml' });
        for (const ov of (st.strat_overlays || [])) {
            if (ov.rel_path) refs.push({ relPath: ov.rel_path, driveId: ov.drive_id || null, kind: 'stratification' });
        }
    }
    for (const rt of (project.routes || [])) {
        if (isDeleted(rt)) continue;
        for (const a of (rt.annotations || [])) {
            if (isDeleted(a)) continue;
            if (a.image_local_filename) refs.push({ relPath: a.image_local_filename, driveId: a.image_drive_id || null, kind: 'image' });
            if (a.audio_local_filename) refs.push({ relPath: a.audio_local_filename, driveId: a.audio_drive_id || null, kind: 'audio' });
        }
    }
    for (const j of (project.jobs || [])) {
        if (isDeleted(j)) continue;
        if (j.job_file) refs.push({ relPath: j.job_file, driveId: j.job_file_drive_id || null, kind: 'job' });
        for (const rf of (j.result_files || [])) {
            if (isDeleted(rf)) continue;
            if (rf.rel_path) refs.push({ relPath: rf.rel_path, driveId: rf.drive_id || null, kind: 'result' });
        }
    }
    return refs;
}

export async function recordCompletedJobs(project) {
    if (!project) return 0;
    const folder = getProjectFolderName(project);

    let jobs;
    try { jobs = await getAllJobs(); } catch { return 0; }

    const known = new Set((project.jobs || []).map(j => j.job_id));

    const entries = [];
    for (const j of jobs) {
        if (j.current_status !== 'completed') continue;
        if (known.has(j.job_id)) continue;

        let resFiles = [];
        try { resFiles = await getJobResultFiles(j.job_id); } catch { resFiles = []; }

        entries.push(touch({
            id:                j.job_id,
            job_id:            j.job_id,
            job_name:          j.job_name || j.job_id,
            script_name:       j.script_name || null,
            status:            'completed',
            timestamp:         new Date().toISOString(),
            completed_at:      j.created_at || new Date().toISOString(),
            job_file:          `${folder}/jobs/completed/${j.job_id}.json`,
            job_file_drive_id: null,
            result_files:      resFiles.map(f => ({ id: f.path, name: f.name, rel_path: f.path, drive_id: null })),
        }));
    }

    if (entries.length === 0) return 0;

    const prevJobs = project.jobs;
    project.jobs = [...(project.jobs || []), ...entries];
    try {
        await MasterData.saveMasterData();
    } catch (err) {
        project.jobs = prevJobs;
        throw err;
    }
    EventBus.emit(EVENTS.DATA_UPDATED);

    for (const entry of entries) {
        EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: entry.job_file, isExternal: false });
        for (const rf of entry.result_files) {
            EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: rf.rel_path, isExternal: false });
        }
    }

    return entries.length;
}

export function getPublicUrl(fileId, kind = '') {
    if (kind === 'image') {
        return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;
    }
    const proxy = Config.proxy?.workerUrl;
    if (proxy) {
        return `${proxy}/drive?id=${fileId}`;
    }
    return `https://drive.usercontent.google.com/download?id=${fileId}&export=download`;
}

export async function downloadMediaFile(driveId, relPath, kind = '') {
    if (!driveId) return null;

    try {
        if (await StorageAdapter.checkFileExists(relPath)) {
            const url = await StorageAdapter.getFileUrl(relPath);
            if (url) return { url, source: 'local' };
        }
    } catch { }

    if (_unfetchable.has(driveId)) return null;

    try {
        let blob = await DriveService.fetchPublicBlob(driveId, kind);

        if ((!blob || blob.size === 0) && Config.proxy?.workerUrl) {
            try {
                const proxyUrl = `${Config.proxy.workerUrl}/drive?id=${driveId}`;
                const resp = await fetch(proxyUrl);
                if (resp.ok) blob = await resp.blob();
            } catch { }
        }

        if (!blob || blob.size === 0) {
            _unfetchable.add(driveId);
            return null;
        }

        const parts = relPath.split('/');
        const name  = parts.pop();
        await StorageAdapter.saveFile(blob, name, parts);

        const url = await StorageAdapter.getFileUrl(relPath);
        if (url) {
            return { url, source: 'local' };
        }
    } catch (e) {
        _unfetchable.add(driveId);
        console.warn(`[ProjectFilesSync] On-demand download failed "${relPath}":`, e.message);
    }

    return null;
}

export async function reconcileProjectFiles(project) {
    if (!project) return;

    for (const ref of enumerateFileRefs(project)) {
        if (ref.driveId) continue;
        try {
            if (await StorageAdapter.checkFileExists(ref.relPath)) {
                EventBus.emit(EVENTS.MEDIA_SAVED, { projectId: project.id, relPath: ref.relPath, isExternal: false });
            }
        } catch { }
    }
}
