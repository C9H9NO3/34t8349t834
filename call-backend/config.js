// Central configuration for the Google Voice call-automation backend.
// Everything is hard-coded here (no CLI args); edit values to match your setup.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Keys we always re-read from .env so toggling PROXY_ENABLED works after a
// save without hunting down a stale Node process (other vars stay shell-first).
const DOTENV_ALWAYS_REFRESH = new Set([
  "PROXY_ENABLED",
  "NODEMAVEN_USER",
  "NODEMAVEN_PASS",
  "PROXY_BRIDGE",
  "PROXY_USE_SOCKS5",
  "PROXY_USE_BUNDLED_CHROMIUM",
  "PROXY_SPEED_FAST",
]);

// Minimal .env loader (no dependency): populates process.env from call-backend/.env.
function loadDotEnv({ refreshOnly = false } = {}) {
  try {
    const envPath = path.join(HERE, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!key) continue;
      if (refreshOnly && !DOTENV_ALWAYS_REFRESH.has(key)) continue;
      if (!refreshOnly && key in process.env && !DOTENV_ALWAYS_REFRESH.has(key)) continue;
      process.env[key] = val;
    }
  } catch {
    /* ignore */
  }
}

loadDotEnv();

/** Re-apply proxy-related .env keys and sync `config.proxy` (call after editing .env). */
export function refreshProxyEnv() {
  loadDotEnv({ refreshOnly: true });
  const p = config.proxy;
  p.enabled = String(process.env.PROXY_ENABLED || "").toLowerCase() === "true";
  p.user = process.env.NODEMAVEN_USER || "";
  p.pass = process.env.NODEMAVEN_PASS || "";
  p.bridge = String(process.env.PROXY_BRIDGE ?? "true").toLowerCase() !== "false";
  p.useSocks5 = String(process.env.PROXY_USE_SOCKS5 || "").toLowerCase() === "true";
  p.useBundledChromium =
    String(process.env.PROXY_USE_BUNDLED_CHROMIUM || "").toLowerCase() === "true";
  p.speedFast = String(process.env.PROXY_SPEED_FAST ?? "true").toLowerCase() !== "false";
}

// Where persistent state lives. On a host (Railway) point DATA_DIR at a mounted
// volume so profiles/accounts/history survive redeploys; locally it defaults to
// the backend folder so nothing changes for desktop use.
const DATA_DIR = process.env.DATA_DIR || HERE;
// Prefer a user-supplied audio folder on the volume, else the bundled samples.
const DATA_AUDIO_DIR = path.join(DATA_DIR, "audio");
const AUDIO_DIR = fs.existsSync(DATA_AUDIO_DIR) ? DATA_AUDIO_DIR : path.join(HERE, "audio");

