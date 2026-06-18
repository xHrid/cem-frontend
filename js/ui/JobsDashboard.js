/**
 * JobsDashboard.js — Analysis jobs viewer
 *
 * Pattern : Module Pattern
 *           Private state (cached DOM refs) is never exposed; only the public
 *           initJobsDashboard() entry point is exported.
 *
 * Extracted from analysis.js lines 420-596, which contained DOM-querying
 * module-level code that ran at script parse time (before DOMContentLoaded).
 *
 * Bug fixes over analysis.js
 * --------------------------
 *  1. All DOM element references are now resolved LAZILY inside openJobsModal()
 *     rather than at module parse time, where most elements do not yet exist.
 *  2. Error messages use showToast() instead of relying on a bare try/catch
 *     that left the sidebar in a broken state silently.
 *
 * Dependencies
 * ------------
 *   Repository  — ../data/Repository.js  (getAllJobs, getJobResultFiles, getLocalFileUrl)
 *   showToast   — ./Toast.js
 */

import {
    getAllJobs,
    getJobResultFiles,
    getLocalFileUrl,
    deleteJob,
}               from '../data/Repository.js';
import { showToast } from './Toast.js';
import { openModal, closeModal } from './ModalManager.js';
import { getActiveProject } from '../data/MasterData.js';
import { revokeObjectUrls } from '../data/StorageAdapter.js';
import { recordCompletedJobs, downloadMediaFile, getPublicUrl } from '../services/ProjectFilesSync.js';

// ---------------------------------------------------------------------------
// Module-private state — DOM element cache (lazy)
// ---------------------------------------------------------------------------

/**
 * Lazily resolved DOM element references.
 * All null until _cacheElements() is called on first openJobsModal().
 */
const els = {
    popup              : null,
    listSidebar        : null,
    viewerContent      : null,
    viewerPlaceholder  : null,
    viewerFileName     : null,
    viewerStatus       : null,
    viewerId           : null,
    viewerFileList     : null,
    viewerPreview      : null,
};

let _elsCached = false;

// ---------------------------------------------------------------------------
// DOM element cache — lazy init
// ---------------------------------------------------------------------------

/**
 * Populate the `els` cache from the live DOM.
 * Called on first modal open, when the HTML is guaranteed to be present.
 * @private
 */
function _cacheElements() {
    if (_elsCached) return;

    els.popup             = document.getElementById('jobs-popup');
    els.listSidebar       = document.getElementById('jobs-list-sidebar');
    els.viewerContent     = document.getElementById('job-viewer-content');
    els.viewerPlaceholder = document.getElementById('job-viewer-placeholder');
    els.viewerFileName    = document.getElementById('viewer-job-name');
    els.viewerStatus      = document.getElementById('viewer-job-status');
    els.viewerId          = document.getElementById('viewer-job-id');
    els.viewerFileList    = document.getElementById('viewer-file-list');
    els.viewerPreview     = document.getElementById('viewer-preview-area');

    _elsCached = true;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Wire up the jobs button, close button, and refresh button.
 * Must be called once after DOMContentLoaded.
 */
export function initJobsDashboard() {
    // Open trigger — click on the nav button
    const jobsBtn = document.getElementById('jobs-btn');
    if (jobsBtn) {
        jobsBtn.addEventListener('click', openJobsModal);
    }

    // Close button — using event delegation so it works even if the popup is
    // rendered after initJobsDashboard() is called.
    document.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'close-jobs-btn') {
            closeModal('jobs-popup');
            // Release Object URLs created by file previews in this dashboard.
            revokeObjectUrls();
        }

        if (e.target && e.target.id === 'refresh-jobs-btn') {
            _loadJobsSidebar();
        }
    });
}

// ---------------------------------------------------------------------------
// Modal lifecycle
// ---------------------------------------------------------------------------

/**
 * Open the jobs popup and load the job list sidebar.
 */
