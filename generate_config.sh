#!/bin/bash

set -e

APP_ID="${GOOGLE_CLIENT_ID%%-*}"

ANALYSIS_REPO_URL="${ANALYSIS_REPO_URL:-https://raw.githubusercontent.com/xHrid/cem-backend/refs/heads/master}"

CORS_PROXY_URL="${CORS_PROXY_URL:-https://cem-proxy.cem-cors.workers.dev}"

SERVER_BASE_URL="${SERVER_BASE_URL%/}"

AIRFLOW_TRIGGER_URL="${AIRFLOW_TRIGGER_URL%/}"

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