export const config = {
  // Control/dashboard server. Binds 0.0.0.0 so it works inside a container;
  // override with HOST/PORT (Railway injects PORT). Access is gated by
  // DASHBOARD_PASSWORD when set (see server.js auth).
  host: process.env.HOST || "0.0.0.0",
  port: process.env.PORT ? Number(process.env.PORT) : 8787,
  // Shared password protecting the dashboard + WS + remote-login proxy. When
  // empty, auth is DISABLED (convenient for local dev).
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "",
  // Built dashboard served by the backend (single-service hosting).
  distDir: path.join(HERE, "public"),
  // Local noVNC/websockify endpoint the backend reverse-proxies under /vnc.
  vncProxyTarget: process.env.VNC_PROXY_TARGET || "http://127.0.0.1:6080",

  // Base folder holding one persistent Chromium profile per saved Google account
  // (cookies/state live here). Keep this out of git / on a volume when hosted.
  profilesDir: path.join(DATA_DIR, "profiles"),
  // Registry of saved accounts (labels + phone-number notes; no secrets).
  accountsFile: path.join(DATA_DIR, "accounts.json"),
  // Persistent per-number call-outcome history (so re-runs can skip by category).
  callHistoryFile: path.join(DATA_DIR, "call-history.json"),
  // Runtime-editable settings persisted from the UI (e.g. Telegram creds).
  settingsFile: path.join(DATA_DIR, "settings.json"),

  // Folder holding your call audio. greetingFile/followupFile are resolved
  // against it. mpv plays .wav and .mp3 alike; sample spoken .wav files are
  // included so you can test injection immediately. Swap in your own anytime.
  audioDir: AUDIO_DIR,
  greetingFile: "greeting.wav",
  followupFile: "followup.wav",
  // Seconds to wait between greeting and follow-up when running the sequence.
  sequenceDelaySeconds: 4,

  // Audio output device that feeds the browser's microphone.
  // After installing VB-CABLE this is typically "CABLE Input (VB-Audio Virtual Cable)".
  // Run `npm run devices` to list the exact name mpv expects.
  audioOutputDevice: "CABLE Input (VB-Audio Virtual Cable)",
  // Path to mpv (used for device-targeted playback). If mpv isn't on PATH, set
  // the absolute path here, or set to null to fall back to the OS default device.
  mpvPath: "mpv",

  // Browser behavior.
  headless: false, // Google login is unreliable headless; keep visible.
  // Auto-grant microphone permission so getUserMedia never prompts, plus
  // anti-detection flags so Google doesn't reject the login as an unsafe browser.
  browserArgs: [
    "--use-fake-ui-for-media-stream",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--start-maximized",
    "--no-first-run",
    "--no-default-browser-check",
    // Let Google Voice play the ringing/call audio without a user gesture so
    // calls actually ring (clears the "allow voice.google.com to play sound" banner).
    "--autoplay-policy=no-user-gesture-required",
  ],
  // Default automation args Chrome would otherwise add that flag the browser
  // as automated; removing them helps pass Google's "secure browser" check.
  ignoreDefaultArgs: ["--enable-automation"],
  // Load the call-capture extension at browser launch. Kept off by default
  // because the extension's background tab can close the first page during
  // login. Turn on once you're logged in and want live transcription capture.
  loadExtensionOnStart: false,

  // Audio injected into the live call mic. The browser decodes it (wav/mp3).
  // The flow plays audioFile1 after answer, then audioFile2 on the trigger.
  // The manual "Play audio" button plays audioFile1.
  audioFile1: path.join(AUDIO_DIR, "1.wav"),
  audioFile2: path.join(AUDIO_DIR, "2.wav"),

  // When true, the in-page injector does NOT mix the real microphone into the
  // call (only the injected WAV is sent). Defaults on for headless/Linux hosts
  // (no mic to leak); off on a desktop so you can still talk during local tests.
  injectMicless:
    String(process.env.INJECT_MICLESS ?? (process.platform === "linux" ? "true" : "false"))
      .toLowerCase() === "true",

  // Stealth / normal-browser simulation. Pointing Playwright at the real
  // installed Google Chrome (instead of bundled Chromium) fixes the network/TLS
  // fingerprint, which is the most common cause of Google login blocks.
  stealth: {
    // Browser channel. "chrome" uses installed Google Chrome (desktop). On a
    // Linux host there is no Chrome, so default to bundled Chromium (null).
    // Force with STEALTH_CHANNEL=bundled (or set a channel name explicitly).
    channel: (() => {
      const v = process.env.STEALTH_CHANNEL;
      if (v === "bundled" || v === "null" || v === "") return null;
      if (v) return v;
      return process.platform === "linux" ? null : "chrome";
    })(),
    // A realistic current Chrome UA matching the host OS (no "Headless").
    userAgent:
      process.platform === "linux"
        ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1280, height: 800 },
  },

  // Google Voice.
  googleVoiceUrl: "https://voice.google.com/u/0/calls",

  // Selectors for the GV web UI, mapped from the real Google Voice DOM.
  // Note: the input's id and the call button's aria-label are dynamic (the
  // aria-label embeds the typed number), so we match on stable attributes.
  selectors: {
    // The dialer input is already present on the calls page; no separate
    // "open dialer" click is needed, but this is tried best-effort.
    newCallButton: '[gv-test-id="open-dialpad"], [aria-label*="Make a call" i]',
    // The phone-number input ("Enter a name or number").
    numberInput: 'input[placeholder="Enter a name or number"]',
    // The green call button (gv-test-id is stable; aria-label is dynamic).
    dialButton: 'button[gv-test-id="new-call-button"], button.call-button, button[aria-label^="Call "]',
    // The "end call" / hang up button (best-effort; confirm during a live call).
    hangupButton: 'button[aria-label*="End call" i], button[aria-label*="Hang up" i], [gv-test-id*="end" i]',
    // The dismiss "x" on the "allow sound" banner, if it appears.
    soundBannerDismiss: 'button[aria-label*="Dismiss" i], button[aria-label*="Close" i]',
    // The in-call duration timer (mm:ss) - presence/increment = call answered.
    callTimer: '[gv-test-id*="duration" i], [aria-label*="call duration" i]',
    // The GV "Call panel" region. Its class is "root no-active-call" when idle
    // and drops "no-active-call" once a call is dialing/ringing/connected. This
    // is the most reliable "is a call happening" signal (the hangup-button
    // aria-labels above are best-effort and may not match GV's current DOM).
    callPanel: '[aria-label="Call panel" i]',
    // Substring in the call-panel class that means "no call in progress".
    callPanelIdleClass: "no-active-call",
  },

  // Transcription (OpenAI Realtime). Key comes from .env (OPENAI_API_KEY).
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  // gpt-4o-mini-transcribe is streaming-capable and honors `language`. If you
  // ever need the strictest language locking, whisper-1 enforces `language`
  // most rigidly but is not natively streaming.
  sttModel: "gpt-4o-mini-transcribe",
  // OpenAI Realtime pcm16 requires 24 kHz mono, little-endian.
  sttSampleRate: 24000,
  // Language hint for transcription (locks output to this language).
  sttLanguage: "en",
  // Optional prompt to bias decoding (English). Sent as transcription.prompt
  // for models that support it (not gpt-realtime-whisper). Set "" to disable.
  sttPrompt: "The conversation is in English.",

  // Automated call-flow timing/behavior.
  flow: {
    answerTimeoutSec: 45, // give up if not answered within this
    preGreetingDelaySec: 1, // wait after answer before playing 1.wav
    postFollowupHangupSec: 1, // wait after 2.wav (callback) before hanging up
    // After 1.wav, how long to listen for the customer's reply before treating
    // the line as silent and replaying the greeting.
    firstReplyWaitSec: 12,
    // After replaying 1.wav, wait this long for a reply; if still silent, end.
    repeatSilenceSec: 5,
    // How many times to play 1.wav total before giving up (repeat when the reply
    // is unrelated like "hello who is this", or the line is silent).
    maxGreetingPlays: 4,
    // Right after answer, listen this long for a carrier/screening intercept
    // (wrong number / "say your name" screening) BEFORE playing the greeting.
    // 0 = skip it so the greeting plays the instant they pick up (screening /
    // wrong-number are still caught in the post-greeting reply window).
    preScreenSec: 0,
    // Instant declines (call rejected immediately) are retried this many extra
    // times - some phones are on Do-Not-Disturb and drop the first ring.
    declineRetries: 1,
    // Dial reliability: retry placing the call this many times if it doesn't
    // actually start (so a flubbed click never silently no-ops the flow).
    maxDialAttempts: 3,
    // Hard watchdog: a single flow can never run longer than this. Guarantees
    // no hanging flows - it is force-aborted and reset past this cap.
    maxFlowSec: 180,
    // While we play an injected WAV, transcription is muted so the greeting
    // (and its echo off the callee's line) is never transcribed. This is the
    // extra mute time after a clip finishes to swallow trailing echo.
    echoMuteTailMs: 800,
    // Regex fallback used only when no OpenAI key is set (intent classifier off).
    triggerPattern: "call\\s*back|wasn'?t me|not me|call me",
    // A call that ends within this many seconds without ever being answered is
    // classified as an instant decline (vs a no-pickup that rings the timeout).
    instantDeclineSec: 6,
    // DTMF keypress trigger tuning (Testing tab only). Optional - dtmf.js holds
    // sensible defaults, these override them. The window slides every hopMs so
    // short taps are caught regardless of alignment. Loosen magThreshold/
    // dominance further if single-digit detection is unreliable on the carrier.
    dtmf: {
      windowMs: 25, // Goertzel analysis window (needs ~20-25ms for freq res)
      hopMs: 10, // slide the window this often (overlap catches short taps)
      magThreshold: 0.04, // min tone power as a fraction of (window energy * N)
      dominance: 3, // strongest tone must beat the next in its group by this much
      maxTwist: 12, // allowed low/high tone power ratio (either direction)
      persistHops: 2, // same digit must hold this many consecutive hops
      gapHops: 3, // non-detecting hops before the same key can re-emit
    },
  },

  // Intent classification for the customer's spoken reply. The flow sends the
  // live transcript here to decide whether the reply qualifies as a "callback"
  // (needs a human follow-up) vs "no_callback" (handled) vs "unclear".
  intent: {
    model: "gpt-4o-mini", // cheap + fast; any chat-completions model works
    timeoutMs: 6000, // never let a classification hang the call flow
    prompt: [
      "You are an intent classifier for an automated outbound verification phone call.",
      "",
      "CONTEXT: We call a customer to ask whether THEY personally performed a specific",
      "recent action on their account (for example a charge, login, transfer, or change).",
      "If the customer did NOT do it (or wants a human), a real agent will call them back.",
      "You are given the customer's spoken reply as a live speech-to-text transcript, which",
      "may be partial, noisy, or misspelled.",
      "",
      'Return STRICT JSON only: {"intent": "...", "confidence": 0.0, "reason": "..."}',
      "",
      "intent must be exactly one of:",
      '- "callback": The customer denies doing it, says it was not them, is worried or',
      "  confused about it, asks us or a person to call them back, or wants to speak to",
      '  someone. Examples: "this wasn\'t me", "I didn\'t do that", "no that\'s not me",',
      '  "call me back", "can someone call me", "I never made that charge", "what is this".',
      '- "no_callback": The customer confirms it was them / it is fine / acknowledges, so',
      '  no human follow-up is needed. Examples: "yes that was me", "yeah I did that",',
      '  "that\'s correct", "it\'s fine", "no problem".',
      '- "call_screening": Either (a) an automated call-screening system / robocall filter,',
      "  OR (b) a HUMAN gatekeeper (receptionist, assistant, family member) who answers and",
      "  screens the call by asking the CALLER to identify themselves or state their business",
      "  before deciding whether to connect the intended person. The hallmark is that the",
      "  speaker is acting as an intermediary to the person we are trying to reach. Examples:",
      '  "say your name after the tone", "please state the reason for your call", "press 1',
      '  to connect", "this call is being screened", "the person you are calling uses a',
      '  call screening service", "please provide your name and I\'ll see if this person is',
      '  available", "may I ask who\'s calling?", "who\'s calling please?", "can I take a',
      '  message?", "let me see if they\'re available", "what is this regarding?", "are they',
      '  expecting your call?".',
      '- "wrong_number": A carrier/operator intercept saying the number is invalid or',
      "  unreachable. Examples: \"the number you have dialed is not in service\", \"has been",
      '  disconnected", "no longer in service", "please check the number and dial again",',
      '  "your call cannot be completed as dialed".',
      '- "unclear": Not enough information yet - greetings ("hello", "who is this"), filler,',
      "  background noise, or anything you cannot confidently map to the labels above.",
      "",
      "Rules:",
      '- Prefer "unclear" over guessing. Only choose a definite label when clear.',
      '- Any denial, or any request for a human or a callback, is always "callback".',
      '- A bare greeting like "hello" or "who is this?" from the person themselves is',
      '  "unclear", NOT "call_screening". It is only "call_screening" when the speaker is',
      "  screening on someone else's behalf (offering to check if the person is available,",
      "  asking who is calling/what it is regarding before connecting, or taking a message).",
      "- Output JSON only, with no surrounding text.",
    ].join("\n"),
  },

  // NodeMaven residential proxy. Each account is assigned a sticky US
  // state/city + session id (see accounts.js) so it always egresses from the
  // same residential IP. Creds come from .env.
  proxy: {
    enabled: String(process.env.PROXY_ENABLED || "").toLowerCase() === "true",
    host: "gate.nodemaven.com",
    port: 8080, // HTTP (8080-9080 / 32000-33000). SOCKS5 would be 1080.
    socksPort: 1080, // NodeMaven SOCKS5 port (only used when useSocks5 is on).
    user: process.env.NODEMAVEN_USER || "",
    pass: process.env.NODEMAVEN_PASS || "",
    country: "us",
    filter: "medium", // IP quality filter ("medium"/"high"/"low"; empty for none)
    // Prioritize NodeMaven's fast IP pool by adding "speed-fast" to the proxy
    // username (e.g. filter-medium-speed-fast = Quality + Speed). Default ON;
    // set PROXY_SPEED_FAST=false to disable.
    speedFast: String(process.env.PROXY_SPEED_FAST ?? "true").toLowerCase() !== "false",
    // Reduce WebRTC IP leakage past the proxy. "default_public_interface_only"
    // keeps calls working while not exposing local/private candidates.
    webrtcPolicy: "default_public_interface_only",
    // Route Chromium through a localhost HTTP proxy that injects NodeMaven auth
    // on the CONNECT tunnel. Fixes ERR_TUNNEL_CONNECTION_FAILED that Chromium
    // hits with long encoded proxy usernames. Default ON; set PROXY_BRIDGE=false
    // to fall back to passing creds straight to Playwright.
    bridge: String(process.env.PROXY_BRIDGE ?? "true").toLowerCase() !== "false",
    // Fallback diagnostics (off by default):
    //  - useSocks5: use SOCKS5 (port 1080) instead of HTTP 8080.
    //  - useBundledChromium: skip channel:"chrome" for proxy sessions.
    useSocks5: String(process.env.PROXY_USE_SOCKS5 || "").toLowerCase() === "true",
    useBundledChromium:
      String(process.env.PROXY_USE_BUNDLED_CHROMIUM || "").toLowerCase() === "true",
  },

  // Telegram notifications (call-back / "claimed a line"). From .env.
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
  },
};

export function greetingPath() {
  return path.join(config.audioDir, config.greetingFile);
}
export function followupPath() {
  return path.join(config.audioDir, config.followupFile);
}
