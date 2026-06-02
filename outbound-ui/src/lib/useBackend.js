import { useCallback, useEffect, useRef, useState } from "react";
import { digits } from "./format.js";
import { loadTelegram } from "./settingsStore.js";

// In production the dashboard is served by the backend, so the control WS and
// HTTP API are same-origin. In Vite dev (port 5173) the backend is on 8787.
// VITE_BACKEND_WS / VITE_BACKEND_HTTP can override both explicitly.
function httpBase() {
  if (import.meta.env && import.meta.env.VITE_BACKEND_HTTP) return import.meta.env.VITE_BACKEND_HTTP;
  const { hostname, port, origin } = window.location;
  if (port === "5173") return `http://${hostname}:8787`;
  return origin;
}
function controlUrl() {
  if (import.meta.env && import.meta.env.VITE_BACKEND_WS) return import.meta.env.VITE_BACKEND_WS;
  const { protocol, hostname, port, host } = window.location;
  if (port === "5173") return `ws://${hostname}:8787/control`;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/control`;
}
const CONTROL_URL = controlUrl();
const HTTP_BASE = httpBase();

// React hook: connects to the local call-backend control WebSocket, exposes the
// live per-session status/transcript, campaign progress, lead outcomes, logs,
// and a send() to issue commands. Auto-reconnects.
export function useBackend() {
  const [connected, setConnected] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [sttEnabled, setSttEnabled] = useState(false);
  const [headless, setHeadless] = useState(false);
  // True when the backend runs on the live server (login is local-only; the
  // Accounts tab shows "Import session" instead of the headed login flow).
  const [hosted, setHosted] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [locations, setLocations] = useState([]);
  const [logs, setLogs] = useState([]);
  // Per-session state keyed by account id: { id, label, call, number, audio,
  // flowStep, audioCapture, flowRunning, transcript: [{kind,text}] }.
  const [sessions, setSessions] = useState({});
  const [campaign, setCampaign] = useState({ running: false, total: 0, done: 0, inFlight: 0, counts: {} });
  // Per-number outcome, keyed by digits(number).
  const [leadStatus, setLeadStatus] = useState({});
  // Persisted per-number call-outcome history from the backend, keyed by digits.
  const [callHistory, setCallHistory] = useState({});
  // Telegram config status for the Settings tab: { configured, chatId(masked) }.
  const [telegram, setTelegram] = useState({ configured: false, chatId: "" });
  // Latest egress-IP check result per account id: { ok, ip, city, region, country, org, error }.
  const [proxyResults, setProxyResults] = useState({});
  // Transient toast notifications: [{ id, kind: "ok"|"err"|"info", message }].
  const [toasts, setToasts] = useState([]);
  // Auth gate (hosted mode). authRequired => show the login screen.
  const [authRequired, setAuthRequired] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState("");
  const wsRef = useRef(null);
  const retryRef = useRef(null);
  const toastSeq = useRef(0);

  const dismissToast = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const pushToast = useCallback((kind, message) => {
    const id = ++toastSeq.current;
    setToasts((t) => [...t.slice(-4), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const upsertSession = useCallback((id, patch) => {
    setSessions((prev) => {
      const cur = prev[id] || { id, transcript: [] };
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }, []);

  const connect = useCallback(() => {
    let ws;
    try {
      ws = new WebSocket(CONTROL_URL);
    } catch {
      scheduleRetry();
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // Push the locally-saved Telegram creds so the backend always has the
      // latest after any restart (seeded with working defaults on first run).
      try {
        const { botToken, chatId } = loadTelegram();
        if (botToken || chatId) {
          ws.send(JSON.stringify({ type: "setTelegram", botToken, chatId }));
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      setConnected(false);
      scheduleRetry();
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "status":
          if (typeof msg.loggedIn === "boolean") setLoggedIn(msg.loggedIn);
          if (typeof msg.stt === "boolean") setSttEnabled(msg.stt);
          if (typeof msg.headless === "boolean") setHeadless(msg.headless);
          if (typeof msg.hosted === "boolean") setHosted(msg.hosted);
          if (typeof msg.proxyEnabled === "boolean") setProxyEnabled(msg.proxyEnabled);
          if (Array.isArray(msg.accounts)) setAccounts(msg.accounts);
          if ("activeId" in msg) setActiveId(msg.activeId);
          if (msg.campaign) setCampaign(msg.campaign);
          if ("telegram" in msg || "telegramChatId" in msg) {
            setTelegram({ configured: Boolean(msg.telegram), chatId: msg.telegramChatId || "" });
          }
          break;
        case "accounts":
          if (Array.isArray(msg.accounts)) setAccounts(msg.accounts);
          if ("activeId" in msg) setActiveId(msg.activeId);
          break;
        case "locations":
          if (Array.isArray(msg.locations)) setLocations(msg.locations);
          break;
        case "sessions":
          // Snapshot: merge in state fields, preserve existing transcripts.
          setSessions((prev) => {
            const next = {};
            for (const s of msg.sessions || []) {
              const cur = prev[s.id] || { transcript: [] };
              next[s.id] = { ...cur, ...s };
            }
            return next;
          });
          break;
        case "sessionStatus":
          if (msg.id && msg.state) upsertSession(msg.id, msg.state);
          break;
        case "sessionAudio":
          if (msg.id) upsertSession(msg.id, { audioCapture: msg.connected });
          break;
        case "sessionTranscript":
          if (msg.id) {
            setSessions((prev) => {
              const cur = prev[msg.id] || { id: msg.id, transcript: [] };
              const tr = cur.transcript.filter((x) => x.kind !== "partial");
              if (msg.kind === "partial") tr.push({ kind: "partial", text: msg.text });
              else tr.push({ kind: "final", text: msg.text });
              return { ...prev, [msg.id]: { ...cur, transcript: tr.slice(-200) } };
            });
          }
          break;
        case "sessionClearTranscript":
          if (msg.id) upsertSession(msg.id, { transcript: [] });
          break;
        case "flowHeard":
          if (msg.id) upsertSession(msg.id, { flowStep: `heard: "${msg.text}"` });
          break;
        case "campaign":
          setCampaign({
            running: msg.running,
            total: msg.total,
            done: msg.done,
            inFlight: msg.inFlight,
            counts: msg.counts || {},
          });
          break;
        case "leadStatus":
          setLeadStatus((prev) => ({
            ...prev,
            [digits(msg.number)]: {
              number: msg.number,
              status: msg.status,
              category: msg.category,
              reason: msg.reason,
              attempts: msg.attempts,
            },
          }));
          break;
        case "callHistory":
          if (msg.entries && typeof msg.entries === "object") setCallHistory(msg.entries);
          break;
        case "callOutcome": {
          const key = digits(msg.number);
          const entry = {
            number: msg.number,
            category: msg.category,
            reason: msg.reason,
            via: msg.via,
            attempts: msg.attempts,
            lastCalledAt: new Date().toISOString(),
          };
          setCallHistory((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), ...entry } }));
          // Also reflect on the queue marks for manual (non-campaign) dials.
          setLeadStatus((prev) => ({
            ...prev,
            [key]: { number: msg.number, status: "done", category: msg.category, reason: msg.reason, attempts: msg.attempts },
          }));
          break;
        }
        case "telegramResult":
          pushToast(msg.ok ? "ok" : "err", msg.ok ? "Telegram test sent." : `Telegram: ${msg.error || "failed"}`);
          break;
        case "proxyResult":
          setProxyResults((p) => ({ ...p, [msg.id]: msg }));
          pushToast(
            msg.ok ? "ok" : "err",
            msg.ok
              ? `IP ${msg.ip || "?"}${
                  [msg.city, msg.region, msg.country].filter(Boolean).length
                    ? " - " + [msg.city, msg.region, msg.country].filter(Boolean).join(", ")
                    : ""
                }`
              : `Check IP failed: ${msg.error || "unknown error"}`
          );
          break;
        case "loginResult":
          if (typeof msg.loggedIn === "boolean") setLoggedIn(msg.loggedIn);
          pushToast(
            msg.error ? "err" : "ok",
            msg.error ? `Login failed: ${msg.error}` : msg.message || "Login window opened."
          );
          break;
        case "log":
          setLogs((l) => [...l.slice(-200), { t: Date.now(), message: msg.message }]);
          // No generic log -> toast: structured proxyResult/loginResult events
          // already cover user actions, and blanket toasting floods on bridge noise.
          break;
        default:
          break;
      }
    };
  }, [upsertSession, pushToast]);

  const scheduleRetry = useCallback(() => {
    if (retryRef.current) return;
    retryRef.current = setTimeout(() => {
      retryRef.current = null;
      connect();
    }, 2000);
  }, [connect]);

  // Before connecting, ask the backend whether a password is required. If auth
  // is off or we already hold a valid cookie, connect immediately; otherwise
  // surface the login screen and wait for login().
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${httpBase()}/api/auth-status`, { credentials: "include" });
        const s = await r.json();
        if (cancelled) return;
        setAuthChecked(true);
        if (s.authEnabled && !s.authorized) {
          setAuthRequired(true);
        } else {
          setAuthRequired(false);
          connect();
        }
      } catch {
        // Backend unreachable / no auth endpoint: just try to connect.
        if (cancelled) return;
        setAuthChecked(true);
        connect();
      }
    })();
    return () => {
      cancelled = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  const login = useCallback(
    async (password) => {
      setAuthError("");
      try {
        const r = await fetch(`${httpBase()}/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ password }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          setAuthError(body.error || "Wrong password.");
          return false;
        }
        setAuthRequired(false);
        connect();
        return true;
      } catch (err) {
        setAuthError("Could not reach the server.");
        return false;
      }
    },
    [connect]
  );

  const send = useCallback((type, payload = {}) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...payload }));
    }
  }, []);

  const clearTranscript = useCallback(
    (id) => {
      if (id) upsertSession(id, { transcript: [] });
    },
    [upsertSession]
  );

  return {
    connected,
    loggedIn,
    sttEnabled,
    headless,
    hosted,
    httpBase: HTTP_BASE,
    proxyEnabled,
    accounts,
    activeId,
    locations,
    logs,
    sessions,
    campaign,
    leadStatus,
    callHistory,
    telegram,
    proxyResults,
    toasts,
    dismissToast,
    authRequired,
    authChecked,
    authError,
    login,
    send,
    clearTranscript,
  };
}
