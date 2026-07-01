import Config from '../core/Config.js';

let tokenClient = null;

let accessToken = null;

let userEmail = null;

let userId = null;

let tokenExpiresAt = 0;

export function initAuth(onLoginSuccess) {
    if (!globalThis.google) {
        console.error('[AuthService] Google Identity Services not loaded');
        return;
    }

    if (tokenClient) return;

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: Config.google.clientId,
        scope: Config.google.scopes,

        callback: (response) => {
            if (response.error) {
                console.error('[AuthService] Token error:', response);
                return;
            }

            accessToken = response.access_token;
            tokenExpiresAt = Date.now() + ((response.expires_in || 3600) * 1000);

            _fetchUserInfo();

            if (typeof onLoginSuccess === 'function') onLoginSuccess();
        },
    });
}

export function requestLogin() {
    if (!tokenClient) {
        console.error('[AuthService] Auth not initialized. Call initAuth() first.');
        return;
    }
    tokenClient.requestAccessToken();
}

export function forceReauth() {
    accessToken = null;
    tokenExpiresAt = 0;
    requestLogin();
}

export function getAccessToken() {
    return accessToken;
}

export function getUserEmail() {
    return userEmail;
}

export function getUserId() {
    return userId;
}

// Identity headers attached to server requests so the backend can log who did
// what. Google `sub` is the stable account id; email is the human-readable key.
export function authHeaders() {
    const h = {};
    if (userEmail) h['X-User-Email'] = userEmail;
    if (userId) h['X-User-Id'] = userId;
    return h;
}

async function _fetchUserInfo() {
    if (!accessToken) return;
    try {
        const res = await fetch(
            'https://www.googleapis.com/oauth2/v3/userinfo',
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (res.ok) {
            const json = await res.json();
            userEmail = json.email || userEmail;
            userId = json.sub || userId;
        }
    } catch (e) {
        console.warn('[AuthService] could not resolve user info:', e.message);
    }
    if (!userEmail) await _fetchUserEmailFallback();
}

async function _fetchUserEmailFallback() {
    try {
        const res = await fetch(
            'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (res.ok) {
            const json = await res.json();
            userEmail = json.user?.emailAddress || null;
        }
    } catch (e) {
        console.warn('[AuthService] could not resolve user email:', e.message);
    }
}

export function isTokenExpired() {
    if (!accessToken) return true;
    return Date.now() >= tokenExpiresAt - 60_000;
}

let _refreshInFlight = null;

export async function ensureValidToken() {
    if (!isTokenExpired()) return accessToken;
    if (_refreshInFlight) return _refreshInFlight;

    _refreshInFlight = new Promise((resolve, reject) => {
        if (!tokenClient) {
            reject(new Error('[AuthService] Auth not initialized. Call initAuth() first.'));
            return;
        }

        const originalCallback = tokenClient.callback;
        tokenClient.callback = (response) => {
            tokenClient.callback = originalCallback;

            if (response.error) {
                reject(new Error(`[AuthService] Token refresh failed: ${response.error}`));
                return;
            }

            if (typeof originalCallback === 'function') originalCallback(response);
            resolve(accessToken);
        };

        tokenClient.requestAccessToken({ prompt: '' });
    }).finally(() => { _refreshInFlight = null; });

    return _refreshInFlight;
}
