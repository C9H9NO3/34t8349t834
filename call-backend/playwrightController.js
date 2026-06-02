// Drives persistent Chromium sessions for Google Voice via Playwright.
//
// ISOLATION MODEL: every account gets its OWN Session (own browser context,
// page, and proxy bridge). Sessions are kept in a Map keyed by account id and
// never share state, so multiple automated flows run in parallel with zero
// overlap. The manual single-call console acts on the "foreground" session
// (the account selected in the UI).

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { config } from "./config.js";
import * as accounts from "./accounts.js";
import { stealthInit } from "./stealth.js";
import { audioInjectInit } from "./audioInject.js";
import { remoteCaptureInit } from "./remoteCapture.js";
import { playwrightProxy, proxyConfigured, proxyStatus, proxyMode } from "./proxy.js";
import { createBridge } from "./proxyBridge.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.join(HERE, "extension");

// All open sessions, keyed by account id. Each value is a Session instance.
const sessions = new Map();
// The account the manual console operates on (UI-selected). Campaign workers
// address their own sessions directly and don't rely on this.
let foregroundId = null;

// Optional logger so step-by-step actions surface in the dashboard log panel.
let logger = null;
export function setLogger(fn) {
  logger = typeof fn === "function" ? fn : null;
}

// Per-session audio routing. server.js sets handlers that receive the session
// id so each session's call audio feeds ONLY its own transcriber.
//   onAudio(id, b64) | onState(id, state) | onLog(id, message)
let audioHandlers = {};
export function setAudioHandlers(h) {
  audioHandlers = h || {};
}

// Tracks which contexts already have the bindings registered (re-exposing on
// the same context throws "already registered").
const boundContexts = new WeakSet();

// Runtime head/headless override (null = use config.headless).
let headlessOverride = null;
export function isHeadless() {
  return headlessOverride ?? config.headless;
}

function extensionArgs() {
  if (!config.loadExtensionOnStart) return []; // deferred by default
  if (!fs.existsSync(path.join(EXTENSION_DIR, "manifest.json"))) return [];
  if (isHeadless()) return []; // extensions only load headful
  return [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
  ];
}

// Returns the first non-closed page in the context, creating one if needed.
async function freshPage(context) {
  const open = context.pages().find((p) => !p.isClosed());
  const page = open || (await context.newPage());
  try {
    await page.bringToFront();
  } catch {
    /* best-effort */
  }
  return page;
}

// Builds the persistent-context launch options from config (stealth-aware).
function launchOptions(dir, { useChannel, proxy, headed }) {
  const s = config.stealth || {};
  const args = [...config.browserArgs, ...extensionArgs()];
  // When a proxy is active, limit WebRTC to the proxied/public interface so the
  // account's real local IP isn't exposed via WebRTC candidates.
  if (proxy && config.proxy && config.proxy.webrtcPolicy) {
    args.push(`--force-webrtc-ip-handling-policy=${config.proxy.webrtcPolicy}`);
  }
  const opts = {
    // `headed` forces a visible window (manual login / Open browser) regardless
    // of the runtime headless toggle. On a hosted server there is no X display,
    // so headless is hard-forced - no path (campaign, toggle, showBrowser) can
    // ever try to open a window and crash with "Missing X server".
    headless: config.hosted ? true : headed ? false : isHeadless(),
    viewport: s.viewport || null,
    args,
    ignoreDefaultArgs: config.ignoreDefaultArgs || [],
    userAgent: s.userAgent || undefined,
    locale: s.locale || undefined,
    timezoneId: s.timezoneId || undefined,
  };
  if (proxy) opts.proxy = proxy;
  if (useChannel && s.channel) opts.channel = s.channel;
  return opts;
}

// Launches the persistent context, preferring real Chrome (channel) and
// falling back to bundled Chromium if Chrome can't be launched.
async function launchContext(dir, proxy, { headed = false } = {}) {
  const forceBundled = Boolean(proxy && config.proxy && config.proxy.useBundledChromium);
  const wantChannel = Boolean(config.stealth && config.stealth.channel) && !forceBundled;
  if (wantChannel) {
    try {
      return await chromium.launchPersistentContext(dir, launchOptions(dir, { useChannel: true, proxy, headed }));
    } catch (err) {
      console.warn(
        `[stealth] Chrome channel "${config.stealth.channel}" failed (${err.message}); ` +
          "falling back to bundled Chromium."
      );
    }
  }
  return chromium.launchPersistentContext(dir, launchOptions(dir, { useChannel: false, proxy, headed }));
}

