/**
 * MasterData.js — In-memory masterData owner and persistence gateway
 *
 * Pattern : Module Pattern
 *           All module-level variables are private to this file; the exported
 *           functions form the narrowly scoped public API.
 *
 * Responsibility
 * --------------
 * This module is the single source of truth for `masterData` at runtime.
 * No other module may read or mutate masterData directly — they must go through
 * the exported getter/setter surface.
 *
 * Schema (v2, project-based)
 * --------------------------
 * {
 *   currentProjectId : string | null,
 *   projects         : Array<Project>,
 *   metadata         : { created_at: ISO string, schema_version: 2 }
 * }
 *
 * Project shape
 * -------------
 * {
 *   id             : string (UUID),
 *   name           : string,
 *   spots          : Spot[],
 *   routes         : Route[],
 *   sites          : Site[],
 *   external_files : ExternalFile[],
 *   created_at     : ISO string
 * }
 */

import * as StorageAdapter from './StorageAdapter.js';

// ---------------------------------------------------------------------------
// Module-level private state
// ---------------------------------------------------------------------------

/**
 * The authoritative in-memory copy of the master JSON.
 * Modified only via this module's exported functions.
 * @type {object}
 */
let masterData = {
    currentProjectId : null,
    projects         : [],
    metadata         : { created_at: new Date().toISOString() }
};

/**
 * A snapshot of the most recently fetched remote (Drive) master JSON.
 * Stored here so the conflict-resolution UI can reference it without a
 * second network round-trip.
 * @type {{ data: object, fileId: string } | null}
 */
let remoteMasterCache = null;

// ---------------------------------------------------------------------------
// Bootstrap — load & migrate
// ---------------------------------------------------------------------------

/**
 * Load masterData from local storage, migrating legacy (flat / v1) schemas to
 * the project-based v2 schema if necessary.  On a completely fresh install a
 * default project is created and immediately persisted.
 *
 * Must be called once after `StorageAdapter.initStorage()` has resolved.
 *
 * @returns {Promise<void>}
 */
