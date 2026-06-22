import Config from '../core/Config.js';

const SOURCE_COOP_HOSTS = [
    'https://data.source.coop/tge-labs/aef',
    'https://us-west-2.opendata.source.coop/tge-labs/aef',
    'https://s3.us-west-2.amazonaws.com/us-west-2.opendata.source.coop/tge-labs/aef',
    'https://us-west-2.opendata.source.coop.s3.us-west-2.amazonaws.com/tge-labs/aef',
];
let _activeSourceBase = SOURCE_COOP_HOSTS[0];

const PALETTE = [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231',
    '#911eb4', '#42d4f4', '#f032e6', '#bfef45',
];

let _GeoTIFF = null;

async function ensureGeoTIFF() {
    if (_GeoTIFF) return _GeoTIFF;
    _GeoTIFF = await import(
        'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm'
    );
    return _GeoTIFF;
}

function cogUrl(rawUrl) {
    const proxy = Config.proxy?.workerUrl;
    if (!proxy) return rawUrl;
    return `${proxy}/cog?url=${encodeURIComponent(rawUrl)}`;
}

export async function parseKml(kmlFile) {
    const text = await kmlFile.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'application/xml');

    const coordEl = doc.querySelector('coordinates');
    if (!coordEl) throw new Error('No <coordinates> element found in KML.');

    const raw = coordEl.textContent.trim();
    const coords = raw.split(/\s+/).map(triple => {
        const [lon, lat] = triple.split(',').map(Number);
        return [lon, lat];
    }).filter(([lon, lat]) => !isNaN(lon) && !isNaN(lat));

    if (coords.length < 3) throw new Error('KML polygon has fewer than 3 valid coordinates.');

    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const [lon, lat] of coords) {
        if (lon < west)  west  = lon;
        if (lon > east)  east  = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
    }

    return { coords, bbox: { west, south, east, north } };
}

function getUtmZoneStr(lat, lon) {
    const zone = Math.floor((lon + 180) / 6) + 1;
    const hemi = lat >= 0 ? 'N' : 'S';
    return `${zone}${hemi}`;
}

function utmEpsg(zoneStr) {
    const num  = parseInt(zoneStr);
    const hemi = zoneStr.slice(-1);
    return hemi === 'N' ? 32600 + num : 32700 + num;
}

function wgs84ToUtm(lat, lon, zoneStr) {
    const zoneNum  = parseInt(zoneStr);
    const isNorth  = zoneStr.slice(-1) === 'N';
    const λ0       = ((zoneNum - 1) * 6 - 180 + 3) * Math.PI / 180;

    const a  = 6378137.0;
    const f  = 1 / 298.257223563;
    const b  = a * (1 - f);
    const e  = Math.sqrt(1 - (b * b) / (a * a));
    const e2 = e * e;
    const ep2 = e2 / (1 - e2);
    const k0 = 0.9996;

    const φ  = lat * Math.PI / 180;
    const λ  = lon * Math.PI / 180;

    const sinφ = Math.sin(φ), cosφ = Math.cos(φ), tanφ = Math.tan(φ);
    const N = a / Math.sqrt(1 - e2 * sinφ * sinφ);
    const T = tanφ * tanφ;
    const C = ep2 * cosφ * cosφ;
    const A = cosφ * (λ - λ0);

    const e4 = e2 * e2, e6 = e4 * e2;
    const M = a * (
        (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * φ
      - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * φ)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * φ)
      - (35 * e6 / 3072) * Math.sin(6 * φ)
    );

    const A2 = A * A, A3 = A2 * A, A4 = A3 * A, A5 = A4 * A, A6 = A5 * A;

    const easting = k0 * N * (
        A + (1 - T + C) * A3 / 6
          + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A5 / 120
    ) + 500000;

    let northing = k0 * (
        M + N * tanφ * (
            A2 / 2
          + (5 - T + 9 * C + 4 * C * C) * A4 / 24
          + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A6 / 720
        )
    );
    if (!isNorth) northing += 10000000;

    return { easting, northing };
}

function bboxToUtm(bbox, zoneStr) {
    const sw = wgs84ToUtm(bbox.south, bbox.west, zoneStr);
    const ne = wgs84ToUtm(bbox.north, bbox.east, zoneStr);
    return [
        Math.min(sw.easting,  ne.easting),
        Math.min(sw.northing, ne.northing),
        Math.max(sw.easting,  ne.easting),
        Math.max(sw.northing, ne.northing),
    ];
}

