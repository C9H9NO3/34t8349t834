// Local control server for Google Voice call automation.
//
// - WebSocket /control : the dashboard connects here (commands in, events out)
// - WebSocket /audio   : the tabCapture extension streams PCM16 call audio here
//
// ISOLATION: all call state (browser session, transcriber, mute window,
// transcript listeners, and flow state) is per-account, kept in a `runtimes`
// map keyed by account id. Multiple automated flows run in parallel with zero
// overlap. A campaign dispatcher feeds a lead queue across all logged-in
// sessions. Binds to localhost only.

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import express from "express";
import { WebSocketServer } from "ws";
import { config, persistenceInfo } from "./config.js";
import {
  authEnabled,
  checkPassword,
  requireAuth,
  requestAuthorized,
  buildAuthCookie,
} from "./auth.js";
import * as gv from "./playwrightController.js";
import * as accounts from "./accounts.js";
import { listLocations } from "./usLocations.js";
import { createTranscriber } from "./stt.js";
import { classifyIntent } from "./intent.js";
import { createDtmfDetector } from "./dtmf.js";
import { sendTelegram, setNotifyLogger, telegramConfigured, configureTelegram } from "./notify.js";
import { setBridgeLogger } from "./proxyBridge.js";
import { CampaignManager } from "./campaign.js";
import * as callHistory from "./callHistory.js";
import { canonicalCategory } from "./outcomes.js";
import * as settings from "./settings.js";
import * as sessionBundle from "./sessionBundle.js";

// Apply persisted runtime settings (e.g. Telegram creds) over .env defaults.
settings.load();

const app = express();
app.use(express.json());

// Open, unauthenticated: Railway healthcheck.
app.get("/health", (_req, res) => res.json({ ok: true }));

// Lets the dashboard decide whether to show the login screen.
app.get("/api/auth-status", (req, res) =>
  res.json({ authEnabled: authEnabled(), authorized: requestAuthorized(req) })
);

// Exchanges the shared password for an httpOnly auth cookie.
app.post("/auth", (req, res) => {
  if (!authEnabled()) return res.json({ ok: true, authDisabled: true });
  if (checkPassword(req.body && req.body.password)) {
    res.setHeader("Set-Cookie", buildAuthCookie(req));
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "wrong password" });
});

// ---- Session bundles: log in locally, move the saved session to the server.
// Export downloads a zip (account record + Chromium profile, caches stripped);
// import restores it on the (headless) host. Both require auth when enabled.