export async function ensureMasterJson() {
    const data = await StorageAdapter.getMasterData();

    if (data && !data.projects) {
        // ── Migration: flat schema (v1) → project-based schema (v2) ──────────
        // The old schema stored spots/routes/sites/external_files at the top
        // level; wrap them in a single "Default Project" entry.
        console.log('MasterData: Migrating flat (v1) data to project-based (v2) structure…');

        const defaultId      = crypto.randomUUID();
        const defaultProject = {
            id             : defaultId,
            name           : 'Default Project',
            spots          : data.spots          || [],
            routes         : data.routes         || [],
            sites          : data.sites          || [],
            external_files : data.external_files || [],
            created_at     : data.metadata?.created_at || new Date().toISOString()
        };

        masterData = {
            currentProjectId : defaultId,
            projects         : [defaultProject],
            metadata         : { ...data.metadata, schema_version: 2 }
        };

        await saveMasterData();

    } else if (data) {
        // ── Normal load: v2 schema ────────────────────────────────────────────
        masterData = data;

        // Guard: currentProjectId might point to a project that was deleted on
        // another device before this load. Fall back to the first project.
        if (!masterData.projects.find(p => p.id === masterData.currentProjectId)) {
            masterData.currentProjectId = masterData.projects[0]?.id || null;
        }

    } else {
        // ── Fresh install ─────────────────────────────────────────────────────
        const defaultId = crypto.randomUUID();
        masterData = {
            currentProjectId : defaultId,
            projects         : [{
                id             : defaultId,
                name           : 'Untitled Project',
                spots          : [],
                routes         : [],
                sites          : [],
                external_files : [],
                created_at     : new Date().toISOString()
            }],
            metadata : { created_at: new Date().toISOString(), schema_version: 2 }
        };

        await saveMasterData();
    }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Persist the current in-memory masterData to the storage backend.
 *
 * Previously named `_saveMasterData` (private). Exposed here so ProjectManager
 * and Repository can flush changes after mutations without holding a reference
 * to the raw masterData object.
 *
 * @returns {Promise<void>}
 */
export async function saveMasterData() {
    await StorageAdapter.saveMasterData(masterData);
}

// ---------------------------------------------------------------------------
// Content hashing — deterministic data signature
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic content signature for a masterData object.
 *
 * The signature is built from each project's item IDs and timestamps, sorted
 * so that insertion-order differences do not create false positives when
 * comparing a local state against a remote snapshot.
 *
 * Used by the Drive sync logic to detect whether a remote copy actually differs
 * from local data before presenting a conflict resolution dialog to the user.
 *
 * @param {object} data  A masterData object (may be the live state or a remote copy).
 * @returns {string}     A string hash; equal strings mean equal content.
 */
export function generateDataSignature(data) {
    if (!data || !data.projects) return 'empty';

    return data.projects
        .map(p => {
            const spots  = (p.spots          || []).map(s => `${s.spotId}_${s.timestamp}`).sort().join(',');
            const sites  = (p.sites          || []).map(s => `${s.id}_${s.timestamp}`).sort().join(',');
            const routes = (p.routes         || []).map(r => `${r.id}_${r.timestamp}`).sort().join(',');
            const files  = (p.external_files || []).map(f => `${f.id}_${f.timestamp}`).sort().join(',');

            return `Project:${p.id}_${p.name}|Spots:${spots}|Sites:${sites}|Routes:${routes}|Files:${files}`;
        })
        .sort()
        .join('||');
}

// ---------------------------------------------------------------------------
// State getters — masterData
// ---------------------------------------------------------------------------

/**
 * Return the full in-memory masterData object.
 * Callers should treat this as read-only; mutations must go through the
 * appropriate module (ProjectManager, Repository, etc.).
 *
 * @returns {object}
 */
export function getLocalState() {
    return masterData;
}

/**
 * Alias for getLocalState().  Provided for symmetry with the old storage.js API
 * so callers that imported getMasterData() from storage.js require fewer edits.
 *
 * @returns {object}
 */
export function getMasterData() {
    return masterData;
}

/**
 * Replace the entire in-memory masterData object.
 * Used by SyncService when pulling or merging remote data.
 * Also persists the new state to the storage adapter.
 *
 * @param {object} newData — Full masterData object to set
 */
export async function replaceState(newData) {
    masterData = newData;
    await saveMasterData();
}

// ---------------------------------------------------------------------------
// State getters — active project
// ---------------------------------------------------------------------------

/**
 * Return the currently active Project object.
 *
 * Falls back to the first project when currentProjectId is null or stale (e.g.
 * after a remote pull that removed the active project).
 *
 * @returns {object|null}
 */
export function getActiveProject() {
    if (!masterData.projects || masterData.projects.length === 0) return null;

    return (
        masterData.projects.find(p => p.id === masterData.currentProjectId) ||
        masterData.projects[0]
    );
}

/**
 * Return the UUID of the currently active project.
 *
 * @returns {string|null}
 */
export function getActiveProjectId() {
    return masterData.currentProjectId;
}

/**
 * Overwrite the active project selection.
 *
 * Validation (project existence) is the responsibility of ProjectManager —
 * this setter performs no guard so that migration code can set an id before
 * the projects array is fully populated.
 *
 * @param {string|null} id
 */
export function setCurrentProjectId(id) {
    masterData.currentProjectId = id;
}

// ---------------------------------------------------------------------------
// State getters — active project collections
// ---------------------------------------------------------------------------

/**
 * @returns {object[]} Spots array of the active project (never null).
 */
export function getSpots() {
    return getActiveProject()?.spots || [];
}

/**
 * @returns {object[]} Routes array of the active project (never null).
 */
export function getRoutes() {
    return getActiveProject()?.routes || [];
}

/**
 * @returns {object[]} Sites array of the active project (never null).
 */
export function getSites() {
    return getActiveProject()?.sites || [];
}

/**
 * @returns {object[]} External files array of the active project (never null).
 */
export function getExternalFiles() {
    return getActiveProject()?.external_files || [];
}

// ---------------------------------------------------------------------------
// Remote cache — Drive conflict resolution staging area
// ---------------------------------------------------------------------------

/**
 * Return the cached remote master snapshot (set when a Drive conflict is detected).
 *
 * @returns {{ data: object, fileId: string } | null}
 */
export function getRemoteMasterCache() {
    return remoteMasterCache;
}

/**
 * Store a remote master snapshot for later conflict resolution.
 *
 * @param {{ data: object, fileId: string }} cache
 */
export function setRemoteMasterCache(cache) {
    remoteMasterCache = cache;
}

/**
 * Discard the cached remote snapshot (called after resolution is applied).
 */
export function clearRemoteMasterCache() {
    remoteMasterCache = null;
}
