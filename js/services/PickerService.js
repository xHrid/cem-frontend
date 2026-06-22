import Config from '../core/Config.js';
import { ensureValidToken } from './AuthService.js';

let _pickerLoadPromise = null;

function _loadPicker() {
    if (_pickerLoadPromise) return _pickerLoadPromise;

    _pickerLoadPromise = (async () => {
        if (globalThis.google?.picker) return;

        await _waitForGapi(10000);

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

export async function pickSharedProjectFile() {
    const apiKey = Config.google.pickerApiKey;
    const appId  = Config.google.appId;

    if (!apiKey || apiKey === 'REPLACE_WITH_BROWSER_API_KEY') {
        throw new Error(
            'Google Picker API key is not configured. Set Config.google.pickerApiKey ' +
            '(create a Browser API key in Google Cloud Console and enable the Picker API).'
        );
    }

    const [oauthToken] = await Promise.all([ensureValidToken(), _loadPicker()]);

    if (!oauthToken) throw new Error('Not logged in — cannot open Drive Picker.');

    return new Promise((resolve, reject) => {
        try {
            const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
                .setSelectFolderEnabled(true)
                .setIncludeFolders(true)
                .setOwnedByMe(false)
                .setMimeTypes('application/json')
                .setMode(google.picker.DocsViewMode.LIST);

            const builder = new google.picker.PickerBuilder()
                .setOAuthToken(oauthToken)
                .setDeveloperKey(apiKey)
                .setAppId(appId)
                .addView(view)
                .setTitle('Open the shared folder and pick project_data.json (or select the folder)')
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
