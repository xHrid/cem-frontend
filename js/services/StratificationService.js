/**
 * StratificationService.js — Browser-side KML stratification using
 * AlphaEarth Foundations satellite embeddings (COGs on AWS S3).
 *
 * Pipeline:
 *   KML file → WGS84 polygon/bbox → UTM zone → find COG via manifest
 *   → geotiff.js partial read (HTTP range requests) → de-quantize 64-band
 *   embeddings → K-means clustering → classified canvas → Leaflet overlay
 *
 * Zero backend, zero GEE auth. Data is CC-BY 4.0 from Source Cooperative.
 *
 * Attribution: "The AlphaEarth Foundations Satellite Embedding dataset is
 * produced by Google and Google DeepMind."
 */

import Config from '../core/Config.js';
import { showToast } from '../ui/Toast.js';

// ---------------------------------------------------------------------------
// §1  Configuration
// ---------------------------------------------------------------------------

/**
 * Source Cooperative base URL (AWS S3 — free, no auth).
 * COG paths: {BASE}/satellite_embedding/v1/annual/{year}/{zone}/filename.tiff
 * Manifest:  {BASE}/satellite_embedding/v1/annual/manifest.txt
 */
const SOURCE_COOP_BASE = 'https://data.source.coop/tge-labs/aef';
const MANIFEST_PATH    = `${SOURCE_COOP_BASE}/satellite_embedding/v1/annual/manifest.txt`;

/** Cluster visualization palette (hex, up to 8 clusters). */
const PALETTE = [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231',
    '#911eb4', '#42d4f4', '#f032e6', '#bfef45',
];

// ---------------------------------------------------------------------------
// §2  Lazy CDN imports
// ---------------------------------------------------------------------------

let _GeoTIFF = null;

/**
 * Dynamically import geotiff.js from CDN on first use.
 * @returns {Promise<object>}
 */
async function ensureGeoTIFF() {
    if (_GeoTIFF) return _GeoTIFF;
    _GeoTIFF = await import(
        'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-module/geotiff.js'
    );
    return _GeoTIFF;
}

// ---------------------------------------------------------------------------
// §3  URL helpers — proxy-aware
// ---------------------------------------------------------------------------

/**
 * Wrap a remote URL through the Cloudflare Worker proxy when configured,
 * so browser fetch has CORS headers.  Falls back to direct URL if no proxy.
 */
function cogUrl(rawUrl) {
    const proxy = Config.proxy?.workerUrl;
    if (!proxy) return rawUrl;
    return `${proxy}/cog?url=${encodeURIComponent(rawUrl)}`;
}

// ---------------------------------------------------------------------------
// §4  KML parsing
// ---------------------------------------------------------------------------

/**
 * Parse a KML file and extract the first polygon's WGS84 coordinates + bbox.
 *
 * @param {File|Blob} kmlFile
 * @returns {Promise<{coords: Array<[number,number]>, bbox: {west:number, south:number, east:number, north:number}}>}
 */
export async function parseKml(kmlFile) {
    const text = await kmlFile.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'application/xml');

    // Find the first <coordinates> element (works for Polygon, LineString, etc.)
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

// ---------------------------------------------------------------------------
// §5  UTM utilities
// ---------------------------------------------------------------------------

/**
 * Determine the UTM zone string (e.g. "10N", "37S") from a WGS84 point.
 */
function getUtmZoneStr(lat, lon) {
    const zone = Math.floor((lon + 180) / 6) + 1;
    const hemi = lat >= 0 ? 'N' : 'S';
    return `${zone}${hemi}`;
}

/**
 * Get the EPSG code for a UTM zone string.
 */
function utmEpsg(zoneStr) {
    const num  = parseInt(zoneStr);
    const hemi = zoneStr.slice(-1);
    return hemi === 'N' ? 32600 + num : 32700 + num;
}

/**
 * Forward-project a WGS84 (lat, lon) point to UTM (easting, northing).
 *
 * Uses the standard Transverse Mercator formulas with WGS84 ellipsoid.
 *
 * @param {number} lat  Latitude in degrees
 * @param {number} lon  Longitude in degrees
 * @param {string} zoneStr  e.g. "10N"
 * @returns {{easting: number, northing: number}}
 */
