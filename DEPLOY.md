# Deploying to Railway

This packages the whole toolkit into one container: the Node backend serves the
built dashboard over HTTPS/WSS, drives Chromium on a virtual display (Xvfb), and
exposes the cloud browser through an authenticated noVNC view so you can log in
to Google accounts remotely. State persists to a mounted volume.

## What's in the image
- `Dockerfile` (root) - multi-stage: builds `outbound-ui`, then runs on the
  Playwright image (Chromium + deps preinstalled) plus `xvfb`, `x11vnc`,
  `novnc`, `websockify`, `tini`.
- `start.sh` - boots Xvfb `:99` -> x11vnc (localhost:5900) -> websockify+noVNC
  (localhost:6080) -> `node server.js`.
- `railway.json` - tells Railway to build the Dockerfile and healthcheck `/health`.

## One-time setup
1. Create a Railway project from this repo (Railway auto-detects `railway.json` /
   `Dockerfile`).
2. Add a **Volume** and mount it at `/data` (the image sets `DATA_DIR=/data`).
   This holds `profiles/`, `accounts.json`, `call-history.json`, `settings.json`
   so logins and history survive redeploys.
3. Set service **Variables**:

   | Variable | Required | Notes |
   |----------|----------|-------|
   | `DASHBOARD_PASSWORD` | yes | Password to open the dashboard. Without it, auth is OFF. |
   | `OPENAI_API_KEY` | yes | Live transcription + intent. |
   | `PROXY_ENABLED` | yes | `true` - keep proxy on for residential egress. |
   | `NODEMAVEN_USER` / `NODEMAVEN_PASS` | yes | NodeMaven creds. |
   | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | optional | Notifications. |
   | `DATA_DIR` | preset | `/data` (matches the volume mount). |
   | `STEALTH_CHANNEL` | preset | `bundled` (no system Chrome on Linux). |
   | `INJECT_MICLESS` | preset | `true` - send only the injected WAV. |
   | `PORT` | auto | Injected by Railway; the server binds it on `0.0.0.0`. |

   (`DATA_DIR`, `STEALTH_CHANNEL`, `INJECT_MICLESS`, `PROXY_USE_BUNDLED_CHROMIUM`
   are baked into the Dockerfile as defaults; override only if needed.)
4. Deploy, then open the Railway-provided URL and sign in with `DASHBOARD_PASSWORD`.

## Logging in Google accounts (remote)
1. Accounts tab -> **Add Google account** (or **Log in** / **Open browser** on a
   card). A **Remote browser** window opens - this is the real cloud Chromium
   rendered over noVNC.
2. Complete the Google sign-in there. The session is saved to the volume and
   reused for calls. Keep the NodeMaven proxy on so Google sees a residential IP.

## Running calls
- Campaigns run the logged-in accounts in parallel (each is a full Chromium).
  Use the headless/visible toggle as desired - on the server "visible" simply
  renders onto Xvfb (viewable via the Remote browser window).

## Caveats
- Automating Google Voice from a datacenter (even via residential proxy) can
  trip Google's bot-detection and may violate Google's ToS; account challenges
  or bans are possible.
- Each parallel account is a full Chromium (~hundreds of MB). Pick a Railway
  plan with enough RAM, or limit how many accounts you run at once.
- The dashboard shell loads openly so it can show the login screen; the control
  plane (`/control`, `/audio`, `/vnc`) is gated by the password cookie.

## Local dev (unchanged)
- Backend: `cd call-backend && npm install && npm start` (no `DASHBOARD_PASSWORD`
  => auth off, binds `0.0.0.0:8787`).
- UI: `cd outbound-ui && npm install && npm run dev` (talks to `127.0.0.1:8787`).
