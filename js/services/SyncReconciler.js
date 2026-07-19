import * as DriveService from './DriveService.js';
import * as StorageAdapter from '../data/StorageAdapter.js';
import { enumerateFileRefs } from './ProjectFilesSync.js';
import { getProjectFolderName } from '../data/projectUtils.js';

export const SYNC = {
    SYNCED:   'synced',    // on Drive, recorded id matches
    ID_DRIFT: 'id_drift',  // on Drive but recorded id missing/wrong -> repair id, no upload
    STALE:    'stale',     // recorded id dead, local copy exists -> re-upload
    UNSYNCED: 'unsynced',  // no id, local exists, not on Drive -> upload
    MISSING:  'missing',   // not on Drive and not local -> unrecoverable here
    UNKNOWN:  'unknown',   // Drive unreachable, cannot verify
};

// For an imported project the shared media lives in the OWNER's folder, not the
// current user's own Drive root - list the source folder in that case.
async function _driveIndex(project) {
    const relToId = new Map();
    const byName = new Map();
    const liveIds = new Set();

    const sh = project.shared;
    const driveFiles = (sh?.isImported && sh?.sourceFolderId)
        ? await DriveService.listAllFilesInFolder(sh.sourceFolderId)
        : await DriveService.listAllDriveFiles();

    for (const f of driveFiles) {
        if (f.mimeType === 'application/vnd.google-apps.folder') continue;
        liveIds.add(f.id);
        const rp = DriveService.driveFileRelPath(f);
        if (rp) relToId.set(rp, f.id);
        if (f.name && !byName.has(f.name)) byName.set(f.name, f.id);
    }
    return { relToId, byName, liveIds };
}

// The recorded relPath uses the local folder name; on the owner's Drive the same
// file sits under the owner's folder name. Remap so path lookups line up.
function _drivePathFor(project, relPath) {
    const sh = project.shared;
    if (sh?.isImported && sh?.ownerFolderName) {
        const local = getProjectFolderName(project);
        if (local && local !== sh.ownerFolderName && relPath.startsWith(local + '/')) {
            return sh.ownerFolderName + relPath.substring(local.length);
        }
    }
    return relPath;
}

function _emptyCounts() {
    return { synced: 0, id_drift: 0, stale: 0, unsynced: 0, missing: 0, unknown: 0, total: 0 };
}

// Pure status decision from verified facts. Drive presence is `idOnDrive`
// (recorded id resolves to a live file) OR `pathOnDrive` (a file exists at the
// expected relPath). Kept separate from IO so it can be unit-tested directly.
export function classify({ driveOk, local, hasRecordedId, idOnDrive, pathOnDrive }) {
    if (!driveOk) return SYNC.UNKNOWN;
    if (idOnDrive || pathOnDrive) return idOnDrive ? SYNC.SYNCED : SYNC.ID_DRIFT;
    if (hasRecordedId) return local ? SYNC.STALE : SYNC.MISSING;
    return local ? SYNC.UNSYNCED : SYNC.MISSING;
}

// Cross-reference expected refs x live Drive contents x local presence into a
// per-file status report. Drive presence is verified, never trusted from the
// recorded id alone.
export async function buildSyncReport(project) {
    const refs = enumerateFileRefs(project);

    let index = null;
    let driveOk = true;
    try {
        index = await _driveIndex(project);
    } catch (e) {
        driveOk = false;
    }

    const counts = _emptyCounts();
    const rows = [];

    for (const ref of refs) {
        let local = false;
        try { local = await StorageAdapter.checkFileExists(ref.relPath); } catch { }

        const liveId = driveOk
            ? (index.relToId.get(_drivePathFor(project, ref.relPath))
                || index.byName.get(ref.relPath.split('/').pop())
                || null)
            : null;
        const idOnDrive = driveOk && !!ref.driveId && index.liveIds.has(ref.driveId);
        const pathOnDrive = liveId != null;
        const onDrive = idOnDrive || pathOnDrive;

        const status = classify({
            driveOk,
            local,
            hasRecordedId: !!ref.driveId,
            idOnDrive,
            pathOnDrive,
        });

        counts[status]++;
        counts.total++;
        rows.push({
            relPath: ref.relPath,
            name: ref.relPath.split('/').pop(),
            kind: ref.kind,
            context: ref.context || '',
            local,
            onDrive,
            driveId: ref.driveId || null,
            liveId,
            status,
        });
    }

    return { driveOk, counts, rows };
}
