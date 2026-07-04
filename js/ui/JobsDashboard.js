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
import { escapeHtml as _escapeHtml } from '../core/escape.js';

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

export function initJobsDashboard() {
    const jobsBtn = document.getElementById('jobs-btn');
    if (jobsBtn) {
        jobsBtn.addEventListener('click', openJobsModal);
    }

    document.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'close-jobs-btn') {
            closeModal('jobs-popup');
            revokeObjectUrls();
        }

        if (e.target && e.target.id === 'refresh-jobs-btn') {
            _loadJobsSidebar();
        }
    });
}

export async function openJobsModal() {
    _cacheElements();

    openModal('jobs-popup');
    if (els.viewerPlaceholder) els.viewerPlaceholder.style.display = 'block';
    if (els.viewerContent)     els.viewerContent.style.display     = 'none';

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

async function _loadJobsSidebar() {
    if (!els.listSidebar) return;

    els.listSidebar.innerHTML = "<p style='padding:15px; color:var(--text-muted);'>Loading jobs...</p>";

    try {
        const localJobs = await getAllJobs();
        const localIds = new Set(localJobs.map(j => j.job_id));

        const project = getActiveProject();
        const sharedJobs = (project?.jobs || [])
            .filter(j => !j.deleted && !localIds.has(j.job_id))
            .map(j => ({
                ...j,
                job_name: j.job_name || j.job_id,
                current_status: j.status || 'completed',
                created_at: j.completed_at || j.timestamp || new Date().toISOString(),
                _remote: true,
            }));

        const jobs = [...localJobs, ...sharedJobs].sort((a, b) => {
            return new Date(b.created_at || 0) - new Date(a.created_at || 0);
        });

        els.listSidebar.innerHTML = '';

        if (jobs.length === 0) {
            els.listSidebar.innerHTML = "<p style='padding:15px; color:var(--text-muted);'>No jobs found.</p>";
            return;
        }

        jobs.forEach(job => {
            const div       = document.createElement('div');
            div.className   = 'job-row';

            const color = _statusColor(job.current_status);

            div.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-dark); flex:1;">
                        ${_escapeHtml(job.job_name || 'Unnamed Job')}
                    </div>
                    <button class="delete-job-btn" title="Delete job" style="background:none; border:none; color:var(--danger-red); cursor:pointer; font-size:1rem; padding:2px 6px;">🗑</button>
                </div>
                <div style="display:flex; justify-content:space-between; font-size:0.78rem; color:var(--text-muted); margin-top:6px;">
                    <span style="color:${color}; font-weight:700; letter-spacing:0.04em;">${_escapeHtml(String(job.current_status).toUpperCase())}</span>
                    <span style="font-family:var(--font-mono);">${new Date(job.created_at).toLocaleDateString()}</span>
                </div>
            `;

            div.querySelector('.delete-job-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(`Delete job "${job.job_name || 'Unnamed Job'}"?`)) return;
                try {
                    const removed = await deleteJob(job.job_id, job.current_status);
                    showToast(removed ? 'Job deleted.' : 'Job entry cleared.', 'success');
                    div.remove();
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
        const localFiles = await getJobResultFiles(job.job_id);

        const project  = getActiveProject();
        const projJob  = (project?.jobs || []).find(j => j.job_id === job.job_id);
        const driveMap = new Map();
        for (const rf of (projJob?.result_files || [])) {
            if (rf.rel_path && rf.drive_id) driveMap.set(rf.rel_path, rf.drive_id);
        }

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

            if (file.name.endsWith('.csv'))                               btn.style.borderColor = '#3f8f4f';
            if (file.name.endsWith('.log'))                               btn.style.borderColor = 'var(--danger-red)';
            if (file.name.endsWith('.png') || file.name.endsWith('.jpg')) btn.style.borderColor = 'var(--sky)';

            if (!localPaths.has(file.path) && file.drive_id) {
                btn.style.opacity = '0.7';
                btn.title = 'On Drive — click to download & preview';
            }

            btn.addEventListener('click', () => _previewFile(file));
            els.viewerFileList.appendChild(btn);
        });

    } else {
        els.viewerFileList.innerHTML =
            `<span style='color:var(--text-muted);'>Job is currently ${_escapeHtml(String(job.current_status))}. Files will appear when finished.</span>`;
    }
}

async function _previewFile(file) {
    if (!els.viewerPreview) return;

    els.viewerPreview.innerHTML = "<p style='color:var(--text-muted); text-align:center;'>Loading preview...</p>";

    try {
        let url = await getLocalFileUrl(file.path);

        if (!url && file.drive_id) {
            const kind = /\.(png|jpe?g)$/i.test(file.name) ? 'image' : 'result';
            const result = await downloadMediaFile(file.drive_id, file.path, kind);
            if (result) {
                url = result.url;
                showToast('File downloaded.', 'success');
            }
        }

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

        if (/\.(png|jpe?g)$/i.test(file.name)) {
            els.viewerPreview.innerHTML = `
                <div style="text-align:center;">
                    <img src="${url}" style="max-width:100%; max-height:500px; border:1px solid #ccc; border-radius:4px;">
                    <div style="margin-top:15px;">
                        <a href="${url}" download="${_escapeHtml(file.name)}" style="padding:8px 16px; background:#4285F4; color:white; text-decoration:none; border-radius:4px;">Download Image</a>
                    </div>
                </div>
            `;
            return;
        }

        if (/\.(csv|log|txt|json)$/i.test(file.name)) {
            const response = await fetch(url);
            const text     = await response.text();

            if (file.name.endsWith('.csv')) {
                const rows   = text.split('\n').slice(0, 50);
                let html     = "<div style='overflow-x:auto;'><table style='width:100%; border-collapse:collapse; font-size:0.85rem; text-align:left;'>";

                rows.forEach((row, i) => {
                    if (!row.trim()) return;
                    const cols = row.split(',');
                    html += '<tr>';
                    cols.forEach(col => {
                        const tag = i === 0 ? 'th' : 'td';
                        const bg  = i === 0 ? 'background-color:#f0f0f0;' : '';
                        html += `<${tag} style="border:1px solid #ddd; padding:6px; ${bg}">${_escapeHtml(col)}</${tag}>`;
                    });
                    html += '</tr>';
                });
                html += '</table></div>';
                if (text.split('\n').length > 50) {
                    html += "<p style='color:var(--text-muted); font-size:0.8rem; margin-top:10px;'>Showing first 50 rows...</p>";
                }
                html += `<div style="margin-top:15px;"><a href="${url}" download="${_escapeHtml(file.name)}" style="padding:8px 16px; background:#4285F4; color:white; text-decoration:none; border-radius:4px;">Download Full CSV</a></div>`;
                els.viewerPreview.innerHTML = html;

            } else {
                els.viewerPreview.innerHTML = `
                    <pre style="background:#2d2d2d; color:#f8f8f2; padding:15px; overflow:auto; max-height:400px; font-size:0.85rem; border-radius:4px; white-space:pre-wrap;">${_escapeHtml(text)}</pre>
                    <div style="margin-top:15px;">
                        <a href="${url}" download="${_escapeHtml(file.name)}" style="padding:8px 16px; background:#4285F4; color:white; text-decoration:none; border-radius:4px;">Download File</a>
                    </div>
                `;
            }
            return;
        }

        els.viewerPreview.innerHTML = `
            <div style="text-align:center; padding:40px;">
                <p>Preview not available for this file type.</p>
                <a href="${url}" download="${_escapeHtml(file.name)}" style="display:inline-block; margin-top:10px; padding:8px 16px; background:#4285F4; color:white; text-decoration:none; border-radius:4px;">Download File</a>
            </div>
        `;

    } catch (e) {
        els.viewerPreview.innerHTML = `<p style='color:red;'>Error loading preview: ${e.message}</p>`;
        showToast(`Preview failed: ${e.message}`, 'failed');
    }
}

function _statusColor(status) {
    const map = {
        completed  : '#28a745',
        processing : '#007bff',
        failed     : '#dc3545',
        queue      : '#6c757d',
    };
    return map[status] || '#6c757d';
}
