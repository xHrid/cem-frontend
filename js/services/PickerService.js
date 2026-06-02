/**
 * PickerService.js — Google Picker wrapper for shared-folder access
 *
 * Pattern : Singleton loader + thin Promise-based facade
 *
 * Why this exists
 * ---------------
 * The app uses the NON-restricted `drive.file` OAuth scope. With drive.file
 * the app can only touch files it created OR files the user explicitly opens
 * through the Google Picker. To import a project a collaborator shared with
 * us, the user picks the shared FOLDER in the Picker dialog — Drive then
 * grants this app drive.file access to that folder and its contents, with no
 * need for the broad `drive.readonly` ("whole Drive") scope.
 *
 * Requirements (see Config.google):
 *  - pickerApiKey : Browser API key with the Picker API enabled.
 *  - appId        : Cloud project number (associates picked files with the app).
 *  - A loaded GIS access token (from AuthService.ensureValidToken()).
 *
 * The Picker JS library is loaded from `https://apps.google.com/api/js`,
 * which is included via a <script> tag in index.html.
 *
 * Usage:
 *   import { pickSharedProjectFile } from './services/PickerService.js';
 *   const file = await pickSharedProjectFile(); // { id, name } or null if cancelled
 */

import Config from '../core/Config.js';
import { ensureValidToken } from './AuthService.js';

// ---------------------------------------------------------------------------
// Lazy Picker library loader
// ---------------------------------------------------------------------------

/** @type {Promise<void>|null} Resolves once google.picker is ready. */
let _pickerLoadPromise = null;

/**
 * Load the Google Picker library exactly once.
 * Relies on the `gapi` loader script tag in index.html.
 *
 * @returns {Promise<void>}
 */
function _loadPicker() {
    if (_pickerLoadPromise) return _pickerLoadPromise;

    _pickerLoadPromise = (async () => {
        // Already loaded?
        if (globalThis.google?.picker) return;

        // The loader (apis.google.com/js/api.js) is async — on the first click
        // it may not have executed yet. Wait for `gapi` to appear instead of
        // failing instantly.
        await _waitForGapi(10000);

        // gapi.load is callback-based; wrap it in a Promise.
        await new Promise((resolve, reject) => {
            gapi.load('picker', {
                callback: () => resolve(),
                onerror: () => reject(new Error('Failed to load the Google Picker library.')),
                timeout: 15000,
                ontimeout: () => reject(new Error('Timed out loading the Google Picker library.')),
            });
        });
    })();

    return _pickerLoadPromise;
}

/**
 * Poll until `globalThis.gapi` is defined or the timeout elapses.
 *
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function _waitForGapi(timeoutMs) {
    return new Promise((resolve, reject) => {
        if (globalThis.gapi) { resolve(); return; }

        const start = Date.now();
        const tick = setInterval(() => {
            if (globalThis.gapi) {
                clearInterval(tick);
                resolve();
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(tick);
                reject(new Error(
                    'Google API loader (gapi) did not load. Check that ' +
                    'https://apis.google.com/js/api.js is reachable and not blocked.'
                ));
            }
        }, 150);
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open the Google Picker so the editor selects the shared project's
 * `project_data.json` FILE (not the folder).
 *
 * WHY a file, not a folder: under the narrow `drive.file` scope, picking a
 * folder grants access to the folder but NOT the right to list/read the files
 * the owner created inside it. Picking the `project_data.json` file directly
 * grants read+write to THAT file (the editor already has writer permission via
 * the share) — which is exactly the one file collaborators edit. No restricted
 * scope, no OAuth verification.
 *
 * The view shows "Shared with me", filtered to JSON, with folder navigation so
 * the user can open the shared folder and pick `project_data.json` inside it.
 *
 * @returns {Promise<{id: string, name: string}|null>}
 *          The picked file, or null if the user cancelled.
 * @throws  {Error} If config is missing or the Picker fails to load.
 */
export async function pickSharedProjectFile() {
    const apiKey = Config.google.pickerApiKey;
    const appId  = Config.google.appId;

    if (!apiKey || apiKey === 'REPLACE_WITH_BROWSER_API_KEY') {
        throw new Error(
            'Google Picker API key is not configured. Set Config.google.pickerApiKey ' +
            '(create a Browser API key in Google Cloud Console and enable the Picker API).'
        );
    }

    // Ensure we have a fresh OAuth token AND the Picker library is loaded.
    const [oauthToken] = await Promise.all([ensureValidToken(), _loadPicker()]);

    if (!oauthToken) throw new Error('Not logged in — cannot open Drive Picker.');

    return new Promise((resolve, reject) => {
        try {
            // "Shared with me", navigable folders, but select a JSON FILE.
            const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
                .setSelectFolderEnabled(false)
                .setIncludeFolders(true)          // let the user open the shared folder
                .setOwnedByMe(false)              // show items shared with the user
                .setMimeTypes('application/json')  // only project_data.json-type files
                .setMode(google.picker.DocsViewMode.LIST);

            const builder = new google.picker.PickerBuilder()
                .setOAuthToken(oauthToken)
                .setDeveloperKey(apiKey)
                .setAppId(appId)
                .addView(view)
                .setTitle('Open the shared folder, then select project_data.json')
                .setCallback((data) => {
                    const action = data[google.picker.Response.ACTION];

                    if (action === google.picker.Action.PICKED) {
                        const doc = data[google.picker.Response.DOCUMENTS]?.[0];
                        if (!doc) { resolve(null); return; }
                        resolve({
                            id:   doc[google.picker.Document.ID],
                            name: doc[google.picker.Document.NAME],
                        });
                    } else if (action === google.picker.Action.CANCEL) {
                        resolve(null);
                    }
                });

            builder.build().setVisible(true);
        } catch (err) {
            reject(err);
        }
    });
}