async function tolerateVoiceNavigation(page, navigate) {
  try {
    await navigate();
  } catch (err) {
    // Google Voice is an SPA and often aborts navigation with ERR_ABORTED
    // while it redirects itself; that's harmless.
    if (!/ERR_ABORTED/i.test(err.message)) throw err;
    await page.waitForTimeout(1500);
    if (!page.url().includes("google.com")) {
      await page.goto(config.googleVoiceUrl, { waitUntil: "commit" }).catch(() => {});
    }
  }
}

// ---- Session: one fully isolated GV browser session for one account -------- //
class Session {
  constructor(id) {
    this.id = id;
    this.context = null;
    this.page = null;
    this.bridge = null; // { url, port, stop } or null
    this.label = id.slice(0, 8);
    this.launchedHeadless = null; // whether this context was launched headless
  }

  step(message) {
    if (logger) logger(`[${this.label}] ${message}`);
  }

  alive() {
    return Boolean(this.context && this.page && !this.page.isClosed());
  }

  async gotoVoice({ reload = false } = {}) {
    const page = this.page;
    const onCanonical = page.url().startsWith(config.googleVoiceUrl);
    // Already parked on the exact calls URL and no refresh asked for: nothing to do.
    if (onCanonical && !reload) return;
    // Always hard-navigate to the canonical /u/0/calls URL (never page.reload()):
    // a plain reload would keep a drifted URL (/about, /u/1/…, or the signed-out
    // marketing page), whereas a fresh goto guarantees we land on the dialer
    // route and re-applies the inject/capture init scripts.
    this.step(reload ? "Reloading Google Voice (canonical /u/0/calls)…" : "Opening Google Voice…");
    await tolerateVoiceNavigation(page, () =>
      page.goto(config.googleVoiceUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
    );
  }

  // Opens a throwaway page through the proxy to confirm the tunnel is up.
  async preflightProxy() {
    const page = await this.context.newPage();
    try {
      await page.goto("https://ipinfo.io/json", { waitUntil: "domcontentloaded", timeout: 20000 });
      this.step("proxy tunnel OK (preflight passed)");
    } catch (err) {
      const tunnel = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_NO_SUPPORTED_PROXIES/i.test(err.message);
      const msg = tunnel
        ? `Proxy tunnel failed (${proxyMode()} mode). Check NodeMaven creds/allowlist or try PROXY_USE_SOCKS5=true. See Activity log.`
        : `Proxy preflight error: ${err.message}`;
      this.step(msg);
      console.warn(`[proxy] ${msg}`);
      throw new Error(msg);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async isLoggedIn() {
    if (!this.alive()) {
      if (this.context) {
        this.page = await freshPage(this.context).catch(() => null);
      }
      if (!this.page) return false;
    }
    let url = this.page.url();
    if (url.includes("accounts.google.com")) return false;
    if (!url.includes("voice.google.com")) {
      await this.gotoVoice().catch(() => {});
      url = this.page.url();
    }
    if (url.includes("accounts.google.com")) return false;
    // A signed-out session does NOT redirect to accounts.google.com - Google
    // serves the public marketing page at voice.google.com/u/0/calls itself.
    // So URL checks alone wrongly report "logged in". Probe the DOM: the logged-in
    // app has the dialer/app shell; the marketing page has "Get started"/"Sign in"
    // CTAs and the /about route. Default to logged-in only when the app shell shows.
    try {
      const signedOut = await this.page.evaluate(() => {
        const href = location.href;
        if (/voice\.google\.com\/about/i.test(href)) return true;
        // The real GV app shell: the dialer input or its container.
        const hasApp = !!document.querySelector(
          'input[placeholder="Enter a name or number"], [gv-test-id], gv-app, gv-content-pane, [aria-label="Call panel" i]'
        );
        if (hasApp) return false;
        // Marketing/sign-in markers (the signed-out landing page).
        const txt = (document.body && document.body.innerText ? document.body.innerText : "").toLowerCase();
        const marketing =
          /\bget started\b/.test(txt) ||
          /professional-grade phone plan/.test(txt) ||
          (/\bsign in\b/.test(txt) && /google workspace/.test(txt));
        return marketing;
      });
      return !signedOut;
    } catch {
      // If the probe failed (page navigating), fall back to the URL signal.
      return !this.page.url().includes("accounts.google.com");
    }
  }

  async dismissSoundBanner() {
    try {
      const x = this.page.locator(config.selectors.soundBannerDismiss).first();
      if (await x.isVisible({ timeout: 800 })) await x.click({ timeout: 800 });
    } catch {
      /* ignore */
    }
  }

  // Places a call through the real Google Voice dialer.
  async dial(number) {
    const page = this.page;
    this.step(`dial(${number}): navigating to calls page`);
    // Reload into a clean, idle GV so every call starts fresh: ends any lingering
    // call, resets the dialer, and re-applies the inject/capture init scripts.
    await this.gotoVoice({ reload: true });
    await this.dismissSoundBanner();

    // Fail fast with a clear, actionable message if this session is signed out.
    // Otherwise the dialer never renders and the user only sees a cryptic 10s
    // "waiting for input… to be visible" timeout. Auto-capture a screenshot so
    // the signed-out state is one click to confirm in the Accounts tab.
    if (!(await this.isLoggedIn())) {
      const shotNote = await this.saveDebugShot("signed-out").catch(() => null);
      const acctLabel = (accounts.get(this.id) || {}).label || this.label;
      throw new Error(
        `Account "${acctLabel}" is signed out on the server — re-import a fresh session ` +
          `(export it locally, then use Import session in the Accounts tab).` +
          (shotNote ? ` [debug shot: ${shotNote}]` : "")
      );
    }

    try {
      const loc = page.locator(config.selectors.newCallButton).first();
      await loc.waitFor({ state: "visible", timeout: 1500 });
      await loc.click();
      this.step("clicked open-dialer button (best-effort)");
    } catch {
      this.step("dialer input already visible (no open click needed)");
    }

    const input = page.locator(config.selectors.numberInput).first();
    try {
      await input.waitFor({ state: "visible", timeout: 10000 });
    } catch (err) {
      const shotNote = await this.saveDebugShot("no-dialer").catch(() => null);
      throw new Error(
        `dial failed: number input not found (the calls page never rendered the dialer).` +
          (shotNote ? ` [debug shot: ${shotNote}]` : "") +
          ` — original: ${err.message}`
      );
    }
    this.step(`found number input: ${config.selectors.numberInput}`);
    await input.click();
    await input.fill("");
    await input.type(number, { delay: 60 });
    this.step(`typed number "${number}" into input`);

    const dialBtn = page.locator(config.selectors.dialButton).first();
    try {
      await dialBtn.waitFor({ state: "visible", timeout: 5000 });
      await page
        .waitForFunction(
          (sel) => {
            const b = document.querySelector(sel);
            return b && b.getAttribute("aria-disabled") !== "true";
          },
          'button[gv-test-id="new-call-button"]',
          { timeout: 4000 }
        )
        .catch(() => {});
      this.step(`clicking call button -> ${JSON.stringify(await describe(dialBtn))}`);
      await dialBtn.click({ timeout: 3000 });
      this.step("call button clicked");
    } catch (err) {
      this.step(`call button not clickable (${err.message}); pressing Enter instead`);
      await input.press("Enter");
    }
    return { dialing: number };
  }

  // Reads the current call-duration timer text (mm:ss) from the page, if present.
  async readCallTimer() {
    return this.page.evaluate((sel) => {
      const re = /^\s*\d{1,2}:\d{2}(:\d{2})?\s*$/;
      const tryEl = (el) => {
        const t = (el.textContent || "").trim();
        return re.test(t) ? t : null;
      };
      if (sel) {
        for (const el of document.querySelectorAll(sel)) {
          const t = tryEl(el);
          if (t) return t;
        }
      }
      const all = document.querySelectorAll("span, div, time");
      for (const el of all) {
        if (el.childElementCount === 0) {
          const t = tryEl(el);
          if (t) return t;
        }
      }
      return null;
    }, config.selectors.callTimer);
  }

  // Reads the GV "Call panel" region's state. Most reliable "is a call active"
  // signal: class is "root no-active-call" when idle, drops it during a call.
  async callPanelState() {
    try {
      return await this.page.evaluate(
        ({ sel, idleClass }) => {
          const el = document.querySelector(sel);
          if (!el) return { found: false, active: false };
          const cls = (el.className && el.className.toString ? el.className.toString() : "") || "";
          return { found: true, active: !cls.split(/\s+/).includes(idleClass) };
        },
        { sel: config.selectors.callPanel, idleClass: config.selectors.callPanelIdleClass }
      );
    } catch {
      return { found: false, active: false };
    }
  }

  async isRinging() {
    const panel = await this.callPanelState();
    if (panel.found) return panel.active;
    try {
      const hasEnd = await this.page
        .locator(config.selectors.hangupButton)
        .first()
        .isVisible({ timeout: 500 });
      return Boolean(hasEnd);
    } catch {
      return false;
    }
  }

  async confirmCallStarted(timeoutMs = 8000, signal = null) {
    const deadline = Date.now() + timeoutMs;
    let everFoundPanel = false;
    while (Date.now() < deadline) {
      if (signal && signal.aborted) return false;
      const panel = await this.callPanelState();
      if (panel.found) everFoundPanel = true;
      if (panel.active) {
        this.step("call started (call panel active)");
        return true;
      }
      const t = await this.readCallTimer().catch(() => null);
      if (t) {
        this.step(`call started (timer ${t})`);
        return true;
      }
      await this.page.waitForTimeout(200);
    }
    if (!everFoundPanel) {
      this.step("call panel not found; proceeding without start confirmation");
      return true;
    }
    this.step("call did not start (call panel stayed idle)");
    return false;
  }

  // Classifies a dialed call's early outcome. This is the system that decides
  // instant-decline (DND) vs no-answer vs answered:
  //   "answered" - a call-duration timer appeared/incremented => callee picked up
  //   "ended"    - the call WAS ringing (panel active) then went idle BEFORE any
  //                timer => instant decline / dropped before answer (retry once)
  //   "timeout"  - rang the full window with no pickup and no instant drop
  //   "failed"   - the call UI never became active at all (dialer issue)
  //   "cancelled"- flow aborted via signal
  // The firstTimer===null guard is what separates an instant decline ("ended")
  // from an answered-then-hung-up call: once a timer is seen we return
  // "answered" and the post-answer hangup is handled by runFlow's hangup watch.
  async waitForAnswerOrEnd(timeoutMs, signal = null) {
    const deadline = Date.now() + timeoutMs;
    let firstTimer = null;
    let firstSeenAt = 0;
    let sawRinging = false;
    let everFoundPanel = false;
    const ringDeadline = Date.now() + Math.min(8000, timeoutMs);
    while (Date.now() < deadline) {
      if (signal && signal.aborted) return "cancelled";
      const t = await this.readCallTimer().catch(() => null);
      if (t) {
        if (firstTimer === null) {
          firstTimer = t;
          firstSeenAt = Date.now();
        } else if (t !== firstTimer) {
          this.step(`answered (timer ${firstTimer} -> ${t})`);
          return "answered";
        } else if (Date.now() - firstSeenAt > 800) {
          this.step(`answered (timer ${t})`);
          return "answered";
        }
      }
      const panel = await this.callPanelState();
      if (panel.found) everFoundPanel = true;
      const ringing = panel.found ? panel.active : await this.isRinging().catch(() => false);
      if (ringing) sawRinging = true;
      else if (sawRinging && firstTimer === null) {
        this.step("instant decline: call was ringing then dropped before answer");
        return "ended";
      } else if (
        everFoundPanel &&
        !sawRinging &&
        firstTimer === null &&
        Date.now() > ringDeadline
      ) {
        this.step("call never started (call panel stayed idle)");
        return "failed";
      }
      await this.page.waitForTimeout(200);
    }
    this.step(firstTimer === null ? "no answer (rang out, no pickup)" : "no answer (timer seen but never confirmed)");
    return "timeout";
  }

  async checkProxyIp() {
    const page = await this.context.newPage();
    try {
      await page.goto("https://ipinfo.io/json", { waitUntil: "domcontentloaded", timeout: 20000 });
      const text = await page.evaluate(() => document.body.innerText || "");
      let info = {};
      try {
        info = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
      return {
        ip: info.ip || null,
        city: info.city || null,
        region: info.region || null,
        country: info.country || null,
        org: info.org || null,
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async playInjectedAudio(file = config.audioFile1) {
    if (!fs.existsSync(file)) throw new Error(`audio file not found: ${file}`);
    const b64 = fs.readFileSync(file).toString("base64");
    this.step(`playing audio into mic: ${path.basename(file)}`);
    const result = await this.page.evaluate(async (data) => {
      if (typeof window.__injectAudio !== "function") {
        return { ok: false, error: "audio inject not ready (reload the GV tab)" };
      }
      try {
        const r = await window.__injectAudio(data);
        return { ok: true, durationSec: r && r.durationSec };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    }, b64);
    if (!result.ok) throw new Error(result.error || "injection failed");
    this.step(`audio playing (${(result.durationSec || 0).toFixed?.(1) || result.durationSec}s)`);
    return result;
  }

  async stopInjectedAudio() {
    try {
      await this.page.evaluate(() => {
        if (typeof window.__stopInjectedAudio === "function") window.__stopInjectedAudio();
      });
    } catch {
      /* page may be navigating */
    }
    this.step("stopped injected audio");
    return { stopped: true };
  }

  async hangup() {
    // Best-effort: click the end-call button if our selectors match.
    try {
      const btn = this.page.locator(config.selectors.hangupButton).first();
      await btn.waitFor({ state: "visible", timeout: 3000 });
      this.step(`clicking hang up -> ${JSON.stringify(await describe(btn))}`);
      await btn.click();
      await this.page.waitForTimeout(600);
    } catch {
      this.step("hang up button not found");
    }
    // Verify via the Call panel; if still active (or unobservable), reload GV -
    // navigating away tears down the WebRTC call = guaranteed hangup.
    const panel = await this.callPanelState();
    if (panel.found && !panel.active) return { hungUp: true };
    try {
      this.step("ending call via reload (guaranteed hangup)");
      await this.gotoVoice({ reload: true });
      return { hungUp: true };
    } catch (err) {
      return { hungUp: false, error: err.message };
    }
  }

  async captureCallUI() {
    const page = this.page;
    await this.gotoVoice();
    const elements = await page.evaluate(() => {
      const out = [];
      const sel = "button, [role=button], a[href], input, [aria-label]";
      document.querySelectorAll(sel).forEach((el) => {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        out.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          dataE2e: el.getAttribute("data-e2e") || "",
          type: el.getAttribute("type") || "",
          placeholder: el.getAttribute("placeholder") || "",
          text: (el.textContent || "").trim().slice(0, 80),
          id: el.id || "",
          classes: (el.className && el.className.toString ? el.className.toString() : "").slice(0, 120),
          visible,
        });
      });
      return out;
    });
    const outPath = path.join(HERE, `callui-${this.id}.json`);
    fs.writeFileSync(
      outPath,
      JSON.stringify({ url: page.url(), capturedAt: new Date().toISOString(), elements }, null, 2),
      "utf8"
    );
    return { file: outPath, count: elements.length, url: page.url() };
  }

  // Captures a PNG of the current page (what this headless session sees right
  // now). Useful for debugging on a display-less host: shows whether GV loaded,
  // a login/consent screen appeared, the dialer is present, etc.
  async screenshot() {
    if (!this.alive()) {
      this.page = await freshPage(this.context).catch(() => null);
      if (!this.page) throw new Error("no page to capture");
    }
    return this.page.screenshot({ type: "png", fullPage: false });
  }

  // Writes a PNG of the current page to disk for post-mortem debugging (e.g. a
  // dial that failed because the session was signed out). Returns the filename,
  // or throws if capture is impossible. Best-effort: callers ignore failures.
  async saveDebugShot(tag = "debug") {
    const buf = await this.screenshot();
    const safeTag = String(tag).replace(/[^a-z0-9_-]/gi, "");
    const name = `shot-${this.label}-${safeTag}-${Date.now()}.png`;
    const outPath = path.join(HERE, name);
    fs.writeFileSync(outPath, buf);
    this.step(`saved debug screenshot: ${name} (url: ${this.page.url()})`);
    return name;
  }

  async close() {
    if (this.context) {
      await this.context.close().catch(() => {});
    }
    if (this.bridge) {
      try {
        this.bridge.stop();
      } catch {
        /* ignore */
      }
      this.bridge = null;
    }
    this.context = null;
    this.page = null;
  }
}

// Logs details about the element a locator resolves to (for click debugging).
async function describe(locator) {
  try {
    return await locator.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      ariaLabel: el.getAttribute("aria-label") || "",
      testId: el.getAttribute("gv-test-id") || "",
      text: (el.textContent || "").trim().slice(0, 50),
    }));
  } catch {
    return null;
  }
}

// ---- Session lifecycle / registry ----------------------------------------- //

export function getSession(id) {
  return sessions.get(id) || null;
}

export function activeAccountId() {
  return foregroundId && sessions.has(foregroundId) ? foregroundId : null;
}

export function setForeground(id) {
  foregroundId = id;
}

// Returns the foreground session (the UI-selected account), or null.
function fg() {
  return foregroundId ? sessions.get(foregroundId) || null : null;
}

// Tracks in-flight openAccount launches per id, so two rapid calls (e.g. a
// double-click or overlapping actions) can never launch two Chromium instances
// of the same account.
const openingPromises = new Map();

// Opens (or returns) the isolated session for an account id. Concurrent calls
// for the same id share a single launch.
export async function openAccount(id, { headed = false } = {}) {
  const existing0 = sessions.get(id);
  // Fast path: a live session that already satisfies the visibility need.
  if (existing0 && existing0.alive() && !(headed && existing0.launchedHeadless)) {
    foregroundId = id;
    return existing0;
  }
  const pending = openingPromises.get(id);
  if (pending) return pending;
  const p = (async () => openAccountImpl(id, { headed }))();
  openingPromises.set(id, p);
  try {
    return await p;
  } finally {
    openingPromises.delete(id);
  }
}

// Re-applies a portable login snapshot to a freshly launched context. Reads the
// sidecar written at import time (accounts.storageStatePath). Cookies are added
// directly (storageState shape == addCookies shape); localStorage is seeded via
// an init script that only fills keys not already present so it never clobbers
// values the live app writes. All best-effort: a missing/partial state must
// never block launch.
async function applyStorageState(session, context, id) {
  let state;
  try {
    const p = accounts.storageStatePath(id);
    if (!fs.existsSync(p)) return;
    state = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    session.step(`portable login: could not read state (${err.message})`);
    return;
  }
  if (!state || typeof state !== "object") return;

  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  if (cookies.length) {
    try {
      await context.addCookies(cookies);
      session.step(`portable login: applied ${cookies.length} cookies`);
    } catch (err) {
      session.step(`portable login: addCookies failed (${err.message})`);
    }
  }

  const origins = Array.isArray(state.origins) ? state.origins : [];
  if (origins.length) {
    try {
      await context.addInitScript((originsArg) => {
        try {
          const here = location.origin;
          const match = originsArg.find((o) => o && o.origin === here);
          if (!match || !Array.isArray(match.localStorage)) return;
          for (const kv of match.localStorage) {
            if (!kv || kv.name == null) continue;
            try {
              if (window.localStorage.getItem(kv.name) == null) {
                window.localStorage.setItem(kv.name, kv.value);
              }
            } catch {
              /* quota / blocked - ignore */
            }
          }
        } catch {
          /* ignore */
        }
      }, origins);
    } catch (err) {
      session.step(`portable login: localStorage seed skipped (${err.message})`);
    }
  }
}

async function openAccountImpl(id, { headed = false } = {}) {
  const existing = sessions.get(id);
  if (existing && existing.alive()) {
    // Reuse the live session, unless a visible window is required but this one
    // was launched headless - then relaunch it headed so login is possible.
    if (!(headed && existing.launchedHeadless)) {
      foregroundId = id;
      return existing;
    }
  }
  if (existing) await closeAccount(id);

  const session = new Session(id);
  const dir = accounts.profileDir(id);
  fs.mkdirSync(dir, { recursive: true });

  // Route this account's Chromium through its own residential proxy bridge.
  const acct = accounts.get(id);
  const mode = proxyMode();
  let proxy = null;
  if (mode === "bridge") {
    session.bridge = await createBridge(acct);
    proxy = { server: session.bridge.url };
  } else if (mode === "socks5" || mode === "direct") {
    proxy = playwrightProxy(acct);
  }
  if (proxy) {
    const where = `${acct.proxy.region}/${acct.proxy.city}, sid ${acct.proxy.sid}`;
    session.step(`launching with residential proxy via ${mode} (${where})`);
    console.log(`[proxy] [${session.label}] launching via ${mode} (${where})`);
  } else {
    const st = proxyStatus();
    session.step(`launching without proxy — ${st.reason}`);
    console.warn(`[proxy] [${session.label}] launching without proxy — ${st.reason}`);
  }

  const context = await launchContext(dir, proxy, { headed });
  if (context.browser() && !context.browser().isConnected()) {
    await session.close();
    throw new Error("Browser closed during launch - click Log in again.");
  }
  session.context = context;
  session.launchedHeadless = headed ? false : isHeadless();

  // Expose per-session capture bindings. The closure captures THIS session, so
  // its call audio routes only to its own transcriber - no cross-talk.
  if (!boundContexts.has(context)) {
    try {
      await context.exposeBinding("__sttPush", (_src, b64) => {
        if (audioHandlers.onAudio) audioHandlers.onAudio(session.id, b64);
      });
      await context.exposeBinding("__sttState", (_src, s) => {
        if (audioHandlers.onState) audioHandlers.onState(session.id, s);
      });
      await context.exposeBinding("__sttLog", (_src, m) => {
        if (audioHandlers.onLog) audioHandlers.onLog(session.id, m);
      });
      boundContexts.add(context);
    } catch {
      /* already registered or unsupported - best-effort */
    }
  }
  try {
    await context.addInitScript(stealthInit);
    // Tell the injector whether to mix the real mic (desktop) or run mic-less
    // (headless/cloud host) - must run before audioInjectInit reads it.
    await context.addInitScript((micless) => {
      window.__INJECT_MICLESS = Boolean(micless);
    }, config.injectMicless);
    await context.addInitScript(audioInjectInit);
    await context.addInitScript(remoteCaptureInit);
  } catch {
    /* best-effort */
  }
  context.on("close", () => {
    const s = sessions.get(id);
    if (s && s.context === context) {
      if (s.bridge) {
        try {
          s.bridge.stop();
        } catch {
          /* ignore */
        }
      }
      sessions.delete(id);
      if (foregroundId === id) foregroundId = null;
    }
  });
  try {
    await context.grantPermissions(["microphone"], { origin: "https://voice.google.com" });
  } catch {
    /* best-effort */
  }
  // Inject the portable login (decrypted cookies + localStorage) BEFORE any GV
  // navigation. This is what makes a Windows->Linux session transfer work: the
  // raw Cookies DB in the copied profile is OS-encrypted and useless across
  // machines, so we instead re-apply the cookies here and Chromium re-encrypts
  // them with this host's key. Idempotent: a fresh re-import refreshes auth.
  await applyStorageState(session, context, id);

  session.page = await freshPage(context);
  sessions.set(id, session);
  foregroundId = id;
  accounts.setActiveId(id);
  if (proxy) await session.preflightProxy();
  await session.gotoVoice({ reload: true }).catch(() => {});
  return session;
}

export async function switchTo(id) {
  return openAccount(id);
}

export async function closeAccount(id) {
  const s = sessions.get(id);
  if (s) {
    await s.close();
    sessions.delete(id);
  }
  if (foregroundId === id) foregroundId = null;
}

// Closes the foreground session (back-compat with the single-session UI).
export async function closeActive() {
  if (foregroundId) await closeAccount(foregroundId);
}

export async function closeAll() {
  for (const id of Array.from(sessions.keys())) await closeAccount(id);
}

// Sets headless mode; relaunches all open sessions so it takes effect now.
export async function setHeadless(value) {
  headlessOverride = Boolean(value);
  const openIds = Array.from(sessions.keys());
  const fgId = foregroundId;
  for (const id of openIds) await closeAccount(id);
  for (const id of openIds) await openAccount(id).catch(() => {});
  if (fgId) foregroundId = fgId;
  return headlessOverride;
}

export function getPage() {
  const s = fg();
  return s ? s.page : null;
}

// One-time manual login: open the account's browser at Google Voice.
export async function login(id) {
  const session = await openAccount(id, { headed: true });
  session.page = await freshPage(session.context);
  await session.page.goto(config.googleVoiceUrl, { waitUntil: "domcontentloaded" });
  try {
    await session.page.bringToFront();
  } catch {
    /* best-effort */
  }
  return {
    id,
    loggedIn: await session.isLoggedIn(),
    message:
      "A Chromium window opened on your desktop. Log in to Google there if prompted; the session is saved for next time.",
  };
}

export async function isLoggedIn(id) {
  const s = sessions.get(id);
  if (!s) return false;
  return s.isLoggedIn();
}

// Captures a PORTABLE login snapshot (decrypted cookies + localStorage) from the
// running local context. Must run where the profile was created (Windows/Chrome)
// so the OS can decrypt the cookies; the resulting JSON is re-encrypted natively
// on whatever OS imports it. Opens the account if it isn't already live.
export async function exportStorageState(id) {
  const session = await openAccount(id);
  return session.context.storageState();
}

// Opens (if needed) the account's headless session and returns a PNG Buffer of
// its current page. Also reports the URL + login state so the caller can show
// "not logged in" context alongside the image.
export async function screenshot(id) {
  const session = await openAccount(id);
  const buf = await session.screenshot();
  let url = "";
  let loggedIn = false;
  try {
    url = session.page.url();
    loggedIn = !url.includes("accounts.google.com");
  } catch {
    /* ignore */
  }
  return { buf, url, loggedIn };
}

// Opens / brings the logged-in browser to the front so the user can inspect it.
export async function showBrowser(id) {
  const target = id || foregroundId || accounts.getActiveId();
  if (!target) throw new Error("no account to show - add/select one first");
  const session = await openAccount(target, { headed: true });
  await session.gotoVoice();
  try {
    await session.page.bringToFront();
  } catch {
    /* best-effort */
  }
  return { shown: true, url: session.page.url() };
}

// ---- Foreground wrappers (manual single-call console) --------------------- //
function requireFg() {
  const s = fg();
  if (!s) throw new Error("no active account - open the browser first");
  return s;
}
export async function dial(number) {
  return requireFg().dial(number);
}
export async function hangup() {
  const s = fg();
  return s ? s.hangup() : { hungUp: false };
}
export async function confirmCallStarted(timeoutMs, signal) {
  const s = fg();
  return s ? s.confirmCallStarted(timeoutMs, signal) : false;
}
export async function waitForAnswerOrEnd(timeoutMs, signal) {
  return requireFg().waitForAnswerOrEnd(timeoutMs, signal);
}
export async function callPanelState() {
  const s = fg();
  return s ? s.callPanelState() : { found: false, active: false };
}
export async function isRinging() {
  const s = fg();
  return s ? s.isRinging() : false;
}
export async function playInjectedAudio(file) {
  return requireFg().playInjectedAudio(file);
}
export async function stopInjectedAudio() {
  const s = fg();
  return s ? s.stopInjectedAudio() : { stopped: false };
}
export async function checkProxyIp() {
  return requireFg().checkProxyIp();
}
export async function captureCallUI() {
  return requireFg().captureCallUI();
}
