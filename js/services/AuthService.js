/**
 * AuthService.js — Google Identity Services authentication wrapper
 *
 * Pattern  : Singleton (one tokenClient, one token state for the whole app)
 *
 * Fixes over auth.js:
 *  1. Token expiry tracked via `tokenExpiresAt`; 1-min buffer baked into
 *     `isTokenExpired()` so calls never fire with a stale token.
 *  2. `ensureValidToken()` wraps a silent re-request in a Promise so any
 *     service can await a fresh token without coupling to the UI.
 *  3. Guard against `globalThis.google` being absent (script load failure).
 *  4. `requestLogin()` no longer silently no-ops when already logged in —
 *     callers that need a forced re-auth can call `forceReauth()`.
 *
 * Usage:
 *   import { initAuth, requestLogin, ensureValidToken } from './AuthService.js';
 */

import Config from '../core/Config.js';

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

/** @type {google.accounts.oauth2.TokenClient|null} */
let tokenClient = null;

/** @type {string|null} */
let accessToken = null;

/** Signed-in Google account email (resolved lazily after each token grant). */
let userEmail = null;

/**
 * UNIX-epoch milliseconds at which the current access token expires.
 * Initialised to 0 so `isTokenExpired()` returns true before any login.
 * @type {number}
 */
let tokenExpiresAt = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the Google OAuth2 token client.
 *
 * Must be called once after the `accounts.google.com/gsi/client` script
 * has loaded.  Safe to call multiple times — subsequent calls are no-ops
 * if `tokenClient` is already set.
 *
 * @param {Function} [onLoginSuccess]  Called after a successful token grant.
 */
export function initAuth(onLoginSuccess) {
    if (!globalThis.google) {
        console.error('[AuthService] Google Identity Services not loaded');
        return;
    }

    // Singleton guard — do not re-initialise if already set up
    if (tokenClient) return;

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: Config.google.clientId,
        scope: Config.google.scopes,

        /**
         * Called by GIS on every token grant/refresh.
         * We store the token AND compute an absolute expiry timestamp so
         * callers never need to track elapsed time themselves.
         */
        callback: (response) => {
            if (response.error) {
                console.error('[AuthService] Token error:', response);
                return;
            }

            accessToken = response.access_token;
            tokenExpiresAt = Date.now() + ((response.expires_in || 3600) * 1000);
            console.log(
                '[AuthService] Logged in. Token expires in',
                response.expires_in ?? 3600,
                's'
            );

            // Resolve the account email (used to stamp who created each record).
            // drive.file's `about.get` returns the user's email — no extra scope.
            _fetchUserEmail();

            if (typeof onLoginSuccess === 'function') onLoginSuccess();
        },
    });
}

/**
 * Trigger an interactive OAuth2 consent / sign-in flow.
 *
 * Unlike the old `requestLogin()`, this does NOT silently skip when a token
 * already exists — the UI layer should decide when to call this.
 */
export function requestLogin() {
    if (!tokenClient) {
        console.error('[AuthService] Auth not initialized. Call initAuth() first.');
        return;
    }
    tokenClient.requestAccessToken();
}

/**
 * Force a new access-token request regardless of the current token state.
 * Useful after an API 401 response or when the user wants to switch accounts.
 */
export function forceReauth() {
    accessToken = null;
    tokenExpiresAt = 0;
    requestLogin();
}

/**
 * Return the current access token string, or `null` if not logged in.
 * Most callers should prefer `ensureValidToken()` which handles expiry.
 *
 * @returns {string|null}
 */
export function getAccessToken() {
    return accessToken;
}

/**
 * Return the signed-in account email, or null if not yet resolved.
 * @returns {string|null}
 */
export function getUserEmail() {
    return userEmail;
}

/** Fetch the current account's email via Drive about.get (fire-and-forget). */
async function _fetchUserEmail() {
    if (!accessToken) return;
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

/**
 * Return `true` if there is no access token OR if it will expire within
 * the next 60 seconds (1-minute safety buffer).
 *
 * @returns {boolean}
 */
export function isTokenExpired() {
    if (!accessToken) return true;
    // 60 000 ms buffer — refresh before the server rejects us
    return Date.now() >= tokenExpiresAt - 60_000;
}

/**
 * Return a valid access token, transparently refreshing it if expired.
 *
 * If the token is still valid this resolves immediately.  If it has expired
 * (or is within the 1-min buffer), a silent `requestAccessToken()` call is
 * made and the Promise resolves once GIS invokes the callback.
 *
 * The original `callback` registered in `initTokenClient` is preserved and
 * chained so that `onLoginSuccess` still fires on every refresh.
 *
 * @returns {Promise<string>} Resolves with a fresh access token.
 * @throws  {Error}           If `initAuth()` has not been called yet.
 */
export async function ensureValidToken() {
    if (!isTokenExpired()) {
        return accessToken;
    }

    return new Promise((resolve, reject) => {
        if (!tokenClient) {
            reject(new Error('[AuthService] Auth not initialized. Call initAuth() first.'));
            return;
        }

        // Wrap the existing callback so we can intercept the next grant
        const originalCallback = tokenClient.callback;

        tokenClient.callback = (response) => {
            // Restore the original callback immediately so subsequent grants
            // go back to the normal flow
            tokenClient.callback = originalCallback;

            if (response.error) {
                reject(new Error(`[AuthService] Token refresh failed: ${response.error}`));
                return;
            }

            // Let the original handler update state and call onLoginSuccess
            if (typeof originalCallback === 'function') {
                originalCallback(response);
            }

            resolve(accessToken);
        };

        // Request a new token silently (no consent screen if already granted)
        tokenClient.requestAccessToken({ prompt: '' });
    });
}
