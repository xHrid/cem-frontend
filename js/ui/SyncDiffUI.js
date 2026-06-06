/**
 * SyncDiffUI.js — Interactive "git diff" style conflict resolver
 *
 * Replaces the old 3-button (Pull / Push / Merge) conflict prompt, which only
 * told the user "Local: N spots / Drive: M spots" and forced an all-or-nothing
 * choice. That was confusing — especially across multiple projects, where it
 * looked like the app was "mixing up" projects.
 *
 * This UI instead shows EXACTLY what differs between the local copy and the
 * Google Drive copy, item by item, grouped per project and per collection
 * (spots / routes / sites / files). For every difference the user chooses what
 * to keep:
 *   - Conflict (same item edited on both sides) → keep Local or keep Drive.
 *   - Only on one side → keep it or discard it.
 * Bulk shortcuts (keep all local / keep all drive) are provided.
 *
 * Applying writes the resolved result to BOTH local storage and Drive, so the
 * two ends become identical — the explicit goal of the workflow.
 *
 * Wiring: initSyncDiffUI() subscribes to MASTER_SYNC_CONFLICT and owns the
 * dialog. (ProjectUI no longer opens the legacy modal.)
 */

import EventBus, { EVENTS } from '../core/EventBus.js';
import { getConflictSnapshot, applyResolvedConflict } from '../services/SyncService.js';
import { showToast } from './Toast.js';

// Collections compared, in display order.
const COLLECTIONS = [
    { key: 'spots',          label: 'Spots' },
    { key: 'routes',         label: 'Routes' },
    { key: 'sites',          label: 'Sites' },
    { key: 'external_files', label: 'Files' },
];

/**
 * In-memory model for the currently open diff.
 * choices: Map<choiceKey, 'local'|'drive'|'discard'>
 * projectChoices: Map<projId, 'keep'|'discard'>  (for one-sided projects)
 * @type {{ diff: object, choices: Map, projectChoices: Map }|null}
 */
let _model = null;

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

export function initSyncDiffUI() {
    _ensureDialog();
    EventBus.on(EVENTS.MASTER_SYNC_CONFLICT, () => _open());
}

// ---------------------------------------------------------------------------
// Item helpers
// ---------------------------------------------------------------------------

const _itemId = (it) => it?.spotId || it?.id || null;

function _itemLabel(it, collectionKey) {
    if (collectionKey === 'spots')          return it.name || `Spot ${(_itemId(it) || '').slice(0, 6)}`;
    if (collectionKey === 'routes')         return it.name || `Route ${(_itemId(it) || '').slice(0, 6)}`;
    if (collectionKey === 'sites')          return it.name || `Site ${(_itemId(it) || '').slice(0, 6)}`;
    if (collectionKey === 'external_files') return it.name || `File ${(_itemId(it) || '').slice(0, 6)}`;
    return _itemId(it) || 'item';
}

/**
 * Render a presence tag — a small dot + label. Present = solid accent dot;
 * absent = hollow muted dot. Professional, no emoji-style ✓/✗.
 * @param {string} label
 * @param {boolean} present
 */
function _statusTag(label, present) {
    const fg  = present ? 'var(--forest)' : 'var(--text-muted)';
    const dot = present
        ? 'background: var(--forest); border: 1px solid var(--forest);'
        : 'background: transparent; border: 1px solid var(--text-muted);';
    return `<span style="display:inline-flex; align-items:center; gap:6px; flex:none;
        font-size:0.74rem; font-weight:600; letter-spacing:0.04em; text-transform:uppercase;
        padding:3px 9px; border-radius:999px; color:${fg};
        border:1px solid var(--border-color); background:var(--bg-surface-alt);">
        <span style="width:8px; height:8px; border-radius:50%; ${dot}"></span>${label}</span>`;
}

/** Deterministic stringify (sorted keys) so key-order never fakes a conflict. */
function _stable(obj) {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(_stable).join(',') + ']';
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + _stable(obj[k])).join(',') + '}';
}

const _fmtTs = (it) => it?.timestamp ? new Date(it.timestamp).toLocaleString() : '—';

/**
 * A truncated "who created this" pill. Tap/click toggles the full email (long
 * addresses would otherwise blow up the row). Returns '' when unknown.
 * @param {object} item
 */
