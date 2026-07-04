export function itemId(it) {
    return it?.spotId || it?.id || it?.job_id || null;
}

export function itemRev(it) {
    const rev = Number(it?.rev);
    return Number.isFinite(rev) && rev > 0 ? rev : 0;
}

export function itemTime(it) {
    return Math.max(
        new Date(it?.timestamp  || 0).getTime() || 0,
        new Date(it?.updated_at || 0).getTime() || 0,
    );
}

export function isDeleted(it) {
    return it?.deleted === true;
}

// Lamport ordering: rev is the primary comparator, wall-clock only breaks
// ties between genuinely concurrent writes. On a full tie a tombstone wins.
export function compareVersions(a, b) {
    const dr = itemRev(a) - itemRev(b);
    if (dr) return dr;
    const dt = itemTime(a) - itemTime(b);
    if (dt) return dt;
    if (isDeleted(a) !== isDeleted(b)) return isDeleted(a) ? 1 : -1;
    return 0;
}

// Stamp a local mutation. rev becomes max(seen)+1 because merges store max.
export function touch(item) {
    item.rev = itemRev(item) + 1;
    item.updated_at = new Date().toISOString();
    return item;
}

// A delete is a rev bump plus deleted=true. Media/payload fields are stripped
// so the files stop being referenced and GC may reclaim them.
export function tombstone(item) {
    const t = {
        deleted    : true,
        rev        : itemRev(item) + 1,
        updated_at : new Date().toISOString(),
    };
    if (item.spotId    != null) t.spotId    = item.spotId;
    if (item.id        != null) t.id        = item.id;
    if (item.job_id    != null) t.job_id    = item.job_id;
    if (item.projectId != null) t.projectId = item.projectId;
    if (item.timestamp != null) t.timestamp = item.timestamp;
    return t;
}

function _isIdArray(arr) {
    return arr.length > 0 && arr.every(x => x && typeof x === 'object' && itemId(x));
}

// spot.images is a string array paired positionally with spot.image_drive_ids.
// Merge them as one path→driveId map so ids never slip against paths.
function _mergeImagePairs(winner, loser, merged) {
    const pairs = new Map();
    for (const side of [winner, loser]) {
        const paths = Array.isArray(side.images) && side.images.length > 0
            ? side.images
            : (side.image_local_filename ? [side.image_local_filename] : []);
        const ids = Array.isArray(side.image_drive_ids) ? side.image_drive_ids : [];
        paths.forEach((p, i) => {
            const id = ids[i] || (i === 0 ? side.image_drive_id : null) || null;
            if (!pairs.has(p) || id) pairs.set(p, id || pairs.get(p) || null);
        });
    }
    const paths = [...pairs.keys()];
    merged.images               = paths.length > 0 ? paths : null;
    merged.image_drive_ids      = paths.length > 0 ? paths.map(p => pairs.get(p)) : undefined;
    merged.image_local_filename = paths[0] || null;
    merged.image_drive_id       = (paths[0] && pairs.get(paths[0])) || null;
    if (merged.image_drive_ids === undefined) delete merged.image_drive_ids;
}

// Field/child-level merge of two versions of the same item. Winner (by
// compareVersions) supplies conflicting scalars; loser-only fields survive.
// Child arrays of id-carrying objects merge recursively with tombstones, so
// concurrent annotation/result_file edits both survive.
export function mergeItems(a, b) {
    if (!a) return b;
    if (!b) return a;

    const [winner, loser] = compareVersions(a, b) >= 0 ? [a, b] : [b, a];
    const rev = Math.max(itemRev(a), itemRev(b));

    if (isDeleted(winner)) return { ...winner, rev };
    if (isDeleted(loser))  return { ...winner, rev };

    const merged = { ...loser, ...winner, rev };

    for (const key of Object.keys(merged)) {
        const av = a[key];
        const bv = b[key];
        if (!Array.isArray(av) || !Array.isArray(bv) || av === bv) continue;
        if (_isIdArray(av) || _isIdArray(bv)) {
            merged[key] = mergeById(av, bv);
        }
    }

    if (Array.isArray(a.images) || Array.isArray(b.images) ||
        a.image_local_filename || b.image_local_filename) {
        _mergeImagePairs(winner, loser, merged);
    }

    return merged;
}

// Merge two replicas of an item array. Tombstones are kept (highest rev wins),
// so a delete on one replica is never resurrected by a stale copy on another.
export function mergeById(left = [], right = []) {
    const map = new Map();
    for (const item of [...(left || []), ...(right || [])]) {
        const id = itemId(item);
        if (!id) continue;
        const prev = map.get(id);
        map.set(id, prev ? mergeItems(prev, item) : item);
    }
    return Array.from(map.values());
}

export function mergeMasterData(local, remote) {
    return {
        currentProjectId : local.currentProjectId,
        projects         : mergeById(local.projects, remote.projects),
        metadata         : {
            ...(remote.metadata || {}),
            ...(local.metadata || {}),
            last_merged    : new Date().toISOString(),
            schema_version : 2,
        },
    };
}