export async function openJobsModal() {
    _cacheElements();

    openModal('jobs-popup');
    if (els.viewerPlaceholder) els.viewerPlaceholder.style.display = 'block';
    if (els.viewerContent)     els.viewerContent.style.display     = 'none';

    // Fold any newly-completed jobs into the project (queues their results for
    // upload + share when shared). Pull is on-demand — no materializeProjectFiles.
    try {
        const active = getActiveProject();
        if (active) {
            await recordCompletedJobs(active);
        }
    } catch (e) {
        console.warn('[JobsDashboard] job/result sync skipped:', e.message);
    }

    await _loadJobsSidebar();
}

// ---------------------------------------------------------------------------
// Sidebar — job list
// ---------------------------------------------------------------------------

/**
 * Fetch all jobs (all statuses) and render them as clickable sidebar items.
 * Jobs are sorted newest-first by the Repository layer.
 *
 * @private
 */
async function _loadJobsSidebar() {
    if (!els.listSidebar) return;

    els.listSidebar.innerHTML = "<p style='padding:15px; color:var(--text-muted);'>Loading jobs...</p>";

    try {
        const jobs = await getAllJobs();
        els.listSidebar.innerHTML = '';

        if (jobs.length === 0) {
            els.listSidebar.innerHTML = "<p style='padding:15px; color:var(--text-muted);'>No jobs found.</p>";
            return;
        }

        jobs.forEach(job => {
            const div       = document.createElement('div');
            div.className   = 'job-row';

            // Colour-code by status
            const color = _statusColor(job.current_status);

            div.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-dark); flex:1;">
                        ${job.job_name || 'Unnamed Job'}
                    </div>
                    <button class="delete-job-btn" title="Delete job" style="background:none; border:none; color:var(--danger-red); cursor:pointer; font-size:1rem; padding:2px 6px;">🗑</button>
                </div>
                <div style="display:flex; justify-content:space-between; font-size:0.78rem; color:var(--text-muted); margin-top:6px;">
                    <span style="color:${color}; font-weight:700; letter-spacing:0.04em;">${job.current_status.toUpperCase()}</span>
                    <span style="font-family:var(--font-mono);">${new Date(job.created_at).toLocaleDateString()}</span>
                </div>
            `;

            // Delete handler (stop propagation so it doesn't trigger job detail view)
            div.querySelector('.delete-job-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`Delete job "${job.job_name || 'Unnamed Job'}"?`)) return;
                try {
                    await deleteJob(job.job_id, job.current_status);
                    showToast('Job deleted.', 'success');
                    div.remove();
                    // Reset detail panel
                    if (els.viewerPlaceholder) els.viewerPlaceholder.style.display = 'block';
                    if (els.viewerContent) els.viewerContent.style.display = 'none';
                } catch (err) {
                    showToast(`Delete failed: ${err.message}`, 'failed');
                }
            });

            div.addEventListener('click', () => {
                els.listSidebar.querySelectorAll('.job-row.active').forEach(r => r.classList.remove('active'));
                div.classList.add('active');
                _renderJobDetails(job, color);
            });
            els.listSidebar.appendChild(div);
        });

    } catch (e) {
        els.listSidebar.innerHTML = `<p style="color:#dc3545; padding:15px;">Failed to load jobs.</p>`;
        showToast(`Failed to load jobs: ${e.message}`, 'failed');
    }
}

// ---------------------------------------------------------------------------
// Job detail panel
// ---------------------------------------------------------------------------

/**
 * Show the right-hand detail panel for a selected job.
 *
 * @param {object} job          Job descriptor from Repository.getAllJobs().
 * @param {string} statusColor  Hex / named colour for the status label.
 * @private
 */
async function _renderJobDetails(job, statusColor) {
    if (!els.viewerContent || !els.viewerPlaceholder) return;

    els.viewerPlaceholder.style.display = 'none';
    els.viewerContent.style.display     = 'block';

    if (els.viewerPreview) {
        els.viewerPreview.innerHTML = "<p style='color:var(--text-muted); text-align:center;'>Select a file to preview</p>";
    }

    if (els.viewerFileName) els.viewerFileName.textContent  = job.job_name || 'Unnamed Job';
    if (els.viewerStatus)   {
        els.viewerStatus.textContent = job.current_status.toUpperCase();
        els.viewerStatus.style.color = statusColor;
    }
    if (els.viewerId)       els.viewerId.textContent = `ID: ${job.job_id}`;

    if (!els.viewerFileList) return;

    els.viewerFileList.innerHTML = "<span style='color:var(--text-muted);'>Loading output files...</span>";

    if (job.current_status === 'completed' || job.current_status === 'failed') {
        // Local result files on disk
        const localFiles = await getJobResultFiles(job.job_id);

        // Merge with project-level job records (which carry drive_id for shared files)
        const project  = getActiveProject();
        const projJob  = (project?.jobs || []).find(j => j.job_id === job.job_id);
        const driveMap = new Map(); // rel_path → drive_id
        for (const rf of (projJob?.result_files || [])) {
            if (rf.rel_path && rf.drive_id) driveMap.set(rf.rel_path, rf.drive_id);
        }

        // Enrich local files with drive_id; add Drive-only files not on disk
        const enriched = localFiles.map(f => ({
            ...f,
            drive_id: driveMap.get(f.path) || null
        }));
        const localPaths = new Set(localFiles.map(f => f.path));
        for (const rf of (projJob?.result_files || [])) {
            if (rf.rel_path && !localPaths.has(rf.rel_path)) {
                enriched.push({ name: rf.name || rf.rel_path.split('/').pop(), path: rf.rel_path, drive_id: rf.drive_id || null });
            }
        }

        els.viewerFileList.innerHTML = '';

        if (enriched.length === 0) {
            els.viewerFileList.innerHTML = "<span style='color:var(--text-muted);'>No output files found.</span>";
            return;
        }

        enriched.forEach(file => {
            const btn       = document.createElement('button');
            btn.textContent = file.name;
            btn.className   = 'job-file-chip';

            // Colour-code border by file type
            if (file.name.endsWith('.csv'))                               btn.style.borderColor = '#3f8f4f';
            if (file.name.endsWith('.log'))                               btn.style.borderColor = 'var(--danger-red)';
            if (file.name.endsWith('.png') || file.name.endsWith('.jpg')) btn.style.borderColor = 'var(--sky)';

            // Dim chip if file is Drive-only (not on disk)
            if (!localPaths.has(file.path) && file.drive_id) {
                btn.style.opacity = '0.7';
                btn.title = 'On Drive — click to download & preview';
            }

            btn.addEventListener('click', () => _previewFile(file));
            els.viewerFileList.appendChild(btn);
        });

    } else {
        els.viewerFileList.innerHTML =
            `<span style='color:var(--text-muted);'>Job is currently ${job.current_status}. Files will appear when finished.</span>`;
    }
}

/**
 * Load and render a file preview in the preview pane.
 *
 * Supported types:
 *  - Images (.png, .jpg, .jpeg) — rendered as <img>
 *  - Text files (.csv, .log, .txt, .json) — CSV gets a table; others get a
 *    dark pre-formatted block
 *  - Everything else — download link fallback
 *
 * If the file isn't on disk but has a drive_id, offers on-demand download.
 *
 * @param {{ name: string, path: string, drive_id?: string }} file
 * @private
 */
async function _previewFile(file) {
    if (!els.viewerPreview) return;

    els.viewerPreview.innerHTML = "<p style='color:var(--text-muted); text-align:center;'>Loading preview...</p>";

    try {
        let url = await getLocalFileUrl(file.path);

        // Not local — try on-demand download if we have a drive_id
        if (!url && file.drive_id) {
            const kind = /\.(png|jpe?g)$/i.test(file.name) ? 'image' : 'result';
            const result = await downloadMediaFile(file.drive_id, file.path, kind);
            if (result) {
                url = result.url;
                showToast('File downloaded.', 'success');
            }
        }

        // Still no URL — show Drive-only fallback
        if (!url) {
            if (file.drive_id) {
                const dl = getPublicUrl(file.drive_id, 'result');
                els.viewerPreview.innerHTML = `
                    <div style="text-align:center; padding:40px;">
                        <p style="color:var(--text-muted);">File is on Drive but could not be fetched (CORS).</p>
                        <a href="${dl}" target="_blank" rel="noopener" style="display:inline-block; margin-top:10px; padding:8px 16px; background:#4285F4; color:white; text-decoration:none; border-radius:4px;">Download from Drive ↗</a>
                    </div>
                `;
            } else {
                els.viewerPreview.innerHTML = `<p style='color:var(--text-muted); text-align:center;'>File not available locally or on Drive.</p>`;
            }
            return;
        }

        // ── Image preview ────────────────────────────────────────────────────
        if (/\.(png|jpe?g)$/i.test(file.name)) {
            els.viewerPreview.innerHTML = `
                <div style="text-align:center;">
                    <img src="${url}" style="max-width:100%; max-height:500px; border:1px solid #ccc; border-radius:4px;">
                    <div style="margin-top:15px;">
                        <a href="${url}" download="${file.name}" style="padding:8px 16px; background:#4285F4; color:white; text-decoration:none; border-radius:4px;">Download Image</a>
                    </div>
                </div>
            `;
            return;
        }

        // ── Text-based preview ───────────────────────────────────────────────
        if (/\.(csv|log|txt|json)$/i.test(file.name)) {
            const response = await fetch(url);
            const text     = await response.text();

            if (file.name.endsWith('.csv')) {
                const rows   = text.split('\n').slice(0, 50); // cap at 50 rows
                let html     = "<div style='overflow-x:auto;'><table style='width:100%; border-collapse:collapse; font-size:0.85rem; text-align:left;'>";

                rows.forEach((row, i) => {
                    if (!row.trim()) return;
                    const cols = row.split(',');
                    html += '<tr>';
                    cols.forEach(col => {
                        const tag = i === 0 ? 'th' : 'td';
                        const bg  = i === 0 ? 'background-color:#f0f0f0;' : '';
                        html += `<${tag} style="border:1px solid #ddd; padding:6px; ${bg}">${col}</${tag}>`;
                    });
                    html += '</tr>';
                });
                html += '</table></div>';
                if (text.split('\n').length > 50) {
                    html += "<p style='color:var(--text-muted); font-size:0.8rem; margin-top:10px;'>Showing first 50 rows...</p>";
                }
                html += `<div style="margin-top:15px;"><a href="${url}" download="${file.name}" style="padding:8px 16px; background:#4285F4; color:white; text-decoration:none; border-radius:4px;">Download Full CSV</a></div>`;
                els.viewerPreview.innerHTML = html;

            } else {
                // Logs, JSON, plain text → dark terminal block
                els.viewerPreview.innerHTML = `
                    <pre style="background:#2d2d2d; color:#f8f8f2; padding:15px; overflow:auto; max-height:400px; font-size:0.85rem; border-radius:4px; white-space:pre-wrap;">${_escapeHtml(text)}</pre>
                    <div style="margin-top:15px;">
                        <a href="${url}" download="${file.name}" style="padding:8px 16px; background:#4285F4; color:white; text-decoration:none; border-radius:4px;">Download File</a>
                    </div>
                `;
            }
            return;
        }

        // ── Fallback ─────────────────────────────────────────────────────────
        els.viewerPreview.innerHTML = `
            <div style="text-align:center; padding:40px;">
                <p>Preview not available for this file type.</p>
                <a href="${url}" download="${file.name}" style="display:inline-block; margin-top:10px; padding:8px 16px; background:#4285F4; color:white; text-decoration:none; border-radius:4px;">Download File</a>
            </div>
        `;

    } catch (e) {
        els.viewerPreview.innerHTML = `<p style='color:red;'>Error loading preview: ${e.message}</p>`;
        showToast(`Preview failed: ${e.message}`, 'failed');
    }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Map a job status string to a display colour.
 *
 * @param {string} status
 * @returns {string}  CSS colour value.
 * @private
 */
function _statusColor(status) {
    const map = {
        completed  : '#28a745',
        processing : '#007bff',
        failed     : '#dc3545',
        queue      : '#6c757d',
    };
    return map[status] || '#6c757d';
}

/**
 * Escape HTML special characters to prevent XSS when injecting raw file text
 * into a <pre> block.
 *
 * @param {string} str
 * @returns {string}
 * @private
 */
function _escapeHtml(str) {
    return str
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}
