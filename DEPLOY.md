# Deploying to Railway

This packages the whole toolkit into one container: the Node backend serves the
built dashboard over HTTPS/WSS and drives Chromium **headless** for calls. You
log in to Google accounts on a **local** backend, export the saved session as a
`.zip`, and upload it to the live server. State persists to a mounted volume.

## What's in the image
- `Dockerfile` (root) - multi-stage: builds `outbound-ui`, then runs on the
  Playwright image (Chromium + deps preinstalled) plus `tini`. No Xvfb/VNC, so
  the build is fast.
- `start.sh` - just `exec node server.js` (the backend serves the dashboard +
  `/control` and `/audio` WebSockets).
- `railway.json` - tells Railway to build the Dockerfile and healthcheck `/health`.
- `HOSTED=true` (baked into the image) switches the dashboard to "upload session"
  mode: Google login is local-only, and the Accounts tab shows **Import session**.

## One-time setup
1. Create a Railway project from this repo (Railway auto-detects `railway.json` /
   `Dockerfile`).
2. Add a **Volume** and mount it at `/data` (the image sets `DATA_DIR=/data`).
   This holds `profiles/`, `accounts.json`, `call-history.json`, `settings.json`
   so uploaded sessions and history survive redeploys.
3. Set service **Variables**:

   | Variable | Required | Notes |
   |----------|----------|-------|
   | `DASHBOARD_PASSWORD` | yes | Password to open the dashboard. Without it, auth is OFF. |
   | `OPENAI_API_KEY` | yes | Live transcription + intent. |
   | `PROXY_ENABLED` | yes | `true` - keep proxy on for residential egress. |
   | `NODEMAVEN_USER` / `NODEMAVEN_PASS` | yes | NodeMaven creds (use the SAME ones you logged in with locally). |
   | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | optional | Notifications. |
   | `HOSTED` | preset | `true` (login local-only; import sessions). |
   | `DATA_DIR` | preset | `/data` (matches the volume mount). |
   | `STEALTH_CHANNEL` | preset | `bundled` (no system Chrome on Linux). |
   | `INJECT_MICLESS` | preset | `true` - send only the injected WAV. |
   | `PORT` | auto | Injected by Railway; the server binds it on `0.0.0.0`. |

   (`HOSTED`, `DATA_DIR`, `STEALTH_CHANNEL`, `INJECT_MICLESS`,
   `PROXY_USE_BUNDLED_CHROMIUM` are baked into the Dockerfile as defaults.)
4. Deploy, then open the Railway-provided URL and sign in with `DASHBOARD_PASSWORD`.

## Moving your Google sessions to the server
Log in locally, then upload — the server never opens a browser for login.

1. **Local:** run the backend on your PC (`cd call-backend && npm start`) with
   `PROXY_ENABLED=true` and your NodeMaven creds in `.env`. Open the local UI,
   go to **Accounts**, and **Log in** to each Google account (a Chromium window
   opens on your desktop). Logging in through the proxy ties the session to the
   account's residential pool.
2. **Local:** on each card click **Export session** (or **Export all** in the
   header to grab every account in one `.zip`). Cache is stripped, so a multi-
   hundred-MB profile exports as well under ~1 MB.
3. **Live:** open the Railway URL, sign in, go to **Accounts** -> **Import
   session**, and pick the `.zip`. The account(s) + profile(s) are restored to
   the `/data` volume and are immediately callable. Re-importing replaces the
   stored session, so you can refresh a login the same way later.

## Running calls
- Campaigns run the imported accounts in parallel (each is a full headless
  Chromium) through their assigned residential IPs.

## Caveats
- Automating Google Voice from a datacenter (even via residential proxy) can
  trip Google's bot-detection and may violate Google's ToS; account challenges
  or bans are possible. Using the same NodeMaven account/region locally and on
  the server keeps the egress IP in the same residential pool (sticky IPs can
  still drift over days).
- Each parallel account is a full Chromium (~hundreds of MB of RAM). Pick a
  Railway plan with enough RAM, or limit how many accounts run at once.
- The dashboard shell loads openly so it can show the login screen; the control
  plane (`/control`, `/audio`, `/api/*`) is gated by the password cookie.

## Local dev (unchanged)
- Backend: `cd call-backend && npm install && npm start` (no `DASHBOARD_PASSWORD`
  => auth off, binds `0.0.0.0:8787`). `HOSTED` is unset => headed login + export.
- UI: `cd outbound-ui && npm install && npm run dev` (talks to `127.0.0.1:8787`).
