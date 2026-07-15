# CEM Frontend - static SPA served by nginx.
# Code is not baked in for local/dev use: docker-compose mounts the repo over
# /usr/share/nginx/html so a restart (no rebuild) picks up new code, matching
# the backend's bind-mount pattern. The COPY below only matters for a
# standalone image build (e.g. pushing to a registry) with no compose mount.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY index.html /usr/share/nginx/html/index.html
COPY js /usr/share/nginx/html/js
COPY styles /usr/share/nginx/html/styles
COPY leaflet /usr/share/nginx/html/leaflet
COPY images /usr/share/nginx/html/images
COPY watcher.py /usr/share/nginx/html/watcher.py

EXPOSE 80