// One account -> .zip download.
app.get("/api/session/:id/export", requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    // Capture the PORTABLE login (decrypted cookies + localStorage) from the
    // running local context FIRST - this is what survives the move to the
    // Linux server (the raw Cookies DB is OS-encrypted and won't). Then close
    // to release Windows file locks (Chromium keeps the SQLite stores open).
    let state = null;
    try {
      state = await gv.exportStorageState(id);
    } catch (err) {
      log(`Export warning: could not read login state for "${(accounts.get(id) || {}).label || id}" (${err.message}). The zip may not stay logged in - log in locally first.`);
    }
    await gv.closeAccount(id).catch(() => {});
    if (state && (!Array.isArray(state.cookies) || state.cookies.length === 0)) {
      log(`Export warning: no cookies captured for "${(accounts.get(id) || {}).label || id}" - this account may not be logged in locally.`);
    }
    const buf = sessionBundle.buildSingle(id, state);
    const acct = accounts.get(id);
    const safe = ((acct && acct.label) || id).replace(/[^a-z0-9._-]+/gi, "_").slice(0, 40);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="gv-${safe}-${id.slice(0, 8)}.zip"`);
    res.send(buf);
    log(`Exported session "${(acct && acct.label) || id}" (${(buf.length / 1048576).toFixed(1)} MB).`);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// All accounts -> one .zip ("export all" so a full set moves in one round-trip).
app.get("/api/session/export-all", requireAuth, async (req, res) => {
  try {
    // Capture each account's portable login before closing its context.
    const states = {};
    for (const a of accounts.list()) {
      try {
        states[a.id] = await gv.exportStorageState(a.id);
      } catch (err) {
        log(`Export-all warning: no login state for "${a.label || a.id}" (${err.message}).`);
      }
      await gv.closeAccount(a.id).catch(() => {});
    }
    const buf = sessionBundle.buildAll(states);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="gv-sessions-all.zip"`);
    res.send(buf);
    log(`Exported all sessions (${(buf.length / 1048576).toFixed(1)} MB).`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live PNG of what the account's (headless) browser is currently showing -
// the debug tool for "why didn't the dialer appear" (login screen? consent?).
app.get("/api/session/:id/screenshot", requireAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const { buf, url, loggedIn } = await gv.screenshot(id);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Page-Url", encodeURIComponent(url || ""));
    res.setHeader("X-Logged-In", loggedIn ? "1" : "0");
    res.send(buf);
    log(`Captured ${(accounts.get(id)?.label) || id} screen — ${loggedIn ? "logged in" : "NOT logged in"} (${url}).`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload a bundle (raw zip body) -> restore account(s) + profile(s) on this host.
app.post(
  "/api/session/import",
  requireAuth,
  express.raw({ type: "*/*", limit: "500mb" }),
  async (req, res) => {
    try {
      const { restored, count } = sessionBundle.importBundle(req.body);
      const names = restored.map((r) => r.label).join(", ");
      log(`Imported ${count} session(s): ${names}. Ready to call.`);
      broadcast({ type: "accounts", accounts: accounts.list(), activeId: accounts.getActiveId() });
      await handlers.status();
      res.json({ ok: true, count, restored });
    } catch (err) {
      log(`Session import failed: ${err.message}`);
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

// Serve the built dashboard (single-service hosting). The shell loads openly so
// it can present the login screen; the control plane (WS, API) stays gated.
if (fs.existsSync(config.distDir)) {
  app.use(express.static(config.distDir));
  app.get("*", (req, res, next) => {
    const p = req.path;
    if (
      p.startsWith("/control") ||
      p.startsWith("/audio") ||
      p.startsWith("/api") ||
      p === "/auth" ||
      p === "/health"
    ) {
      return next();
    }
    res.sendFile(path.join(config.distDir, "index.html"));
  });
}

const server = http.createServer(app);
const controlWss = new WebSocketServer({ noServer: true });
const audioWss = new WebSocketServer({ noServer: true });

const controlClients = new Set();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of controlClients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}
const log = (message) => broadcast({ type: "log", message });

// Masks a Telegram chat id for display (keep last 3 digits).
function maskChatId(id) {
  const s = String(id || "");
  if (!s) return "";
  return s.length <= 3 ? s : `…${s.slice(-3)}`;
}

// ---- Per-session runtime (transcription + flow state) -------------------- //
// One runtime per account id. Nothing here is shared between accounts, which
// is what guarantees parallel flows never overlap.
const runtimes = new Map();

function getRuntime(id) {
  let rt = runtimes.get(id);
  if (!rt) {
    const acct = accounts.get(id);
    rt = {
      id,
      label: (acct && acct.label) || id.slice(0, 8),
      transcriber: null,
      muteUntil: 0,
      audioConnected: false,
      captureTimer: null,
      lastFrameLog: 0,
      transcriptListeners: new Set(),
      dtmfDetector: null,
      flowRunning: false,
      flowCancelled: false,
      flowAbort: null,
      flowPromise: null,
      state: { call: "idle", number: null, audio: "idle", flowStep: "" },
    };
    runtimes.set(id, rt);
  }
  return rt;
}

function publicSessionState(rt) {
  return {
    id: rt.id,
    label: rt.label,
    call: rt.state.call,
    number: rt.state.number,
    audio: rt.state.audio,
    flowStep: rt.state.flowStep,
    audioCapture: rt.audioConnected,
    flowRunning: rt.flowRunning,
  };
}

function setSessionState(rt, patch) {
  rt.state = { ...rt.state, ...patch };
  broadcast({ type: "sessionStatus", id: rt.id, state: publicSessionState(rt) });
}

function setFlowStep(rt, step) {
  rt.state.flowStep = step;
  broadcast({ type: "sessionStatus", id: rt.id, state: publicSessionState(rt) });
  log(`[${rt.label}] ${step}`);
}

function broadcastSessions() {
  broadcast({
    type: "sessions",
    sessions: Array.from(runtimes.values()).map(publicSessionState),
  });
}

function muteTranscriptFor(rt, ms) {
  const until = Date.now() + Math.max(0, ms | 0);
  if (until > rt.muteUntil) rt.muteUntil = until;
}

function setAudioCapture(rt, on) {
  if (rt.audioConnected !== on) {
    rt.audioConnected = on;
    broadcast({ type: "sessionAudio", id: rt.id, connected: on });
  }
}

function markAudioActivity(rt) {
  setAudioCapture(rt, true);
  if (rt.captureTimer) clearTimeout(rt.captureTimer);
  rt.captureTimer = setTimeout(() => setAudioCapture(rt, false), 3000);
}

function endCapture(rt) {
  if (rt.captureTimer) {
    clearTimeout(rt.captureTimer);
    rt.captureTimer = null;
  }
  setAudioCapture(rt, false);
  rt.muteUntil = 0;
  if (rt.transcriber) {
    rt.transcriber.close();
    rt.transcriber = null;
  }
}

function onTranscript(rt, text) {
  for (const fn of rt.transcriptListeners) {
    try {
      fn(text);
    } catch {
      /* ignore */
    }
  }
}

function ensureTranscriber(rt) {
  if (rt.transcriber) return rt.transcriber;
  rt.transcriber = createTranscriber({
    onPartial: (text) => broadcast({ type: "sessionTranscript", id: rt.id, kind: "partial", text }),
    onFinal: (text) => {
      broadcast({ type: "sessionTranscript", id: rt.id, kind: "final", text });
      onTranscript(rt, text);
    },
    onLog: (m) => log(`[${rt.label}] ${m}`),
  });
  return rt.transcriber;
}

function pushCaptureAudio(id, b64) {
  if (!b64) return;
  const rt = getRuntime(id);
  markAudioActivity(rt);
  // DTMF (Testing-tab keypress trigger): only runs while a listen window has
  // attached a detector, so the normal voice path is untouched. Fed BEFORE the
  // transcript-mute return below - our injected WAVs contain no tones, so
  // running it during playback/echo-tail only helps catch early presses.
  if (rt.dtmfDetector) {
    try {
      rt.dtmfDetector.pushPcm16(Buffer.from(b64, "base64"));
    } catch {
      /* ignore decode errors */
    }
  }
  // Drop frames while our own injected audio is playing (+ echo tail) so the
  // greeting never lands in the transcript. The badge stays "listening".
  if (Date.now() < rt.muteUntil) return;
  ensureTranscriber(rt).pushAudio(b64);
  const now = Date.now();
  if (now - rt.lastFrameLog > 8000) {
    rt.lastFrameLog = now;
    log(`[${rt.label}] receiving call audio…`);
  }
}

// Wire the in-page capture bindings, now keyed by session id so each session's
// audio reaches only its own transcriber.
gv.setAudioHandlers({
  onAudio: (id, b64) => pushCaptureAudio(id, b64),
  onState: (id, s) => {
    const rt = getRuntime(id);
    if (s === "capture-ready") log(`[${rt.label}] capture armed on the call tab.`);
    else if (s === "track") log(`[${rt.label}] call audio track detected — transcribing.`);
    else if (s === "capture-idle" || s === "track-ended") {
      endCapture(rt);
    }
  },
  onLog: (id, m) => log(`[${getRuntime(id).label}] capture: ${m}`),
});

gv.setLogger((message) => log(message));
setNotifyLogger((message) => log(message));
setBridgeLogger((message) => log(message));

// ---- Command handlers ---------------------------------------------------- //
const handlers = {
  async status() {
    const activeId = gv.activeAccountId() || accounts.getActiveId();
    let activeLoggedIn = false;
    if (activeId) {
      try {
        activeLoggedIn = await gv.isLoggedIn(activeId);
      } catch {
        /* browser not open yet */
      }
    }
    broadcast({
      type: "status",
      accounts: accounts.list(),
      activeId,
      loggedIn: activeLoggedIn,
      stt: Boolean(config.openaiApiKey),
      headless: gv.isHeadless(),
      hosted: Boolean(config.hosted),
      persistence: persistenceInfo(),
      proxyEnabled: Boolean(config.proxy && config.proxy.enabled),
      telegram: telegramConfigured(),
      telegramChatId: maskChatId(config.telegram.chatId),
      campaign: campaign.progress(),
    });
    broadcastSessions();
  },

  async setHeadless({ headless }) {
    await gv.setHeadless(headless);
    await handlers.status();
  },

  listAccounts() {
    broadcast({ type: "accounts", accounts: accounts.list(), activeId: gv.activeAccountId() || accounts.getActiveId() });
  },

  async addAccount({ label, phoneNumber, note }) {
    const acct = accounts.add({ label, phoneNumber, note });
    const loc = acct.proxy ? ` Assigned ${acct.proxy.city}, ${acct.proxy.region} (residential IP).` : "";
    if (config.hosted) {
      log(`Added account "${acct.label}".${loc} Login is local-only — log in on a local backend, then Import the session here.`);
      await handlers.status();
      return;
    }
    log(`Added account "${acct.label}".${loc} Opening Chromium window on your desktop...`);
    await handlers.status();
    try {
      const r = await gv.login(acct.id);
      log(r.message);
    } catch (err) {
      log(`Login failed: ${err.message}`);
      log("If Chromium is missing, run: npx playwright install chromium");
    }
    await handlers.status();
  },

  async removeAccount({ id }) {
    // Tear down the browser + proxy bridge first, otherwise the orphaned
    // Chromium keeps loading pages through the bridge and floods the log.
    try {
      await gv.closeAccount(id);
    } catch {
      /* ignore */
    }
    const rt = runtimes.get(id);
    if (rt) {
      endCapture(rt);
      runtimes.delete(id);
    }
    accounts.remove(id);
    log("Account removed.");
    await handlers.status();
  },

  async selectAccount({ id }) {
    // Selection is a lightweight target hint only - it must NOT launch a
    // browser. Every account stays independently usable; the browser opens
    // lazily when an action (Open browser / dial / flow) actually needs it.
    gv.setForeground(id);
    accounts.setActiveId(id);
    await handlers.status();
  },

  async setAccountLocation({ id, region, city }) {
    const acct = accounts.setLocation(id, { region, city });
    if (!acct) {
      return log("Could not set location (invalid state/city or unknown account).");
    }
    log(
      `Assigned ${[acct.proxy.city, acct.proxy.region].filter(Boolean).join(", ")} to "${acct.label}" (new residential IP).`
    );
    if (gv.getSession(id)) {
      log("Reopening browser to apply the new location…");
      try {
        await gv.closeAccount(id);
        await gv.showBrowser(id);
      } catch (err) {
        log(`Reopen failed: ${err.message}`);
      }
    }
    broadcast({
      type: "accounts",
      accounts: accounts.list(),
      activeId: gv.activeAccountId() || accounts.getActiveId(),
    });
    await handlers.status();
  },

  async rotateProxy({ id }) {
    const acct = accounts.rotateProxy(id);
    if (!acct) return log("Could not rotate IP (unknown account).");
    const where = [acct.proxy?.city, acct.proxy?.region].filter(Boolean).join(", ") || "random US";
    log(`Rotating residential IP for "${acct.label}" — new sticky session in ${where}.`);
    // If a window is already open, reopen it so the new IP/bridge takes effect.
    // Otherwise leave it closed (it opens lazily with the new IP on next use).
    if (gv.getSession(id)) {
      try {
        await gv.closeAccount(id);
        await gv.openAccount(id);
      } catch (err) {
        log(`Reopen after rotate failed: ${err.message}`);
      }
    }
    broadcast({
      type: "accounts",
      accounts: accounts.list(),
      activeId: gv.activeAccountId() || accounts.getActiveId(),
    });
    await handlers.status();
  },

  async setAccountNumber({ id, phoneNumber }) {
    const acct = accounts.update(id, { phoneNumber: (phoneNumber || "").trim() });
    if (!acct) return log("Could not update number (unknown account).");
    log(`Updated display number for "${acct.label}" to ${acct.phoneNumber || "(none)"}.`);
    broadcast({
      type: "accounts",
      accounts: accounts.list(),
      activeId: gv.activeAccountId() || accounts.getActiveId(),
    });
    await handlers.status();
  },

  async loginAccount({ id }) {
    if (config.hosted) {
      return log("Login is local-only on the hosted server. Log in on a local backend, then upload the session (Import) here.");
    }
    const targetId = id || gv.activeAccountId() || accounts.getActiveId();
    if (!targetId) return log("No account selected.");
    log("Opening Chromium window on your desktop...");
    try {
      const r = await gv.login(targetId);
      log(r.message);
      broadcast({ type: "loginResult", id: targetId, loggedIn: r.loggedIn, message: r.message });
    } catch (err) {
      const error = err.message;
      log(`Login failed: ${error}`);
      log("If Chromium is missing, run: npx playwright install chromium");
      broadcast({ type: "loginResult", id: targetId, loggedIn: false, error });
    }
    await handlers.status();
  },

  async captureCallUI() {
    try {
      const r = await gv.captureCallUI();
      log(`Captured ${r.count} elements from ${r.url} -> ${r.file}`);
    } catch (err) {
      log(`Capture failed: ${err.message}`);
    }
  },

  async showBrowser({ id } = {}) {
    if (config.hosted) {
      return log("Opening a browser window isn't available on the hosted server (calls run headless). Use a local backend to log in.");
    }
    try {
      const r = await gv.showBrowser(id);
      log(`Opened browser at ${r.url}`);
      await handlers.status();
    } catch (err) {
      log(`Show browser failed: ${err.message}`);
    }
  },

  async checkProxy({ id } = {}) {
    const { proxyStatus, proxyMode } = await import("./proxy.js");
    const st = proxyStatus();
    if (!st.ok) return log(`Proxy off: ${st.reason}`);
    const targetId = id || gv.activeAccountId() || accounts.getActiveId();
    if (!targetId) return log("No account selected.");
    try {
      const session = await gv.openAccount(targetId);
      const acct = accounts.get(targetId);
      const assigned = acct && acct.proxy ? `${acct.proxy.region}/${acct.proxy.city}` : "n/a";
      log(`Checking egress IP via ${proxyMode()} (assigned ${assigned})…`);
      const info = await session.checkProxyIp();
      log(
        `Egress IP: ${info.ip || "?"} — ${[info.city, info.region, info.country].filter(Boolean).join(", ")}` +
          (info.org ? ` (${info.org})` : "")
      );
      broadcast({
        type: "proxyResult",
        id: targetId,
        ok: true,
        ip: info.ip || "",
        city: info.city || "",
        region: info.region || "",
        country: info.country || "",
        org: info.org || "",
      });
    } catch (err) {
      const tunnel = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_NO_SUPPORTED_PROXIES|tunnel/i.test(err.message);
      const error = tunnel
        ? `Proxy tunnel could not be established. Verify NodeMaven creds/allowlist, or try PROXY_USE_SOCKS5=true. (${err.message})`
        : err.message;
      log(`Check IP failed: ${error}`);
      broadcast({ type: "proxyResult", id: targetId, ok: false, error });
    }
  },

  // ---- Manual single-call console (operates on the foreground account) ----
  async dial({ number, id: providedId }) {
    if (!number) return log("dial: no number provided");
    const id = providedId || gv.activeAccountId() || accounts.getActiveId();
    if (!id) return log("No account selected. Add/select an account first.");
    const session = await gv.openAccount(id);
    const rt = getRuntime(id);
    broadcast({ type: "sessionClearTranscript", id });
    setSessionState(rt, { call: "dialing", number });
    try {
      await session.dial(number);
      const started = await session.confirmCallStarted(8000);
      if (!started) {
        setSessionState(rt, { call: "failed", number: null });
        log(`[${rt.label}] dial failed: call did not start for ${number}.`);
        await handlers.status();
        return;
      }
      setSessionState(rt, { call: "ringing", number });
      accounts.bumpStat(id, "calls");
      log(`[${rt.label}] dialing ${number}`);
      await handlers.status();
    } catch (err) {
      setSessionState(rt, { call: "idle", number: null });
      log(`[${rt.label}] dial failed: ${err.message}`);
    }
  },

  async playAudio({ id } = {}) {
    const fg = targetSession(id);
    if (!fg) return log("No active account.");
    setSessionState(fg.rt, { audio: "playing" });
    try {
      const r = await fg.session.playInjectedAudio();
      muteTranscriptFor(fg.rt, Math.ceil((r?.durationSec || 3) * 1000) + config.flow.echoMuteTailMs);
    } catch (err) {
      log(`Audio error: ${err.message}`);
    }
    setSessionState(fg.rt, { audio: "idle" });
  },

  async stopAudio({ id } = {}) {
    const fg = targetSession(id);
    if (!fg) return;
    try {
      await fg.session.stopInjectedAudio();
    } catch (err) {
      log(`Stop audio error: ${err.message}`);
    }
    fg.rt.muteUntil = 0;
    setSessionState(fg.rt, { audio: "idle" });
  },

  async hangup({ id } = {}) {
    const fg = targetSession(id);
    if (!fg) return;
    await fg.session.stopInjectedAudio().catch(() => {});
    fg.rt.muteUntil = 0;
    const r = await fg.session.hangup();
    setSessionState(fg.rt, { call: "idle", number: null, audio: "idle" });
    endCapture(fg.rt);
    log(r.hungUp ? `[${fg.rt.label}] call ended.` : `Hang up: ${r.error || "n/a"}`);
  },

  async startFlow({ number, name, email, id: providedId, triggerMode }) {
    if (!number) return log("startFlow: no number provided");
    const id = providedId || gv.activeAccountId() || accounts.getActiveId();
    if (!id) return log("No account selected. Add/select an account first.");
    const rt = getRuntime(id);
    if (rt.flowRunning) {
      log(`[${rt.label}] a flow is still running — force-stopping it before starting fresh.`);
      rt.flowCancelled = true;
      if (rt.flowAbort) rt.flowAbort.abort();
      if (rt.flowPromise) await rt.flowPromise.catch(() => {});
    }
    const session = await gv.openAccount(id);
    rt.flowPromise = runFlow(session, rt, number, { name, email }, { triggerMode });
  },

  async stopFlow({ id } = {}) {
    const fg = targetSession(id);
    if (!fg) return;
    await stopRuntimeFlow(fg.rt, fg.session);
    setFlowStep(fg.rt, "cancelled");
  },

  // ---- Campaign (parallel queue across all logged-in accounts) ----
  async startCampaign({ leads, count, accountIds, triggerMode, recallCategories }) {
    if (campaign.isRunning()) return log("A campaign is already running.");
    const list = Array.isArray(leads) ? leads.filter((l) => l && l.number) : [];
    if (list.length === 0) return log("Campaign: no leads provided.");

    // Skip numbers whose last concluded outcome is in a category NOT selected
    // for re-call. Never-called numbers (no history) are always eligible. When
    // recallCategories is omitted, nothing is skipped (back-compat).
    const includeSet = Array.isArray(recallCategories) ? new Set(recallCategories) : null;
    let skipped = 0;
    const eligible = [];
    for (const lead of list) {
      if (includeSet) {
        const entry = callHistory.get(lead.number);
        if (entry && !includeSet.has(entry.category)) {
          skipped++;
          broadcast({
            type: "leadStatus",
            number: lead.number,
            name: lead.name || "",
            status: "skipped",
            category: entry.category,
            reason: entry.reason || "",
          });
          continue;
        }
      }
      eligible.push(lead);
    }
    if (skipped) log(`Skipped ${skipped} already-concluded number(s) by category.`);
    const limited = count > 0 ? eligible.slice(0, count) : eligible;
    if (limited.length === 0) {
      return log(
        skipped ? "Campaign: every number was skipped by category selection." : "Campaign: no leads provided."
      );
    }

    // Restrict to the chosen accounts when provided; otherwise use all (then
    // filtered to logged-in below). Empty/missing selection => all accounts.
    const all = accounts.list();
    const chosen =
      Array.isArray(accountIds) && accountIds.length
        ? all.filter((a) => accountIds.includes(a.id))
        : all;

    log(`Campaign: opening ${chosen.length} account(s) and checking logins for ${limited.length} numbers…`);
    const workerIds = [];
    for (const acct of chosen) {
      try {
        await gv.openAccount(acct.id);
        if (await gv.isLoggedIn(acct.id)) workerIds.push(acct.id);
        else log(`Skipping "${acct.label}" — not logged in.`);
      } catch (err) {
        log(`Skipping "${acct.label}" — ${err.message}`);
      }
    }
    if (workerIds.length === 0) {
      return log("Campaign aborted: no logged-in accounts available.");
    }

    const runWorker = async (workerId, lead) => {
      const session = await gv.openAccount(workerId);
      const rt = getRuntime(workerId);
      return runFlow(session, rt, lead.number, { name: lead.name, email: lead.email }, { triggerMode });
    };
    try {
      campaign.start({ leads: limited, workerIds, runWorker });
    } catch (err) {
      log(`Campaign error: ${err.message}`);
    }
    await handlers.status();
  },

  async stopCampaign() {
    campaign.stop();
    // Tear down any in-flight calls across all sessions.
    for (const rt of runtimes.values()) {
      if (rt.flowRunning) {
        const session = gv.getSession(rt.id);
        await stopRuntimeFlow(rt, session);
      }
    }
    await handlers.status();
  },

  // ---- Settings: Telegram credentials (set from the Settings tab) ----
  async setTelegram({ botToken, chatId }) {
    configureTelegram({ botToken, chatId });
    settings.saveTelegram({ botToken: config.telegram.botToken, chatId: config.telegram.chatId });
    log(`Telegram credentials updated (chat ${maskChatId(config.telegram.chatId) || "auto"}).`);
    await handlers.status();
  },

  async testTelegram() {
    if (!telegramConfigured()) {
      broadcast({ type: "telegramResult", ok: false, error: "No bot token set." });
      return;
    }
    const ok = await sendTelegram("Test notification from Call Toolkit ✅");
    broadcast({
      type: "telegramResult",
      ok,
      error: ok ? null : "Send failed - check token/chat id (message the bot once if chat id is blank).",
    });
    log(ok ? "Telegram test message sent." : "Telegram test failed.");
  },

  // ---- Call history (per-number outcomes) ----
  getCallHistory() {
    broadcast({ type: "callHistory", entries: callHistory.all() });
  },

  clearCallHistory({ category } = {}) {
    const n = category ? callHistory.clearCategory(category) : callHistory.clear();
    log(category ? `Cleared ${n} "${category}" call-history entr${n === 1 ? "y" : "ies"}.` : `Cleared all ${n} call-history entries.`);
    broadcast({ type: "callHistory", entries: callHistory.all() });
  },
};

// Resolves the foreground session + its runtime, or null.
function fgSession() {
  const id = gv.activeAccountId() || accounts.getActiveId();
  if (!id) return null;
  const session = gv.getSession(id);
  if (!session) return null;
  return { session, rt: getRuntime(id) };
}

// Resolves a session by explicit account id (from the Testing tab), falling
// back to the foreground session when no id is given.
function targetSession(id) {
  if (!id) return fgSession();
  const session = gv.getSession(id);
  if (!session) return null;
  return { session, rt: getRuntime(id) };
}

// Cancels a runtime's running flow and tears the call down immediately.
async function stopRuntimeFlow(rt, session) {
  rt.flowCancelled = true;
  if (rt.flowAbort) rt.flowAbort.abort();
  log(`[${rt.label}] flow stop requested — cancelling…`);
  try {
    if (session) await session.stopInjectedAudio();
  } catch {
    /* ignore */
  }
  try {
    if (session) await session.hangup();
  } catch {
    /* ignore */
  }
  setSessionState(rt, { call: "idle", number: null, audio: "idle" });
  endCapture(rt);
  if (rt.flowPromise) await rt.flowPromise.catch(() => {});
}

// ---- Intent listening ----------------------------------------------------- //
function cancellableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", done);
      resolve();
    }
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

// Listens to a session's FINAL transcripts for up to windowMs and classifies
// intent. Resolves early on a definite label. Returns { intent, text } where
// intent is callback | no_callback | call_screening | wrong_number | unclear |
// silence | aborted.
function listenForIntent(rt, windowMs, signal) {
  return new Promise((resolve) => {
    let acc = "";
    let lastLen = 0;
    let classifying = false;
    let done = false;
    const DEFINITE = new Set(["callback", "no_callback", "call_screening", "wrong_number"]);

    const finish = (intent, text) => {
      if (done) return;
      done = true;
      rt.transcriptListeners.delete(listener);
      if (signal) signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve({ intent, text: (text || "").trim() });
    };

    async function maybeClassify() {
      if (classifying || done) return;
      const cur = acc.trim();
      if (cur.length < 2 || cur.length === lastLen) return;
      lastLen = cur.length;
      classifying = true;
      const r = await classifyIntent(cur, signal).catch(() => ({ intent: "unclear" }));
      classifying = false;
      if (done) return;
      if (DEFINITE.has(r.intent)) {
        log(`[${rt.label}] [intent] ${r.intent}${r.reason ? ` (${r.reason})` : ""}: "${cur}"`);
        if (r.intent === "callback") broadcast({ type: "flowHeard", id: rt.id, text: cur });
        finish(r.intent, cur);
      }
    }

    const listener = (text) => {
      if (!text || done) return;
      acc += (acc ? " " : "") + text;
      maybeClassify();
    };
    const onAbort = () => finish("aborted", acc);

    rt.transcriptListeners.add(listener);
    if (signal) {
      if (signal.aborted) return finish("aborted", acc);
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => finish(acc.trim() ? "unclear" : "silence", acc), windowMs);
  });
}

// Unified reply listener: resolves on the FIRST of an accepted DTMF keypress, a
// definite voice intent, timeout, or abort - whichever lands first. Both paths
// are owned by one finish()/timer/abort so neither the transcript listener nor
// rt.dtmfDetector can leak between greeting replays, calls, or parallel sessions.
//
//   opts.voice : when true, accumulate FINAL transcripts and classify intent.
//   opts.dtmf  : an accept(digit) fn enabling DTMF detection (null/undefined off).
//
// Returns one of:
//   { via: "dtmf",   digit }          - accepted keypress
//   { via: "intent", intent, text }   - definite intent, or "unclear" on timeout
//   { via: "silence" }                - timeout with no speech / no key
//   { via: "aborted" }                - flow signal aborted
function listenForReply(rt, windowMs, signal, { voice = true, dtmf = null } = {}) {
  return new Promise((resolve) => {
    let acc = "";
    let lastLen = 0;
    let classifying = false;
    let done = false;
    const DEFINITE = new Set(["callback", "no_callback", "call_screening", "wrong_number"]);

    const finish = (result) => {
      if (done) return;
      done = true;
      if (voice) rt.transcriptListeners.delete(listener);
      if (dtmf) rt.dtmfDetector = null;
      if (signal) signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve(result);
    };

    // ---- Voice path ----
    async function maybeClassify() {
      if (classifying || done) return;
      const cur = acc.trim();
      if (cur.length < 2 || cur.length === lastLen) return;
      lastLen = cur.length;
      classifying = true;
      const r = await classifyIntent(cur, signal).catch(() => ({ intent: "unclear" }));
      classifying = false;
      if (done) return;
      if (DEFINITE.has(r.intent)) {
        log(`[${rt.label}] [intent] ${r.intent}${r.reason ? ` (${r.reason})` : ""}: "${cur}"`);
        if (r.intent === "callback") broadcast({ type: "flowHeard", id: rt.id, text: cur });
        finish({ via: "intent", intent: r.intent, text: cur });
      }
    }
    const listener = (text) => {
      if (!text || done) return;
      acc += (acc ? " " : "") + text;
      maybeClassify();
    };
    if (voice) rt.transcriptListeners.add(listener);

    // ---- DTMF path ----
    if (dtmf) {
      rt.dtmfDetector = createDtmfDetector({
        sampleRate: config.sttSampleRate,
        config: config.flow.dtmf,
        onDigit: (digit) => {
          // Always surface the key in the live transcript + log (test visibility).
          broadcast({ type: "sessionTranscript", id: rt.id, kind: "final", text: `key: ${digit}` });
          log(`[${rt.label}] [dtmf] key pressed: ${digit}`);
          if (!done && dtmf(digit)) finish({ via: "dtmf", digit });
        },
      });
    }

    const onAbort = () => finish({ via: "aborted" });
    if (signal) {
      if (signal.aborted) return finish({ via: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(
      () => finish(voice && acc.trim() ? { via: "intent", intent: "unclear", text: acc.trim() } : { via: "silence" }),
      windowMs
    );
  });
}

async function notifyClaimedLine(number, contact) {
  const name = (contact && contact.name) || "";
  const email = (contact && contact.email) || "";
  const msg =
    "✅ You have successfully claimed a line!\n\n" +
    `📞 Phone Number: +${number}\n` +
    `🔲 Raw Line: ${name} | ${email} | ${number} | `;
  const ok = await sendTelegram(msg);
  log(ok ? "Telegram: claimed-line notification sent." : "Telegram: notification not sent.");
}

// Outcome helpers (category consumed by the campaign dispatcher).
const uncallable = (reason) => ({ category: "uncallable", reason });
const noPickup = (reason) => ({ category: "no_pickup", reason });
const pickedUp = (reason) => ({ category: "picked_up", reason });

// ---- The automated flow (per session) ------------------------------------ //
// Returns an outcome { category, reason } so the campaign can mark the number:
//   uncallable | no_pickup | picked_up | declined | cancelled
async function runFlow(session, rt, number, contact = {}, opts = {}) {
  rt.flowRunning = true;
  rt.flowCancelled = false;
  rt.flowAbort = new AbortController();
  const signal = rt.flowAbort.signal;
  const f = config.flow;
  // Callback trigger mode (default "voice", so legacy/unspecified callers are
  // unchanged):
  //   voice   - spoken intent classification only
  //   dtmf1   - DTMF key "1" only
  //   dtmfAny - any DTMF key
  //   hybrid  - key "1" OR a spoken callback (whichever lands first)
  const ALLOWED_TRIGGERS = ["voice", "dtmf1", "dtmfAny", "hybrid"];
  const triggerMode = ALLOWED_TRIGGERS.includes(opts.triggerMode) ? opts.triggerMode : "voice";
  const useVoice = triggerMode === "voice" || triggerMode === "hybrid";
  const useDtmf = triggerMode === "dtmf1" || triggerMode === "dtmfAny" || triggerMode === "hybrid";
  const dtmfAccept = (d) => (triggerMode === "dtmfAny" ? true : d === "1");
  let endedByHangup = false;
  let hangupTimer = null;
  let callbackVia = null; // "dtmf" | "voice" - how a confirmed callback arrived
  let outcome = noPickup("no_answer");

  const stopHangupWatch = () => {
    if (hangupTimer) {
      clearInterval(hangupTimer);
      hangupTimer = null;
    }
  };
  const startHangupWatch = () => {
    if (hangupTimer) return;
    hangupTimer = setInterval(async () => {
      if (signal.aborted) return;
      try {
        const panel = await session.callPanelState();
        if (panel.found && !panel.active) {
          endedByHangup = true;
          stopHangupWatch();
          log(`[${rt.label}] call ended (hang up detected).`);
          rt.flowAbort.abort();
        }
      } catch {
        /* ignore transient eval errors */
      }
    }, 700);
  };
  const stopped = () => rt.flowCancelled || signal.aborted || endedByHangup;

  const watchdog = setTimeout(() => {
    if (!signal.aborted) {
      log(`[${rt.label}] flow exceeded ${f.maxFlowSec}s — forcing stop.`);
      rt.flowAbort.abort();
    }
  }, f.maxFlowSec * 1000);

  broadcast({ type: "sessionClearTranscript", id: rt.id });

  try {
    // ---- Dial with retry guardrail ----
    let started = false;
    for (let attempt = 1; attempt <= f.maxDialAttempts && !started; attempt++) {
      if (stopped()) {
        outcome = { category: "cancelled", reason: "stopped" };
        return outcome;
      }
      setFlowStep(rt, attempt > 1 ? `dialing ${number} (retry ${attempt})` : `dialing ${number}`);
      setSessionState(rt, { call: "dialing", number });
      try {
        await session.dial(number);
      } catch (err) {
        log(`[${rt.label}] dial attempt ${attempt} error: ${err.message}`);
        continue;
      }
      if (attempt === 1) accounts.bumpStat(rt.id, "calls");
      if (stopped()) {
        outcome = { category: "cancelled", reason: "stopped" };
        return outcome;
      }
      started = await session.confirmCallStarted(8000, signal);
      if (!started) log(`[${rt.label}] dial attempt ${attempt} didn't start a call; retrying…`);
    }
    if (stopped()) {
      outcome = { category: "cancelled", reason: "stopped" };
      return outcome;
    }
    if (!started) {
      setFlowStep(rt, "aborted: call did not start");
      await session.hangup().catch(() => {});
      setSessionState(rt, { call: "idle", number: null });
      outcome = uncallable("dial_failed");
      return outcome;
    }

    setFlowStep(rt, "ringing");
    setSessionState(rt, { call: "ringing", number });

    // ---- Answer / decline / no-pickup classification ----
    const ans = await session.waitForAnswerOrEnd(f.answerTimeoutSec * 1000, signal);
    if (rt.flowCancelled || ans === "cancelled") {
      outcome = { category: "cancelled", reason: "stopped" };
      return outcome;
    }
    if (ans !== "answered") {
      if (ans === "ended") {
        accounts.bumpStat(rt.id, "instantDecline");
        setFlowStep(rt, "instant decline");
        outcome = { category: "declined", reason: "instant_decline" };
      } else if (ans === "failed") {
        setFlowStep(rt, "call did not start");
        outcome = uncallable("dial_failed");
      } else {
        accounts.bumpStat(rt.id, "noPickup");
        setFlowStep(rt, "no answer");
        outcome = noPickup("no_answer");
      }
      await session.hangup().catch(() => {});
      setSessionState(rt, { call: "idle", number: null });
      return outcome;
    }

    accounts.bumpStat(rt.id, "answered");
    setSessionState(rt, { call: "answered", number });
    setFlowStep(rt, "answered");
    startHangupWatch();

    // ---- Pre-screen: catch carrier/wrong-number + screening intercepts ----
    // Skipped by default (preScreenSec: 0) so the greeting fires the instant
    // they pick up; screening/wrong-number are still caught in the reply window
    // below. Re-enable by setting flow.preScreenSec > 0.
    const pre =
      triggerMode === "voice" && f.preScreenSec > 0
        ? (setFlowStep(rt, "checking line (screening / wrong number)"),
          await listenForIntent(rt, f.preScreenSec * 1000, signal))
        : { intent: "silence" };
    if (stopped() || pre.intent === "aborted") {
      outcome = endedByHangup ? pickedUp("hung_up") : { category: "cancelled", reason: "stopped" };
      return await bail(outcome);
    }
    if (pre.intent === "call_screening") {
      setFlowStep(rt, "call screening detected — hanging up");
      outcome = uncallable("call_screening");
      return await bail(outcome);
    }
    if (pre.intent === "wrong_number") {
      setFlowStep(rt, "wrong/disconnected number — hanging up");
      outcome = uncallable("wrong_number");
      return await bail(outcome);
    }

    // ---- Greeting + intent loop (repeat 1.wav up to maxGreetingPlays) ----
    let heardAnySpeech = pre.intent !== "silence";
    let intentResult = pre.intent === "callback" || pre.intent === "no_callback" ? pre.intent : null;

    for (let play = 1; play <= f.maxGreetingPlays && !intentResult; play++) {
      if (stopped()) {
        outcome = endedByHangup ? pickedUp("hung_up") : { category: "cancelled", reason: "stopped" };
        return await bail(outcome);
      }
      const replay = play > 1;
      setFlowStep(rt, replay ? "no/unrelated reply — replaying 1.wav" : "playing 1.wav");
      setSessionState(rt, { audio: replay ? "replaying 1.wav" : "playing 1.wav" });
      const r1 = await session.playInjectedAudio(config.audioFile1);
      muteTranscriptFor(rt, Math.ceil((r1.durationSec || 3) * 1000) + f.echoMuteTailMs);
      await cancellableSleep(Math.ceil((r1.durationSec || 3) * 1000), signal);
      setSessionState(rt, { audio: "idle" });
      if (stopped()) {
        outcome = endedByHangup ? pickedUp("hung_up") : { category: "cancelled", reason: "stopped" };
        return await bail(outcome);
      }

      const windowSec = replay ? f.repeatSilenceSec : f.firstReplyWaitSec;

      // One window can resolve via a spoken intent OR a DTMF key, depending on
      // the trigger mode. Voice / DTMF / Hybrid all flow through here uniformly.
      setFlowStep(
        rt,
        useDtmf && useVoice
          ? `listening for reply or keypress (${windowSec}s)`
          : useDtmf
            ? `waiting for keypress — ${triggerMode === "dtmfAny" ? "any key" : "press 1"} (${windowSec}s)`
            : `listening for reply (${windowSec}s)`
      );
      const res = await listenForReply(rt, windowSec * 1000, signal, {
        voice: useVoice,
        dtmf: useDtmf ? dtmfAccept : null,
      });
      if (stopped() || res.via === "aborted") {
        outcome = endedByHangup ? pickedUp("hung_up") : { category: "cancelled", reason: "stopped" };
        return await bail(outcome);
      }
      if (res.via === "dtmf") {
        heardAnySpeech = true;
        callbackVia = "dtmf";
        intentResult = "callback";
      } else if (res.via === "intent") {
        heardAnySpeech = true;
        if (res.intent === "call_screening") {
          outcome = uncallable("call_screening");
          return await bail(outcome);
        }
        if (res.intent === "wrong_number") {
          outcome = uncallable("wrong_number");
          return await bail(outcome);
        }
        if (res.intent === "callback" || res.intent === "no_callback") {
          if (res.intent === "callback") callbackVia = "voice";
          intentResult = res.intent;
        }
      }
      // res.via === "silence" -> fall through and replay 1.wav
    }

    if (intentResult !== "callback") {
      const reason = heardAnySpeech ? "no_callback" : "no_response";
      setFlowStep(rt, intentResult === "no_callback" ? "customer confirmed — no callback" : "no callback — ending");
      await session.hangup().catch(() => {});
      setSessionState(rt, { call: "idle", number: null, audio: "idle" });
      outcome = pickedUp(reason);
      return outcome;
    }

    // ---- Callback confirmed: play 2.wav immediately, hang up after 1s ----
    // Start the audio first; fire the Telegram notification in parallel so the
    // ~2.5s round-trip never delays (or, if they hang up early, swallows) 2.wav.
    accounts.bumpStat(rt.id, "callback");
    setFlowStep(rt, "callback confirmed — playing 2.wav");
    setSessionState(rt, { audio: "playing 2.wav" });
    const r2 = await session.playInjectedAudio(config.audioFile2);
    muteTranscriptFor(rt, Math.ceil((r2.durationSec || 3) * 1000) + f.echoMuteTailMs);
    notifyClaimedLine(number, contact).catch(() => {});
    await cancellableSleep(Math.ceil((r2.durationSec || 3) * 1000), signal);
    setSessionState(rt, { audio: "idle" });
    if (stopped()) {
      outcome = { ...pickedUp("callback"), via: callbackVia };
      return await bail(outcome);
    }
    await cancellableSleep(f.postFollowupHangupSec * 1000, signal);
    setFlowStep(rt, "hanging up");
    await session.hangup().catch(() => {});
    setSessionState(rt, { call: "idle", number: null, audio: "idle" });
    setFlowStep(rt, "done");
    outcome = { ...pickedUp("callback"), via: callbackVia };
    return outcome;
  } catch (err) {
    setFlowStep(rt, `error: ${err.message}`);
    await session.hangup().catch(() => {});
    setSessionState(rt, { call: "idle", number: null, audio: "idle" });
    outcome = noPickup(`error: ${err.message}`);
    return outcome;
  } finally {
    clearTimeout(watchdog);
    stopHangupWatch();
    rt.transcriptListeners.clear();
    rt.dtmfDetector = null;
    rt.flowRunning = false;
    rt.flowAbort = null;
    endCapture(rt);
    // Record the concluded outcome per number (latest wins) so re-runs can skip
    // by category. User-cancelled calls aren't a conclusion, so they're skipped.
    // Covers BOTH manual startFlow and campaign calls.
    try {
      if (outcome && outcome.category !== "cancelled") {
        const cat = canonicalCategory(outcome.category, outcome.reason, outcome.via);
        const entry = callHistory.record({
          number,
          category: cat,
          reason: outcome.reason,
          via: outcome.via || callbackVia || null,
        });
        broadcast({
          type: "callOutcome",
          number,
          category: cat,
          reason: outcome.reason,
          via: outcome.via || callbackVia || null,
          attempts: entry ? entry.attempts : undefined,
        });
      }
    } catch (err) {
      log(`callHistory record failed: ${err.message}`);
    }
  }

  // Teardown when we bail mid-call (screening/wrong/stop/hangup).
  async function bail(o) {
    stopHangupWatch();
    await session.stopInjectedAudio().catch(() => {});
    await session.hangup().catch(() => {});
    setSessionState(rt, { call: "idle", number: null, audio: "idle" });
    outcome = o;
    return o;
  }
}

// ---- Campaign manager ----------------------------------------------------- //
const campaign = new CampaignManager({
  declineRetries: config.flow.declineRetries,
  log: (m) => log(m),
  onLead: (lead) => {
    // Translate a concluded lead's internal {category, reason, via} to the
    // canonical outcome category so the UI marks match callHistory exactly.
    const out = { ...lead };
    if (lead.status === "done") {
      out.category = canonicalCategory(lead.category, lead.reason, lead.via);
    }
    broadcast({ type: "leadStatus", ...out });
  },
  onProgress: (p) => broadcast({ type: "campaign", ...p }),
});

// ---- WebSocket wiring ----------------------------------------------------- //
controlWss.on("connection", (ws) => {
  controlClients.add(ws);
  handlers.status();
  try {
    ws.send(JSON.stringify({ type: "locations", locations: listLocations() }));
    ws.send(JSON.stringify({ type: "callHistory", entries: callHistory.all() }));
  } catch {
    /* ignore */
  }
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const fn = handlers[msg.type];
    if (!fn) return log(`Unknown command: ${msg.type}`);
    try {
      await fn(msg);
    } catch (err) {
      log(`Command "${msg.type}" failed: ${err.message}`);
    }
  });
  ws.on("close", () => controlClients.delete(ws));
});

// Legacy/fallback: the optional tabCapture extension streams PCM16 here. Routes
// to the foreground session's transcriber.
audioWss.on("connection", (ws) => {
  log("Extension audio stream connected (fallback path).");
  ws.on("message", (data, isBinary) => {
    const id = gv.activeAccountId() || accounts.getActiveId();
    if (!id) return;
    if (isBinary) pushCaptureAudio(id, Buffer.from(data).toString("base64"));
    else {
      try {
        const j = JSON.parse(data.toString());
        if (j.audio) pushCaptureAudio(id, j.audio);
      } catch {
        /* ignore */
      }
    }
  });
  ws.on("close", () => log("Extension audio stream ended."));
});

server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  if (!requestAuthorized(req)) return socket.destroy();
  if (url.startsWith("/control")) {
    controlWss.handleUpgrade(req, socket, head, (ws) => controlWss.emit("connection", ws, req));
  } else if (url.startsWith("/audio")) {
    audioWss.handleUpgrade(req, socket, head, (ws) => audioWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(config.port, config.host, async () => {
  const { proxyStatus, proxyMode } = await import("./proxy.js");
  const pst = proxyStatus();
  console.log(`call-backend listening on http://${config.host}:${config.port}`);
  console.log(`  dashboard: ${fs.existsSync(config.distDir) ? "served at /" : "not bundled (dev: run the Vite UI)"}`);
  console.log(`  control WS: /control   audio WS: /audio`);
  console.log(`  mode: ${config.hosted ? "HOSTED (login local-only; import sessions)" : "LOCAL (headed login + export)"}`);
  console.log(`  auth: ${authEnabled() ? "ON" : "OFF (no password)"}`);
  console.log(`  proxy: ${pst.ok ? `ON (${proxyMode()})` : `OFF — ${pst.reason}`}`);
  // Persistence signal: state lives under DATA_DIR (/data on the host) and only
  // survives restarts when a Railway Volume is mounted there. persistenceInfo()
  // checks /proc/mounts + a marker file so we can state this definitively.
  const persisted = accounts.list().length;
  const pinfo = persistenceInfo();
  console.log(`  state dir: ${config.profilesDir}`);
  console.log(`  persistent storage: ${pinfo.persistent ? "yes" : "NO"} (dataDir ${pinfo.dataDir}, accounts on boot ${persisted})`);
  if (config.hosted && !pinfo.persistent) {
    console.warn("  ============================================================");
    console.warn("  WARNING: /data is NOT a mounted Volume.");
    console.warn("  Imported Google Voice sessions WILL BE LOST on every restart.");
    console.warn("  Fix: Railway -> your service -> Volumes -> add a Volume with");
    console.warn("       mount path EXACTLY /data, redeploy, then re-import once.");
    console.warn("  ============================================================");
  }

  // Do not auto-open a visible browser on boot. Sessions open lazily when an
  // action needs them (Open browser / dial / flow / campaign), so nothing pops
  // up unprompted.
});
