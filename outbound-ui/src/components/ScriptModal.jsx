import React, { useEffect, useState } from "react";
import { openScriptTab } from "../lib/scriptTab.js";

export default function ScriptModal({ item, onClose }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!item) return null;
  const { contact, number, script } = item;

  function copyScript() {
    navigator.clipboard.writeText(script).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{contact.fullName || "(no name)"}</h2>
            <div className="modal-meta">
              {number && (
                <a className="tel" href={`tel:${number.replace(/[^\d+]/g, "")}`}>
                  {number}
                </a>
              )}
              {contact.emails[0] && <span className="muted">{contact.emails[0]}</span>}
              {contact.location && <span className="muted">{contact.location}</span>}
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            x
          </button>
        </header>

        <pre className="modal-script">{script}</pre>

        <footer className="modal-foot">
          <button className="btn" onClick={copyScript}>
            {copied ? "Copied!" : "Copy script"}
          </button>
          <button className="btn btn-ghost" onClick={() => openScriptTab(item)}>
            Open in new tab
          </button>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