function _creatorPill(item) {
    const email = item?.created_by;
    if (!email) return '';
    const safe = String(email).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<span class="creator-pill" title="${safe}" tabindex="0">👤 ${safe}</span>`;
}

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

/**
 * Build a structured diff of local vs remote master data.
 *
 * @param {object} local
 * @param {object} remote
 * @returns {object} diff model (see render code for shape)
 */
function _computeDiff(local, remote) {
    const localProjects  = (local?.projects  || []).filter(p => !p.shared?.isImported);
    const remoteProjects = (remote?.projects || []);

    const lById = new Map(localProjects.map(p => [p.id, p]));
    const rById = new Map(remoteProjects.map(p => [p.id, p]));
    const allIds = new Set([...lById.keys(), ...rById.keys()]);

    const projects = [];
    let totalDiffs = 0;
    let conflictCount = 0;

    for (const pid of allIds) {
        const lp = lById.get(pid) || null;
        const rp = rById.get(pid) || null;

        if (lp && !rp) {
            projects.push({ id: pid, name: lp.name, side: 'local-only', collections: [] });
            totalDiffs++;
            continue;
        }
        if (!lp && rp) {
            projects.push({ id: pid, name: rp.name, side: 'drive-only', collections: [] });
            totalDiffs++;
            continue;
        }

        // Both sides exist — diff each collection.
        const collections = [];
        for (const col of COLLECTIONS) {
            const lArr = lp[col.key] || [];
            const rArr = rp[col.key] || [];
            const lMap = new Map(lArr.map(it => [_itemId(it), it]).filter(([k]) => k));
            const rMap = new Map(rArr.map(it => [_itemId(it), it]).filter(([k]) => k));
            const ids = new Set([...lMap.keys(), ...rMap.keys()]);

            const conflicts = [];
            const localOnly = [];
            const driveOnly = [];

            for (const id of ids) {
                const li = lMap.get(id);
                const ri = rMap.get(id);
                if (li && ri) {
                    if (_stable(li) !== _stable(ri)) {
                        conflicts.push({ id, local: li, drive: ri });
                    }
                } else if (li) {
                    localOnly.push({ id, local: li });
                } else {
                    driveOnly.push({ id, drive: ri });
                }
            }

            if (conflicts.length || localOnly.length || driveOnly.length) {
                collections.push({ key: col.key, label: col.label, conflicts, localOnly, driveOnly });
                totalDiffs += conflicts.length + localOnly.length + driveOnly.length;
                conflictCount += conflicts.length;
            }
        }

        if (collections.length) {
            projects.push({ id: pid, name: lp.name || rp.name, side: 'both', collections });
        }
    }

    return { local, remote, projects, totalDiffs, conflictCount };
}

// ---------------------------------------------------------------------------
// Default choices
// ---------------------------------------------------------------------------

function _defaultChoices(diff) {
    const choices = new Map();
    const projectChoices = new Map();

    for (const p of diff.projects) {
        if (p.side === 'local-only' || p.side === 'drive-only') {
            projectChoices.set(p.id, 'keep'); // default: keep one-sided projects
            continue;
        }
        for (const col of p.collections) {
            for (const c of col.conflicts) {
                // Default conflict winner = local (user can flip per row or in bulk).
                choices.set(_key(p.id, col.key, c.id), 'local');
            }
            for (const c of col.localOnly) choices.set(_key(p.id, col.key, c.id), 'local');
            for (const c of col.driveOnly) choices.set(_key(p.id, col.key, c.id), 'drive');
        }
    }
    return { choices, projectChoices };
}

const _key = (pid, col, id) => `${pid}|${col}|${id}`;

// ---------------------------------------------------------------------------
// Resolution assembly
// ---------------------------------------------------------------------------

/**
 * Build the final resolved master state from the user's choices.
 * @returns {object}
 */
function _assembleResolved() {
    const { diff, choices, projectChoices } = _model;
    const local  = diff.local;
    const remote = diff.remote;

    const lById = new Map((local?.projects  || []).map(p => [p.id, p]));
    const rById = new Map((remote?.projects || []).map(p => [p.id, p]));

    // Start from local projects that are NOT part of the Drive master (imported)
    // — they must always survive locally.
    const resolvedProjects = (local?.projects || []).filter(p => p.shared?.isImported);

    const handled = new Set();

    for (const p of diff.projects) {
        handled.add(p.id);

        if (p.side === 'local-only') {
            if (projectChoices.get(p.id) !== 'discard') resolvedProjects.push(lById.get(p.id));
            continue;
        }
        if (p.side === 'drive-only') {
            if (projectChoices.get(p.id) !== 'discard') resolvedProjects.push(rById.get(p.id));
            continue;
        }

        // Both sides — merge collections per choices, keep identical items.
        const lp = lById.get(p.id);
        const rp = rById.get(p.id);
        const merged = { ...lp }; // local scalars/metadata win (id, name, sharing…)

        for (const col of COLLECTIONS) {
            const lArr = lp[col.key] || [];
            const rArr = rp[col.key] || [];
            const lMap = new Map(lArr.map(it => [_itemId(it), it]).filter(([k]) => k));
            const rMap = new Map(rArr.map(it => [_itemId(it), it]).filter(([k]) => k));
            const ids = new Set([...lMap.keys(), ...rMap.keys()]);

            const out = [];
            for (const id of ids) {
                const li = lMap.get(id);
                const ri = rMap.get(id);
                const choice = choices.get(_key(p.id, col.key, id));

                if (li && ri) {
                    if (_stable(li) === _stable(ri)) { out.push(li); continue; } // identical
                    out.push(choice === 'drive' ? ri : li); // conflict → chosen side
                } else if (li) {
                    if (choice !== 'discard') out.push(li); // local-only
                } else if (ri) {
                    if (choice !== 'discard') out.push(ri); // drive-only
                }
            }
            merged[col.key] = out;
        }
        resolvedProjects.push(merged);
    }

    // Any project present on a side but with NO differences was not in
    // diff.projects — include it from local (it's already identical).
    for (const [id, lp] of lById) {
        if (!handled.has(id) && !resolvedProjects.some(p => p.id === id)) {
            resolvedProjects.push(lp);
        }
    }

    return {
        ...local,
        currentProjectId: local.currentProjectId,
        projects: resolvedProjects,
        metadata: { ...(local.metadata || {}), last_resolved: new Date().toISOString() },
    };
}

// ---------------------------------------------------------------------------
// Open / render
// ---------------------------------------------------------------------------

function _open() {
    const { local, remote } = getConflictSnapshot();
    if (!remote) {
        // No cached remote (shouldn't happen) — nothing to diff.
        showToast('Sync conflict detected, but no remote snapshot is available.', 'failed');
        return;
    }

    const diff = _computeDiff(local, remote);

    if (diff.totalDiffs === 0) {
        // Signatures differed only in ordering / non-item fields — just sync.
        applyResolvedConflict(_passthrough(local));
        return;
    }

    // Additive-only changes (new spots / new temporal entries on either side,
    // nothing edited differently on BOTH) are not a real conflict — auto-merge
    // the union silently instead of nagging the user. The dialog only appears
    // when the same item was edited differently on both sides.
    if (diff.conflictCount === 0) {
        _model = { diff, ..._defaultChoices(diff) }; // defaults keep everything
        applyResolvedConflict(_assembleResolved());
        return;
    }

    _model = { diff, ..._defaultChoices(diff) };
    _render();
    const dlg = document.getElementById('sync-diff-dialog');
    if (dlg && !dlg.open) dlg.showModal();
}

/** A no-op resolved state when there's nothing to choose (local == truth). */
function _passthrough(local) {
    return { ...local, metadata: { ...(local.metadata || {}), last_resolved: new Date().toISOString() } };
}

function _render() {
    const body = document.getElementById('sync-diff-body');
    if (!body || !_model) return;
    const { diff } = _model;

    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    let html = `<p style="margin:0 0 12px; color:var(--text-muted); font-size:0.9rem;">
        ${diff.totalDiffs} difference(s) between this device and Google Drive.
        Choose what to keep, then apply — both will match afterward.</p>`;

    for (const p of diff.projects) {
        html += `<div class="diff-project" style="border:1px solid var(--border-color); border-radius:10px; margin-bottom:12px; padding:12px;">`;

        if (p.side === 'local-only' || p.side === 'drive-only') {
            const onDrive = p.side === 'drive-only';
            const onLocal = p.side === 'local-only';
            // Name + both presence tags on ONE row.
            html += `<div style="display:flex; align-items:center; gap:8px;">
                <span style="font-weight:600; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(p.name || p.id)}</span>
                ${_statusTag('Drive', onDrive)}${_statusTag('Local', onLocal)}
            </div>`;
            html += `<label style="font-size:0.85rem; display:flex; gap:6px; align-items:center; margin-top:8px;">
                <input type="checkbox" data-projkeep="${esc(p.id)}" checked /> Keep this project</label>`;
            html += `</div>`;
            continue;
        }

        html += `<div style="font-weight:600; margin-bottom:6px;">${esc(p.name || p.id)}</div>`;

        for (const col of p.collections) {
            html += `<div style="margin:8px 0 4px; font-size:0.85rem; font-weight:600; color:var(--text-muted);">${col.label}</div>`;

            for (const c of col.conflicts) {
                const k = esc(_key(p.id, col.key, c.id));
                html += `<div class="diff-row" style="display:flex; gap:8px; align-items:center; padding:6px 0; flex-wrap:wrap;">
                    <span style="flex:1; min-width:120px;">✎ ${esc(_itemLabel(c.local, col.key))} <small style="color:var(--text-muted);">(edited on both)</small> ${_creatorPill(c.local || c.drive)}</span>
                    <label style="font-size:0.8rem;"><input type="radio" name="${k}" value="local"  data-choice="${k}"> Local <small>(${esc(_fmtTs(c.local))})</small></label>
                    <label style="font-size:0.8rem;"><input type="radio" name="${k}" value="drive"  data-choice="${k}"> Drive <small>(${esc(_fmtTs(c.drive))})</small></label>
                </div>`;
            }
            for (const c of col.localOnly) {
                const k = esc(_key(p.id, col.key, c.id));
                html += `<div class="diff-row" style="display:flex; gap:8px; align-items:center; padding:6px 0; flex-wrap:wrap;">
                    <span style="flex:1; min-width:120px;">＋ ${esc(_itemLabel(c.local, col.key))} <small style="color:var(--forest);">(only here)</small> ${_creatorPill(c.local)}</span>
                    <label style="font-size:0.8rem;"><input type="checkbox" data-keep="${k}" data-side="local"> Keep</label>
                </div>`;
            }
            for (const c of col.driveOnly) {
                const k = esc(_key(p.id, col.key, c.id));
                html += `<div class="diff-row" style="display:flex; gap:8px; align-items:center; padding:6px 0; flex-wrap:wrap;">
                    <span style="flex:1; min-width:120px;">＋ ${esc(_itemLabel(c.drive, col.key))} <small style="color:var(--sky);">(only on Drive)</small> ${_creatorPill(c.drive)}</span>
                    <label style="font-size:0.8rem;"><input type="checkbox" data-keep="${k}" data-side="drive"> Keep</label>
                </div>`;
            }
        }
        html += `</div>`;
    }

    body.innerHTML = html;
    _syncInputsToModel();
    _bindInputs();
}

/** Reflect current model choices into the rendered inputs. */
function _syncInputsToModel() {
    const { choices, projectChoices } = _model;

    document.querySelectorAll('#sync-diff-body input[type="radio"]').forEach(r => {
        const k = r.getAttribute('data-choice');
        r.checked = choices.get(k) === r.value;
    });
    document.querySelectorAll('#sync-diff-body input[data-keep]').forEach(cb => {
        const k = cb.getAttribute('data-keep');
        cb.checked = choices.get(k) !== 'discard';
    });
    document.querySelectorAll('#sync-diff-body input[data-projkeep]').forEach(cb => {
        const pid = cb.getAttribute('data-projkeep');
        cb.checked = projectChoices.get(pid) !== 'discard';
    });
}

function _bindInputs() {
    const { choices, projectChoices } = _model;

    document.querySelectorAll('#sync-diff-body input[type="radio"]').forEach(r => {
        r.addEventListener('change', () => {
            if (r.checked) choices.set(r.getAttribute('data-choice'), r.value);
        });
    });
    document.querySelectorAll('#sync-diff-body input[data-keep]').forEach(cb => {
        cb.addEventListener('change', () => {
            const k = cb.getAttribute('data-keep');
            const side = cb.getAttribute('data-side'); // 'local' | 'drive'
            choices.set(k, cb.checked ? side : 'discard');
        });
    });
    document.querySelectorAll('#sync-diff-body input[data-projkeep]').forEach(cb => {
        cb.addEventListener('change', () => {
            projectChoices.set(cb.getAttribute('data-projkeep'), cb.checked ? 'keep' : 'discard');
        });
    });
    // Tap a creator pill to reveal / re-truncate the full email.
    document.querySelectorAll('#sync-diff-body .creator-pill').forEach(pill => {
        pill.addEventListener('click', () => pill.classList.toggle('expanded'));
    });
}

// ---------------------------------------------------------------------------
// Bulk actions
// ---------------------------------------------------------------------------

/**
 * Bulk filter:
 *  - 'local' → final state == this device. Keep conflicts' local side, keep
 *    local-only items/projects, DISCARD anything that exists only on Drive.
 *  - 'drive' → final state == Drive. Mirror image.
 */
function _bulk(mode) {
    if (!_model) return;
    const { diff, choices, projectChoices } = _model;
    const wantLocal = mode === 'local';

    for (const p of diff.projects) {
        if (p.side === 'local-only') {
            projectChoices.set(p.id, wantLocal ? 'keep' : 'discard');
            continue;
        }
        if (p.side === 'drive-only') {
            projectChoices.set(p.id, wantLocal ? 'discard' : 'keep');
            continue;
        }
        for (const col of p.collections) {
            for (const c of col.conflicts) {
                choices.set(_key(p.id, col.key, c.id), wantLocal ? 'local' : 'drive');
            }
            for (const c of col.localOnly) {
                choices.set(_key(p.id, col.key, c.id), wantLocal ? 'local' : 'discard');
            }
            for (const c of col.driveOnly) {
                choices.set(_key(p.id, col.key, c.id), wantLocal ? 'discard' : 'drive');
            }
        }
    }
    _syncInputsToModel();
}

// ---------------------------------------------------------------------------
// Dialog scaffold
// ---------------------------------------------------------------------------

function _ensureDialog() {
    if (document.getElementById('sync-diff-dialog')) return;

    const dlg = document.createElement('dialog');
    dlg.id = 'sync-diff-dialog';
    dlg.className = 'modal-dialog';
    dlg.innerHTML = `
        <div class="popup-content" style="max-width:min(92vw,620px); max-height:85vh; display:flex; flex-direction:column;">
            <h3 style="margin:0 0 6px;">🔀 Resolve Sync Differences</h3>
            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;">
                <button type="button" id="diff-bulk-local"  class="small-btn">Keep all local</button>
                <button type="button" id="diff-bulk-drive"  class="small-btn">Keep all Drive</button>
            </div>
            <div id="sync-diff-body" style="overflow-y:auto; flex:1; padding-right:4px;"></div>
            <div class="button-group" style="margin-top:14px; display:flex; gap:8px;">
                <button type="button" id="diff-apply"  class="popup-btn" style="background:#673AB7; color:#fff;">Apply &amp; Sync</button>
                <button type="button" id="diff-cancel" class="popup-btn cancel-btn">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(dlg);

    dlg.querySelector('#diff-bulk-local').addEventListener('click',  () => _bulk('local'));
    dlg.querySelector('#diff-bulk-drive').addEventListener('click',  () => _bulk('drive'));
    // Cancel = leave both sides as-is AND pause auto-sync so the dialog doesn't
    // immediately re-pop on the next poll. User resumes via the Sync menu /
    // "Sync now".
    dlg.querySelector('#diff-cancel').addEventListener('click', async () => {
        if (dlg.open) dlg.close();
        try {
            const { pauseSync } = await import('../services/SyncEngine.js');
            pauseSync();
        } catch (e) { console.warn('[SyncDiffUI] pause failed:', e.message); }
        showToast('Sync paused. Resume from the sync menu when ready.', 'info');
    });

    dlg.querySelector('#diff-apply').addEventListener('click', async () => {
        const btn = dlg.querySelector('#diff-apply');
        btn.disabled = true; btn.textContent = 'Applying...';
        try {
            const resolved = _assembleResolved();
            await applyResolvedConflict(resolved);
            if (dlg.open) dlg.close();
        } catch (err) {
            console.error('[SyncDiffUI] apply failed:', err);
            showToast(`Could not resolve: ${err.message}`, 'failed');
        } finally {
            btn.disabled = false; btn.textContent = 'Apply & Sync';
        }
    });
}
