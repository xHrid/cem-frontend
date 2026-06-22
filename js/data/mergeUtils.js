export function itemVersion(it) {
    return Math.max(
        new Date(it?.timestamp  || 0).getTime(),
        new Date(it?.updated_at || 0).getTime(),
    );
}

export function mergeById(left = [], right = []) {
    const map = new Map();
    for (const item of [...(left || []), ...(right || [])]) {
        const id = item.spotId || item.id || item.job_id;
        if (!id) continue;
        const prev = map.get(id);
        if (!prev || itemVersion(item) > itemVersion(prev)) map.set(id, item);
    }
    return Array.from(map.values());
}
