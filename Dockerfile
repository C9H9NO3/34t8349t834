# Single-service image for Railway: the Node backend serves the built dashboard
# and drives Chromium headless for calls. Google login happens on a LOCAL
# backend; the saved session is exported and uploaded here (no display needed).

# ---- Stage 1: build the React dashboard ---------------------------------- #
FROM node:20-bookworm-slim AS ui
WORKDIR /ui
COPY outbound-ui/package.json outbound-ui/package-lock.json ./
RUN npm ci
COPY outbound-ui/ ./
RUN npm run build

# ---- Stage 2: runtime (Playwright image already has Chromium + deps) ------ #
FROM mcr.microsoft.com/playwright:v1.47.0-jammy AS runtime

# Calls run headless on the server (you log in to Google locally and upload the
# saved session), so no virtual display / VNC stack is needed - only tini to
# reap Chromium child processes. This keeps the image build fast.
# DEBIAN_FRONTEND=noninteractive ensures apt never blocks on a prompt (e.g. the
# tzdata "Geographic area" question that froze the old noVNC build).
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

# HOSTED=true switches the dashboard to "upload session" mode (login is local-only).
ENV NODE_ENV=production \
    HOSTED=true \
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

# tini (PID 1) reaps the Chromium child processes Playwright spawns.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start.sh"]
