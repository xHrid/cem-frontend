#!/bin/bash

# This script creates js/config.js on the Render server during the build.
# It pulls the GOOGLE_CLIENT_ID from Render's Environment Variables.

cat <<EOF > js/Config.js
export const CONFIG = {
    GOOGLE_CLIENT_ID: '$GOOGLE_CLIENT_ID',
    GOOGLE_SCOPES: 'https://www.googleapis.com/auth/drive.file',
    DRIVE_ROOT_FOLDER: 'Ecological_Monitoring_Data'
};
EOF

echo "Configuration file generated successfully."