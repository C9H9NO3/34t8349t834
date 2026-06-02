# Single-service image for Railway: the Node backend serves the built dashboard
# and drives Chromium (headed, on a virtual Xvfb display so accounts can be
# logged in remotely through an embedded noVNC view).

# ---- Stage 1: build the React dashboard ---------------------------------- #
FROM node:20-bookworm-slim AS ui
WORKDIR /ui
COPY outbound-ui/package.json outbound-ui/package-lock.json ./
RUN npm ci
COPY outbound-ui/ ./
RUN npm run build

# ---- Stage 2: runtime (Playwright image already has Chromium + deps) ------ #
FROM mcr.microsoft.com/playwright:v1.47.0-jammy AS runtime

# Virtual display + VNC bridge so the headed Google login is viewable remotely.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       xvfb x11vnc novnc websockify tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DISPLAY=:99 \
    DATA_DIR=/data \
    STEALTH_CHANNEL=bundled \
    INJECT_MICLESS=true \
    PROXY_USE_BUNDLED_CHROMIUM=true

WORKDIR /app

# Backend deps (Chromium binaries are already provided by the base image).
COPY call-backend/package.json call-backend/package-lock.json ./
RUN npm ci --omit=dev

# Backend source + the built dashboard it serves from ./public.
COPY call-backend/ ./
COPY --from=ui /ui/dist ./public

# Persistent state (profiles, accounts.json, call-history.json, settings.json)
# lives here; mount a Railway volume at /data so it survives redeploys.
RUN mkdir -p /data

COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# tini reaps Xvfb/x11vnc/websockify/node child processes cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]
