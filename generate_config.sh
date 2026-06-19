#!/bin/bash
#
# generate_config.sh — build-time generator for js/core/Config.js
#
# js/core/Config.js is gitignored (holds the OAuth client id + keys + the lab
# server URL/key), so it is NOT in the repo. Render runs this script at build
# time to recreate it from Environment Variables. The output MUST match the
# schema the app imports:
#   import Config from '../core/Config.js';   // default export, nested objects
#
# Render env vars
# ---------------
# Required:
#   GOOGLE_CLIENT_ID   OAuth 2.0 client ID (…apps.googleusercontent.com)
#
# Optional (Google Picker — only needed for importing shared folders):
#   PICKER_API_KEY     Browser API key with the Picker API enabled
#
# Optional ("Connect to Server" compute mode — the Dockerised FastAPI):
#   SERVER_BASE_URL    Origin of the lab API, NO trailing slash, HTTPS when the
#                      site is served over HTTPS (e.g. an ngrok/cloudflared
#                      tunnel or reverse proxy in front of the docker).
#                      e.g. https://abc123.ngrok-free.app
#   SERVER_API_KEY     Sent in the X-API-Key header; MUST equal the docker's
#                      API_KEY env var. NOTE: this is a static site, so this
#                      value ships in plaintext to every visitor — only use a
#                      key you are comfortable exposing.
#
# Optional (Airflow DAG trigger — when set, the frontend triggers scripts via
#   Airflow instead of calling the server directly):
#   AIRFLOW_TRIGGER_URL  Full URL to POST a DAG run, e.g.
#                        https://airflow.example.com/api/v1/dags/cem_pipeline/dagRuns
#                        The body is the same JSON the server expects for
#                        POST /api/v1/scripts, plus a client-generated job_id.
#
# Optional (override the analysis script repo; defaults to the main repo):
#   ANALYSIS_REPO_URL  Raw GitHub content URL, no trailing slash.
#
# Optional (Cloudflare Worker CORS proxy for Drive media + COG access):
#   CORS_PROXY_URL     e.g. https://cem-proxy.cem-cors.workers.dev
#
# appId (Cloud project number) is derived from the client ID's leading segment.

set -e

# Derive the Cloud project number from the client ID ("1234-abc...." -> "1234").
APP_ID="${GOOGLE_CLIENT_ID%%-*}"

# Default the analysis repo if not provided.
ANALYSIS_REPO_URL="${ANALYSIS_REPO_URL:-https://raw.githubusercontent.com/xHrid/cem-backend/refs/heads/master}"

# Default the CORS proxy (hardcoded fallback matches the deployed worker).
CORS_PROXY_URL="${CORS_PROXY_URL:-https://cem-proxy.cem-cors.workers.dev}"

# Strip any trailing slash the user may have added to the server URL.
SERVER_BASE_URL="${SERVER_BASE_URL%/}"

# Strip trailing slash from Airflow trigger URL if provided.
AIRFLOW_TRIGGER_URL="${AIRFLOW_TRIGGER_URL%/}"

# Write to the path the code actually imports: js/core/Config.js
cat <<EOF > js/core/Config.js
/**
 * Config.js — GENERATED at build time by generate_config.sh.
 * Do not edit on the server; edit generate_config.sh instead.
 */

function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    Object.keys(obj).forEach(key => deepFreeze(obj[key]));
    return Object.freeze(obj);
}

const Config = deepFreeze({
    google: {
        clientId: '${GOOGLE_CLIENT_ID}',
        scopes: 'https://www.googleapis.com/auth/drive.file',
        pickerApiKey: '${PICKER_API_KEY}',
        appId: '${APP_ID}',
        driveRootFolder: 'Ecological_Monitoring_Data',
    },
    storage: {
        dbName: 'CEM_Toolkit_DB',
        storeName: 'files',
        masterFilename: 'master_data.json',
    },
    watcher: {
        pollInterval: 3000,
        maxStaleAge: 15,
        processingMaxAge: 1800,
        installingMaxAge: 600,
    },
    analysis: {
        githubRepoUrl: '${ANALYSIS_REPO_URL}',
    },
    server: {
        baseUrl: '${SERVER_BASE_URL}',
    },
    airflow: {
        triggerUrl: '${AIRFLOW_TRIGGER_URL}',
    },
    proxy: {
        workerUrl: '${CORS_PROXY_URL}',
    },
    ui: {
        toastDuration: 3000,
    },
    map: {
        defaultCenter: [20, 0],
        defaultZoom: 3,
        minZoom: 3,
        maxZoom: 18,
    },
});

export default Config;
EOF

echo "Configuration file generated successfully at js/core/Config.js"
echo "  google.clientId    : ${GOOGLE_CLIENT_ID:-(unset!)}"
echo "  google.pickerApiKey: ${PICKER_API_KEY:+set}"
echo "  server.baseUrl     : ${SERVER_BASE_URL:-(unset — server mode disabled)}"
echo "  airflow.triggerUrl : ${AIRFLOW_TRIGGER_URL:-(unset — direct server mode)}"
echo "  proxy.workerUrl    : ${CORS_PROXY_URL}"