function wgs84ToUtm(lat, lon, zoneStr) {
    const zoneNum  = parseInt(zoneStr);
    const isNorth  = zoneStr.slice(-1) === 'N';
    const λ0       = ((zoneNum - 1) * 6 - 180 + 3) * Math.PI / 180; // central meridian

    const a  = 6378137.0;
    const f  = 1 / 298.257223563;
    const b  = a * (1 - f);
    const e  = Math.sqrt(1 - (b * b) / (a * a));
    const e2 = e * e;
    const ep2 = e2 / (1 - e2);           // e'^2
    const k0 = 0.9996;

    const φ  = lat * Math.PI / 180;
    const λ  = lon * Math.PI / 180;

    const sinφ = Math.sin(φ), cosφ = Math.cos(φ), tanφ = Math.tan(φ);
    const N = a / Math.sqrt(1 - e2 * sinφ * sinφ);
    const T = tanφ * tanφ;
    const C = ep2 * cosφ * cosφ;
    const A = cosφ * (λ - λ0);

    // Meridional arc length (series expansion)
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

/**
 * Convert a WGS84 bbox to UTM coordinates for a given zone.
 */
function bboxToUtm(bbox, zoneStr) {
    const sw = wgs84ToUtm(bbox.south, bbox.west, zoneStr);
    const ne = wgs84ToUtm(bbox.north, bbox.east, zoneStr);
    return [
        Math.min(sw.easting,  ne.easting),   // west
        Math.min(sw.northing, ne.northing),   // south
        Math.max(sw.easting,  ne.easting),    // east
        Math.max(sw.northing, ne.northing),   // north
    ];
}

// ---------------------------------------------------------------------------
// §6  Manifest & COG discovery
// ---------------------------------------------------------------------------

let _manifestCache = null;

/**
 * Fetch the AEF manifest.txt (list of all COG file paths), cache it.
 * @returns {Promise<string[]>}  Array of relative paths.
 */
async function fetchManifest() {
    if (_manifestCache) return _manifestCache;

    const url = cogUrl(MANIFEST_PATH);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch AEF manifest: ${resp.status}`);
    const text = await resp.text();

    _manifestCache = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
    console.log(`[Stratification] Manifest loaded: ${_manifestCache.length} files.`);
    return _manifestCache;
}

/**
 * Find the COG file whose geographic extent contains the given WGS84 bbox.
 *
 * Strategy:
 *   1. Filter manifest to year + zone (usually 2-4 files).
 *   2. For each candidate, fetch just the GeoTIFF header (~4 KB range request)
 *      to read its native bounding box.
 *   3. Return the first file whose extent contains our AOI centroid.
 *
 * @param {{west,south,east,north}} bbox  WGS84
 * @param {number} year
 * @returns {Promise<{url: string, image: object, utmBbox: number[]}>}
 */
async function findCog(bbox, year) {
    const GeoTIFF = await ensureGeoTIFF();
    const manifest = await fetchManifest();

    const centLat = (bbox.north + bbox.south) / 2;
    const centLon = (bbox.east  + bbox.west)  / 2;
    const zone    = getUtmZoneStr(centLat, centLon);
    const prefix  = `satellite_embedding/v1/annual/${year}/${zone}/`;

    const candidates = manifest.filter(p => p.includes(prefix));
    if (candidates.length === 0) {
        throw new Error(`No COG files found for year=${year}, zone=${zone}. Check if data is available.`);
    }

    // Convert AOI centroid to UTM for containment check
    const centUtm = wgs84ToUtm(centLat, centLon, zone);

    for (const relPath of candidates) {
        const fileUrl = cogUrl(`${SOURCE_COOP_BASE}/${relPath}`);
        try {
            const tiff  = await GeoTIFF.fromUrl(fileUrl, { allowFullFile: false });
            const image = await tiff.getImage();
            const [xMin, yMin, xMax, yMax] = image.getBoundingBox();

            if (centUtm.easting  >= xMin && centUtm.easting  <= xMax &&
                centUtm.northing >= yMin && centUtm.northing <= yMax) {
                console.log(`[Stratification] COG match: ${relPath}`);
                return { url: fileUrl, image, zone };
            }
        } catch (e) {
            console.warn(`[Stratification] Skipping ${relPath}:`, e.message);
        }
    }
    throw new Error(`No COG file covers the AOI centroid (${centLat.toFixed(4)}, ${centLon.toFixed(4)}) for year ${year}.`);
}

// ---------------------------------------------------------------------------
// §7  Pixel reading
// ---------------------------------------------------------------------------

/**
 * Read all 64 embedding bands for the AOI from a COG.
 *
 * Uses geotiff.js readRasters with bbox option — automatically selects the
 * best overview level for the requested output size.
 *
 * @param {object} image   GeoTIFF image object
 * @param {number[]} utmBbox  [west, south, east, north] in UTM
 * @param {number} targetSize  Output dimension (square). Controls resolution.
 * @returns {Promise<{data: Float32Array[], width: number, height: number}>}
 *          data[bandIdx] is a Float32Array of width*height pixels.
 */
async function readPixels(image, utmBbox, targetSize = 256) {
    const [imgW, imgS, imgE, imgN] = image.getBoundingBox();

    // Clamp AOI to image extent
    const west  = Math.max(utmBbox[0], imgW);
    const south = Math.max(utmBbox[1], imgS);
    const east  = Math.min(utmBbox[2], imgE);
    const north = Math.min(utmBbox[3], imgN);

    if (west >= east || south >= north) {
        throw new Error('AOI does not overlap the COG extent after clamping.');
    }

    // Compute aspect ratio for output dimensions
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

    // rasters is an array of TypedArrays, one per band (64 bands)
    return { data: rasters, width: outW, height: outH };
}

// ---------------------------------------------------------------------------
// §8  De-quantization
// ---------------------------------------------------------------------------

/**
 * De-quantize raw int8 embedding values to float32 in [-1, 1].
 *
 * Formula (from Google's spec):
 *   dequantized = (value / 127.5)² × sign(value)
 *
 * @param {TypedArray[]} bands  Array of 64 TypedArrays (int8 pixel values).
 * @param {number} numPixels    Total pixels per band.
 * @returns {Float32Array}      Interleaved: [px0_b0, px0_b1, ..., px0_b63, px1_b0, ...]
 */
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
            // Fill nodata pixel with NaN so K-means skips it
            for (let b = 0; b < numBands; b++) {
                result[px * numBands + b] = NaN;
            }
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// §9  K-means clustering
// ---------------------------------------------------------------------------

/**
 * K-means clustering on N-dimensional data.
 *
 * @param {Float32Array} data  Interleaved: numPixels × numDims
 * @param {number} numPixels
 * @param {number} numDims     (64 for embeddings)
 * @param {number} k           Number of clusters
 * @param {number} [maxIter=30]
 * @returns {Int32Array}  Cluster assignment per pixel (0..k-1), -1 for nodata.
 */
function kMeans(data, numPixels, numDims, k, maxIter = 30) {
    // Collect valid (non-NaN) pixel indices
    const valid = [];
    for (let i = 0; i < numPixels; i++) {
        if (!isNaN(data[i * numDims])) valid.push(i);
    }
    if (valid.length < k) throw new Error(`Only ${valid.length} valid pixels — need at least ${k} for clustering.`);

    // Initialize centroids via k-means++ seeding
    const centroids = new Float32Array(k * numDims);
    const chosen = new Set();

    // First centroid: random valid pixel
    const first = valid[Math.floor(Math.random() * valid.length)];
    chosen.add(first);
    centroids.set(data.subarray(first * numDims, first * numDims + numDims), 0);

    // Remaining centroids: proportional to squared distance from nearest centroid
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
        // Weighted random selection
        let r = Math.random() * distSum;
        let sel = valid[0];
        for (let vi = 0; vi < valid.length; vi++) {
            r -= dist[vi];
            if (r <= 0) { sel = valid[vi]; break; }
        }
        centroids.set(data.subarray(sel * numDims, sel * numDims + numDims), c * numDims);
    }

    // Iterate
    const assignments = new Int32Array(numPixels).fill(-1);
    const counts      = new Int32Array(k);
    const sums        = new Float32Array(k * numDims);

    for (let iter = 0; iter < maxIter; iter++) {
        // Assign
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

        // Update centroids
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

// ---------------------------------------------------------------------------
// §10  Rendering
// ---------------------------------------------------------------------------

/**
 * Paint classified pixels onto a canvas.
 *
 * @param {Int32Array} assignments  Per-pixel cluster (0..k-1, -1 = nodata)
 * @param {number} width
 * @param {number} height
 * @param {number} k
 * @returns {HTMLCanvasElement}
 */
function renderCanvas(assignments, width, height, k) {
    const canvas = document.createElement('canvas');
    canvas.width  = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);

    // Parse palette hex → rgb
    const rgb = PALETTE.slice(0, k).map(hex => {
        const n = parseInt(hex.slice(1), 16);
        return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    });

    for (let i = 0; i < width * height; i++) {
        const c = assignments[i];
        const off = i * 4;
        if (c < 0 || c >= k) {
            // Transparent for nodata
            imgData.data[off] = imgData.data[off + 1] = imgData.data[off + 2] = 0;
            imgData.data[off + 3] = 0;
        } else {
            imgData.data[off]     = rgb[c][0];
            imgData.data[off + 1] = rgb[c][1];
            imgData.data[off + 2] = rgb[c][2];
            imgData.data[off + 3] = 180; // semi-transparent
        }
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

// ---------------------------------------------------------------------------
// §11  Main entry point
// ---------------------------------------------------------------------------

/**
 * Run full stratification pipeline.
 *
 * @param {File|Blob} kmlFile       KML file with site boundary
 * @param {number}    maxClusters   Generate results for k=2..maxClusters
 * @param {number}    [year=2024]
 * @param {function}  [onProgress]  Called with (message, pct)
 * @returns {Promise<Array<{k: number, canvas: HTMLCanvasElement, bounds: L.LatLngBounds}>>}
 */
export async function runStratification(kmlFile, maxClusters, year = 2024, onProgress) {
    const prog = (msg, pct) => { onProgress?.(msg, pct); console.log(`[Stratification] ${msg}`); };

    // Step 1: Parse KML
    prog('Parsing KML...', 5);
    const { bbox } = await parseKml(kmlFile);

    // Step 2: Find the right COG
    prog('Loading satellite embeddings index...', 10);
    const { image, zone } = await findCog(bbox, year);

    // Step 3: Convert bbox to UTM
    const utmBbox = bboxToUtm(bbox, zone);
    prog('Reading satellite data...', 25);

    // Step 4: Read pixels — higher res for classification, lower for training
    const VIS_SIZE     = 256;
    const SAMPLE_SIZE  = 64;
    const NUM_BANDS    = 64;

    const visRead    = await readPixels(image, utmBbox, VIS_SIZE);
    const sampleRead = await readPixels(image, utmBbox, SAMPLE_SIZE);
    prog('Processing embeddings...', 50);

    // Step 5: De-quantize
    const visPx     = visRead.width  * visRead.height;
    const samplePx  = sampleRead.width * sampleRead.height;
    const visData    = dequantize(visRead.data, visPx);
    const sampleData = dequantize(sampleRead.data, samplePx);

    // Step 6: Cluster for each k, classify the full-res data
    const leafletBounds = L.latLngBounds(
        [bbox.south, bbox.west],
        [bbox.north, bbox.east]
    );

    const results = [];
    for (let k = 2; k <= maxClusters; k++) {
        prog(`Clustering (k=${k})...`, 50 + ((k - 2) / (maxClusters - 1)) * 40);

        // Train K-means on the sample
        const sampleAssign = kMeans(sampleData, samplePx, NUM_BANDS, k);

        // Extract trained centroids from sample assignments
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

        // Classify every vis-resolution pixel using nearest centroid
        const visAssign = new Int32Array(visPx).fill(-1);
        for (let px = 0; px < visPx; px++) {
            if (isNaN(visData[px * NUM_BANDS])) continue; // nodata
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

        // Render canvas
        const canvas = renderCanvas(visAssign, visRead.width, visRead.height, k);
        results.push({ k, canvas, bounds: leafletBounds });
    }

    prog('Done.', 100);
    return results;
}

/**
 * Create a Leaflet ImageOverlay from a stratification result.
 *
 * @param {{canvas: HTMLCanvasElement, bounds: L.LatLngBounds}} result
 * @returns {L.ImageOverlay}
 */
export function createOverlay(result) {
    const dataUrl = result.canvas.toDataURL('image/png');
    return L.imageOverlay(dataUrl, result.bounds, { opacity: 0.7, interactive: false });
}