let _manifestCache = null;

const S3_AEF_PREFIX_RE = /^s3:\/\/[^/]+\/tge-labs\/aef\//;

function _normalizeManifestLines(lines) {
    return lines.map(l => l.replace(S3_AEF_PREFIX_RE, '')).filter(Boolean);
}

async function fetchManifest() {
    if (_manifestCache) return _manifestCache;

    const manifestSuffix = '/v1/annual/manifest.txt';
    let lastErr = null;

    for (const base of SOURCE_COOP_HOSTS) {
        const url = cogUrl(`${base}${manifestSuffix}`);
        try {
            const resp = await fetch(url);
            if (!resp.ok) { lastErr = new Error(`${base} → ${resp.status}`); continue; }
            const text = await resp.text();
            if (!text || text.length < 20) { lastErr = new Error(`${base} → empty`); continue; }
            _manifestCache = _normalizeManifestLines(
                text.trim().split('\n').map(l => l.trim())
            );
            _activeSourceBase = base;
            return _manifestCache;
        } catch (e) { lastErr = e; }
    }

    for (const base of SOURCE_COOP_HOSTS) {
        const url = `${base}${manifestSuffix}`;
        try {
            const resp = await fetch(url);
            if (!resp.ok) { lastErr = new Error(`direct ${base} → ${resp.status}`); continue; }
            const text = await resp.text();
            if (!text || text.length < 20) { lastErr = new Error(`direct ${base} → empty`); continue; }
            _manifestCache = _normalizeManifestLines(
                text.trim().split('\n').map(l => l.trim())
            );
            _activeSourceBase = base;
            return _manifestCache;
        } catch (e) { lastErr = e; }
    }

    throw new Error(`Failed to fetch AEF manifest from all hosts: ${lastErr?.message}`);
}

function _openCogWithTimeout(GeoTIFF, url, timeoutMs = 15000) {
    return Promise.race([
        (async () => {
            const tiff  = await GeoTIFF.fromUrl(url, { allowFullFile: false });
            const image = await tiff.getImage();
            return { tiff, image };
        })(),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), timeoutMs)
        ),
    ]);
}

async function _tryCandidate(GeoTIFF, relPath, baseUrl, centUtm) {
    const directUrl = `${baseUrl}/${relPath}`;
    const proxyUrl  = cogUrl(directUrl);
    const urls = proxyUrl !== directUrl ? [directUrl, proxyUrl] : [directUrl];

    for (const tryUrl of urls) {
        try {
            const { image } = await _openCogWithTimeout(GeoTIFF, tryUrl, 15000);
            const [xMin, yMin, xMax, yMax] = image.getBoundingBox();
            if (centUtm.easting  >= xMin && centUtm.easting  <= xMax &&
                centUtm.northing >= yMin && centUtm.northing <= yMax) {
                return { image, url: tryUrl };
            }
            return null;
        } catch (e) {
            console.warn(`[Stratification] COG fail: ${relPath} →`, e.message);
        }
    }
    return null;
}

async function findCog(bbox, year) {
    const GeoTIFF = await ensureGeoTIFF();
    const manifest = await fetchManifest();

    const centLat = (bbox.north + bbox.south) / 2;
    const centLon = (bbox.east  + bbox.west)  / 2;
    const zone    = getUtmZoneStr(centLat, centLon);
    const prefix  = `v1/annual/${year}/${zone}/`;

    const candidates = manifest.filter(p => p.includes(prefix) && p.endsWith('.tiff'));
    if (candidates.length === 0) {
        throw new Error(`No COG files found for year=${year}, zone=${zone}. Check if data is available.`);
    }

    const centUtm = wgs84ToUtm(centLat, centLon, zone);
    const directBase = 'https://data.source.coop/tge-labs/aef';

    const BATCH = 8;
    for (let i = 0; i < candidates.length; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH);

        const results = await Promise.allSettled(
            batch.map(rp => _tryCandidate(GeoTIFF, rp, directBase, centUtm))
        );

        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) {
                return { url: r.value.url, image: r.value.image, zone };
            }
        }
    }

    throw new Error(
        `No COG file covers the AOI centroid (${centLat.toFixed(4)}, ${centLon.toFixed(4)}) for year ${year}, zone ${zone}. ` +
        `Tried ${candidates.length} files.`
    );
}

