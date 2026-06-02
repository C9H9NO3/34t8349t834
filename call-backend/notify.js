// Sends Telegram notifications (e.g. "claimed a line" on a call-back success).
// Uses Node's https only - no extra deps. Token/chat come from config (.env).
// If no chat id is configured, it is resolved once via getUpdates (send any
// message to the bot first) and cached for the process lifetime.

import https from "node:https";
import { config } from "./config.js";

let resolvedChatId = null;
let onLog = null;
export function setNotifyLogger(fn) {
  onLog = typeof fn === "function" ? fn : null;
}
function log(m) {
  if (onLog) onLog(m);
}

function tgRequest(method, payload) {
  return new Promise((resolve, reject) => {
    const token = config.telegram.botToken;
    if (!token) return reject(new Error("no TELEGRAM_BOT_TOKEN configured"));
    const body = JSON.stringify(payload || {});
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ ok: false, raw: data });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Resolves the destination chat id: explicit config first, else the most recent
// chat that messaged the bot (getUpdates).
async function resolveChatId() {
  if (config.telegram.chatId) return config.telegram.chatId;
  if (resolvedChatId) return resolvedChatId;
  const r = await tgRequest("getUpdates", {});
  const updates = (r && r.result) || [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const msg = updates[i].message || updates[i].channel_post;
    if (msg && msg.chat && msg.chat.id != null) {
      resolvedChatId = String(msg.chat.id);
      log(`Telegram chat id resolved: ${resolvedChatId}`);
      return resolvedChatId;
    }
  }
  return null;
}

export function telegramConfigured() {
  return Boolean(config.telegram.botToken);
}

// Updates the live Telegram credentials at runtime (from the Settings tab) and
// clears the cached resolved chat id so a changed chat id takes effect.
export function configureTelegram({ botToken, chatId } = {}) {
  if (typeof botToken === "string") config.telegram.botToken = botToken.trim();
  if (typeof chatId === "string") config.telegram.chatId = chatId.trim();
  resolvedChatId = null;
}

// Sends a plain-text message. Returns true on success.
export async function sendTelegram(text) {
  try {
    if (!telegramConfigured()) {
      log("Telegram not configured (no bot token) - skipping notification.");
      return false;
    }
    const chatId = await resolveChatId();
    if (!chatId) {
      log("Telegram: no chat id. Send any message to the bot once, then retry.");
      return false;
    }
    const r = await tgRequest("sendMessage", { chat_id: chatId, text });
    if (r && r.ok) return true;
    log(`Telegram send failed: ${JSON.stringify(r && (r.description || r))}`);
    return false;
  } catch (err) {
    log(`Telegram error: ${err.message}`);
    return false;
  }
}
