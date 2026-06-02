import React, { useMemo, useState } from "react";
import { IconSettings } from "./icons.jsx";
import { loadTelegram, saveTelegram } from "../lib/settingsStore.js";
import { CATEGORY_META, CATEGORY_ORDER } from "../lib/outcomes.js";

// Settings tab: configure Telegram notification credentials (persisted to
// localStorage and pushed to the backend), and review/clear the persistent
// per-number call-outcome history.
export default function SettingsPanel({ be }) {
  const initial = loadTelegram();
  const [botToken, setBotToken] = useState(initial.botToken);
  const [chatId, setChatId] = useState(initial.chatId);
  const [savedAt, setSavedAt] = useState(0);

  function save() {
    const creds = { botToken: botToken.trim(), chatId: chatId.trim() };
    saveTelegram(creds);
    be.send("setTelegram", creds);
    setSavedAt(Date.now());
  }
  function sendTest() {
    // Save first so the backend tests against the values shown.
    save();
    be.send("testTelegram");
  }

  const history = be.callHistory || {};
  const byCategory = useMemo(() => {
    const c = {};
    for (const e of Object.values(history)) {
      if (!e || !e.category) continue;
      c[e.category] = (c[e.category] || 0) + 1;
    }
    return c;
  }, [history]);
  const total = Object.keys(history).length;

  return (
    <div className="settings-panel">
      <div className="page-head">
        <div>
          <h2>
            <IconSettings size={20} /> Settings
          </h2>
          <p>Notification credentials and saved call-outcome history.</p>
        </div>
      </div>

      <section className="card">
        <div className="card-header">
          <span className="section-label">Telegram notifications</span>
          <span className={"pill " + (be.telegram?.configured ? "mk-pickedup" : "")}>
            {be.telegram?.configured
              ? `Active${be.telegram.chatId ? ` · chat ${be.telegram.chatId}` : ""}`
              : "Not configured"}
          </span>
        </div>
        <div className="card-body settings-form">
          <p className="hint">
            Used to alert you when a line is claimed. Saved on this device and sent to the
            backend (so it survives restarts). Message your bot once if the chat id is blank.
          </p>
          <div className="field">
            <label>Bot token</label>
            <input
              className="acct-num-input settings-input"
              type="text"
              placeholder="123456:ABC-DEF…"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Chat ID</label>
            <input
              className="acct-num-input settings-input"
              type="text"
              placeholder="e.g. 5167283083"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
            />
          </div>
          <div className="ca-actions" style={{ marginTop: 4 }}>
            <button className="btn" disabled={!be.connected} onClick={save}>
              Save
            </button>
            <button className="btn btn-ghost" disabled={!be.connected} onClick={sendTest}>
              Send test
            </button>
            {savedAt > 0 && <span className="muted">Saved.</span>}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <span className="section-label">Call history</span>
          <span className="badge">{total}</span>
        </div>
        <div className="card-body settings-form">
          <p className="hint">
            Every concluded call is recorded here per number. Re-runs skip numbers whose last
            outcome is in a category you didn't select in a campaign's Re-call list.
          </p>
          {total === 0 ? (
            <p className="muted">No calls recorded yet.</p>
          ) : (
            <div className="settings-hist">
              {CATEGORY_ORDER.filter((c) => byCategory[c]).map((c) => (
                <div key={c} className="settings-hist-row">
                  <span className={"q-mark " + CATEGORY_META[c].cls}>{CATEGORY_META[c].label}</span>
                  <b>{byCategory[c]}</b>
                  <span className="ca-spacer" />
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={!be.connected}
                    onClick={() => be.send("clearCallHistory", { category: c })}
                  >
                    Clear
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="ca-actions" style={{ marginTop: 10 }}>
            <button
              className="btn btn-danger"
              disabled={!be.connected || total === 0}
              onClick={() => be.send("clearCallHistory", {})}
            >
              Clear all history
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