async function readPixels(image, utmBbox, targetSize = 256) {
    const [imgW, imgS, imgE, imgN] = image.getBoundingBox();

    const west  = Math.max(utmBbox[0], imgW);
    const south = Math.max(utmBbox[1], imgS);
    const east  = Math.min(utmBbox[2], imgE);
    const north = Math.min(utmBbox[3], imgN);

    if (west >= east || south >= north) {
        throw new Error('AOI does not overlap the COG extent after clamping.');
    }

    const aspectRatio = (east - west) / (north - south);
    let outW, outH;
    if (aspectRatio >= 1) {
        outW = targetSize;
        outH = Math.max(1, Math.round(targetSize / aspectRatio));
    } else {
        outH = targetSize;
        outW = Math.max(1, Math.round(targetSize * aspectRatio));
    }

    const rasters = await image.readRasters({
        bbox: [west, south, east, north],
        width: outW,
        height: outH,
    });

    return { data: rasters, width: outW, height: outH };
}

function dequantize(bands, numPixels) {
    const numBands = bands.length;
    const result = new Float32Array(numPixels * numBands);

    for (let px = 0; px < numPixels; px++) {
        let isNoData = false;
        for (let b = 0; b < numBands; b++) {
            const raw = bands[b][px];
            if (raw === -128) { isNoData = true; break; }
            const norm = raw / 127.5;
            result[px * numBands + b] = norm * norm * Math.sign(raw);
        }
        if (isNoData) {
            for (let b = 0; b < numBands; b++) {
                result[px * numBands + b] = NaN;
            }
        }
    }
    return result;
}

function kMeans(data, numPixels, numDims, k, maxIter = 30) {
    const valid = [];
    for (let i = 0; i < numPixels; i++) {
        if (!isNaN(data[i * numDims])) valid.push(i);
    }
    if (valid.length < k) throw new Error(`Only ${valid.length} valid pixels — need at least ${k} for clustering.`);

    const centroids = new Float32Array(k * numDims);
    const chosen = new Set();

    const first = valid[Math.floor(Math.random() * valid.length)];
    chosen.add(first);
    centroids.set(data.subarray(first * numDims, first * numDims + numDims), 0);

    for (let c = 1; c < k; c++) {
        const dist = new Float32Array(valid.length);
        let distSum = 0;
        for (let vi = 0; vi < valid.length; vi++) {
            const px = valid[vi];
            let minD = Infinity;
            for (let cc = 0; cc < c; cc++) {
                let d = 0;
                for (let dim = 0; dim < numDims; dim++) {
                    const diff = data[px * numDims + dim] - centroids[cc * numDims + dim];
                    d += diff * diff;
                }
                if (d < minD) minD = d;
            }
            dist[vi] = minD;
            distSum += minD;
        }
        let r = Math.random() * distSum;
        let sel = valid[0];
        for (let vi = 0; vi < valid.length; vi++) {
            r -= dist[vi];
            if (r <= 0) { sel = valid[vi]; break; }
        }
        centroids.set(data.subarray(sel * numDims, sel * numDims + numDims), c * numDims);
    }

    const assignments = new Int32Array(numPixels).fill(-1);
    const counts      = new Int32Array(k);
    const sums        = new Float32Array(k * numDims);

    for (let iter = 0; iter < maxIter; iter++) {
        let changed = 0;
        for (const px of valid) {
            let bestK = 0, bestD = Infinity;
            for (let c = 0; c < k; c++) {
                let d = 0;
                for (let dim = 0; dim < numDims; dim++) {
                    const diff = data[px * numDims + dim] - centroids[c * numDims + dim];
                    d += diff * diff;
                }
                if (d < bestD) { bestD = d; bestK = c; }
            }
            if (assignments[px] !== bestK) { assignments[px] = bestK; changed++; }
        }
        if (changed === 0) break;

        counts.fill(0);
        sums.fill(0);
        for (const px of valid) {
            const c = assignments[px];
            counts[c]++;
            for (let dim = 0; dim < numDims; dim++) {
                sums[c * numDims + dim] += data[px * numDims + dim];
            }
        }
        for (let c = 0; c < k; c++) {
            if (counts[c] === 0) continue;
            for (let dim = 0; dim < numDims; dim++) {
                centroids[c * numDims + dim] = sums[c * numDims + dim] / counts[c];
            }
        }
    }

    return assignments;
}

