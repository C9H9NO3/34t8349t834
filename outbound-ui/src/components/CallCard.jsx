import React, { useState } from "react";
import { STATUSES, STATUS_CLASS } from "../constants.js";
import { openScriptTab } from "../lib/scriptTab.js";

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function CallCard({ item, record, onUpdate, onExpand }) {
  const { contact, number, script } = item;
  const status = record.status || "Not called";
  const [copied, setCopied] = useState(false);

  function setStatus(next) {
    const patch = { status: next };
    // Auto-stamp the call time the first time it is marked Called.
    if (next === "Called" && !record.calledAt) {
      patch.calledAt = new Date().toISOString();
    }
    onUpdate(item.id, patch);
  }

  function copyScript() {
    navigator.clipboard.writeText(script).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <article className={"card " + STATUS_CLASS[status]}>
      <header className="card-head">
        <div className="card-id">
          <h3>{contact.fullName || "(no name)"}</h3>
          <div className="card-meta">
            {number ? (
              <a className="tel" href={`tel:${number.replace(/[^\d+]/g, "")}`}>
                {number}
              </a>
            ) : (
              <span className="muted">no number</span>
            )}
            {contact.emails[0] && (
              <a className="email" href={`mailto:${contact.emails[0]}`}>
                {contact.emails[0]}
              </a>
            )}
            {contact.location && <span className="loc">{contact.location}</span>}
          </div>
        </div>
        <select
          className={"status-select " + STATUS_CLASS[status]}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </header>

      <pre className="script" onClick={() => onExpand(item)} title="Click to view full script">
        {script}
      </pre>

      <div className="card-actions">
        <button className="btn" onClick={copyScript}>
          {copied ? "Copied!" : "Copy script"}
        </button>
        <button className="btn btn-ghost" onClick={() => onExpand(item)}>
          View full
        </button>
        <button className="btn btn-ghost" onClick={() => openScriptTab(item)}>
          New tab
        </button>
        <div className="call-time">
          {record.calledAt ? (
            <>
              <span className="muted">Called {formatTime(record.calledAt)}</span>
              <button
                className="link-btn"
                onClick={() => onUpdate(item.id, { calledAt: "" })}
              >
                clear
              </button>
            </>
          ) : (
            <button
              className="link-btn"
              onClick={() => onUpdate(item.id, { calledAt: new Date().toISOString() })}
            >
              stamp call time
            </button>
          )}
        </div>
      </div>

      <textarea
        className="notes"
        placeholder="Notes..."
        value={record.notes || ""}
        onChange={(e) => onUpdate(item.id, { notes: e.target.value })}
      />
    </article>
  );
}
