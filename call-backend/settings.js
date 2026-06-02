// Runtime-editable settings persisted from the UI (Settings tab). Currently
// holds Telegram credentials so they survive backend restarts even though the
// UI also keeps them in localStorage. Loaded on startup and applied over .env.

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

function read() {
  try {
    const raw = fs.readFileSync(config.settingsFile, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") return data;
  } catch {
    /* missing/invalid -> empty */
  }
  return {};
}

function write(data) {
  fs.mkdirSync(path.dirname(config.settingsFile), { recursive: true });
  fs.writeFileSync(config.settingsFile, JSON.stringify(data, null, 2), "utf8");
}

// Applies persisted settings onto the live config. Called once at startup.
export function load() {
  const data = read();
  if (data.telegram && typeof data.telegram === "object") {
    if (typeof data.telegram.botToken === "string" && data.telegram.botToken) {
      config.telegram.botToken = data.telegram.botToken;
    }
    if (typeof data.telegram.chatId === "string") {
      config.telegram.chatId = data.telegram.chatId;
    }
  }
  return data;
}

// Persists the Telegram credentials.
export function saveTelegram({ botToken, chatId }) {
  const data = read();
  data.telegram = {
    botToken: typeof botToken === "string" ? botToken : data.telegram?.botToken || "",
    chatId: typeof chatId === "string" ? chatId : data.telegram?.chatId || "",
  };
  write(data);
  return data.telegram;
}