function renderCanvas(assignments, width, height, k) {
    const canvas = document.createElement('canvas');
    canvas.width  = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);

    const rgb = PALETTE.slice(0, k).map(hex => {
        const n = parseInt(hex.slice(1), 16);
        return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    });

    for (let i = 0; i < width * height; i++) {
        const c = assignments[i];
        const off = i * 4;
        if (c < 0 || c >= k) {
            imgData.data[off] = imgData.data[off + 1] = imgData.data[off + 2] = 0;
            imgData.data[off + 3] = 0;
        } else {
            imgData.data[off]     = rgb[c][0];
            imgData.data[off + 1] = rgb[c][1];
            imgData.data[off + 2] = rgb[c][2];
            imgData.data[off + 3] = 180;
        }
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

export async function runStratification(kmlFile, maxClusters, year = 2024, onProgress) {
    const prog = (msg, pct) => { onProgress?.(msg, pct); };

    prog('Parsing KML...', 5);
    const { bbox } = await parseKml(kmlFile);

    prog('Loading satellite embeddings index...', 10);
    const { image, zone } = await findCog(bbox, year);

    const utmBbox = bboxToUtm(bbox, zone);
    prog('Reading satellite data...', 25);

    const VIS_SIZE     = 256;
    const SAMPLE_SIZE  = 64;
    const NUM_BANDS    = 64;

    const visRead    = await readPixels(image, utmBbox, VIS_SIZE);
    const sampleRead = await readPixels(image, utmBbox, SAMPLE_SIZE);
    prog('Processing embeddings...', 50);

    const visPx     = visRead.width  * visRead.height;
    const samplePx  = sampleRead.width * sampleRead.height;
    const visData    = dequantize(visRead.data, visPx);
    const sampleData = dequantize(sampleRead.data, samplePx);

    const leafletBounds = L.latLngBounds(
        [bbox.south, bbox.west],
        [bbox.north, bbox.east]
    );

    const results = [];
    for (let k = 2; k <= maxClusters; k++) {
        prog(`Clustering (k=${k})...`, 50 + ((k - 2) / (maxClusters - 1)) * 40);

        const sampleAssign = kMeans(sampleData, samplePx, NUM_BANDS, k);

        const centroids = new Float32Array(k * NUM_BANDS);
        const counts    = new Int32Array(k);
        for (let px = 0; px < samplePx; px++) {
            const c = sampleAssign[px];
            if (c < 0) continue;
            counts[c]++;
            for (let d = 0; d < NUM_BANDS; d++) {
                centroids[c * NUM_BANDS + d] += sampleData[px * NUM_BANDS + d];
            }
        }
        for (let c = 0; c < k; c++) {
            if (counts[c] === 0) continue;
            for (let d = 0; d < NUM_BANDS; d++) {
                centroids[c * NUM_BANDS + d] /= counts[c];
            }
        }

        const visAssign = new Int32Array(visPx).fill(-1);
        for (let px = 0; px < visPx; px++) {
            if (isNaN(visData[px * NUM_BANDS])) continue;
            let bestC = 0, bestD = Infinity;
            for (let c = 0; c < k; c++) {
                let d = 0;
                for (let dim = 0; dim < NUM_BANDS; dim++) {
                    const diff = visData[px * NUM_BANDS + dim] - centroids[c * NUM_BANDS + dim];
                    d += diff * diff;
                }
                if (d < bestD) { bestD = d; bestC = c; }
            }
            visAssign[px] = bestC;
        }

        const canvas = renderCanvas(visAssign, visRead.width, visRead.height, k);
        results.push({ k, canvas, bounds: leafletBounds });
    }

    prog('Done.', 100);
    return results;
}

export function createOverlay(result) {
    const dataUrl = result.canvas.toDataURL('image/png');
    return L.imageOverlay(dataUrl, result.bounds, { opacity: 0.7, interactive: false });
}
