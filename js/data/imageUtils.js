const MAX_EDGE = 4096;

const JPEG_QUALITY = 0.92;

export async function downscaleImage(file, maxEdge = MAX_EDGE, quality = JPEG_QUALITY) {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;
    if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;

    try {
        const bitmap = await _decode(file);
        const { width, height } = bitmap;
        const longest = Math.max(width, height);

        if (longest <= maxEdge) {
            _close(bitmap);
            return file;
        }

        const scale = maxEdge / longest;
        const w = Math.round(width * scale);
        const h = Math.round(height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { _close(bitmap); return file; }
        ctx.drawImage(bitmap, 0, 0, w, h);
        _close(bitmap);

        const blob = await new Promise((resolve) =>
            canvas.toBlob(resolve, 'image/jpeg', quality)
        );

        if (blob && blob.size > 0 && blob.size < file.size) return blob;
        return file;
    } catch (e) {
        console.warn('[imageUtils] downscale failed, keeping original:', e.message);
        return file;
    }
}

async function _decode(file) {
    if (typeof createImageBitmap === 'function') {
        return await createImageBitmap(file);
    }
    return await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
        img.src = url;
    });
}

function _close(bitmap) {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
}
