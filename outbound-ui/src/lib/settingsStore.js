// Frontend-persisted settings (localStorage). Currently the Telegram bot
// credentials used for call notifications. Defaults are intentionally blank
// (no secrets in the repo); set them once in the Settings tab and they persist
// in localStorage. The backend can also be seeded via TELEGRAM_BOT_TOKEN /
// TELEGRAM_CHAT_ID env vars. The backend receives them via the "setTelegram"
// command on connect.

export const TG_TOKEN_KEY = "ob_tg_token";
export const TG_CHAT_KEY = "ob_tg_chat";

// No baked-in credentials. Configure in Settings (saved to localStorage).
export const DEFAULT_TG = {
  botToken: "",
  chatId: "",
};

export function loadTelegram() {
  try {
    const botToken = localStorage.getItem(TG_TOKEN_KEY);
    const chatId = localStorage.getItem(TG_CHAT_KEY);
    return {
      botToken: botToken !== null ? botToken : DEFAULT_TG.botToken,
      chatId: chatId !== null ? chatId : DEFAULT_TG.chatId,
    };
  } catch {
    return { ...DEFAULT_TG };
  }
}

export function saveTelegram({ botToken, chatId }) {
  try {
    localStorage.setItem(TG_TOKEN_KEY, botToken || "");
    localStorage.setItem(TG_CHAT_KEY, chatId || "");
  } catch {
    /* ignore */
  }
}
