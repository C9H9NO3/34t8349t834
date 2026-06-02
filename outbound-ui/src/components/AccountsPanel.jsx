import React, { useEffect, useRef, useState } from "react";
import { prettyLoc, callbackPct } from "../lib/format.js";
import Modal from "./Modal.jsx";
import { IconAccounts, IconPlus } from "./icons.jsx";

// Inline editor for an account: edit its display number, and reassign its
// residential state/city. Cities update to match the selected state; saving a
// location reassigns a fresh residential IP and reopens the browser if active.
function AccountEditor({ be, account, onClose }) {
  const locs = be.locations || [];
  const [number, setNumber] = useState(account.phoneNumber || "");
  const [region, setRegion] = useState(account.proxy?.region || "");
  const [city, setCity] = useState(account.proxy?.city || "");
  const cities = locs.find((l) => l.region === region)?.cities || [];

  useEffect(() => {
    if (region && !cities.some((c) => c.city === city)) {
      setCity(cities[0]?.city || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region]);

  function saveNumber() {
    be.send("setAccountNumber", { id: account.id, phoneNumber: number.trim() });
  }
  function saveLocation() {
    if (!region) return;
    be.send("setAccountLocation", { id: account.id, region, city });
    onClose();
  }

  return (
    <div className="acct-loc-editor" onClick={(e) => e.stopPropagation()}>
      <div className="acct-edit-row">
        <input
          className="acct-num-input"
          type="tel"
          placeholder="Display number, e.g. +1 555 010 1234"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
        <button className="btn btn-sm" onClick={saveNumber}>Save number</button>
      </div>
      {locs.length === 0 ? (
        <div className="muted">Loading locations… (is the backend connected?)</div>
      ) : (
        <div className="acct-edit-row">
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            <option value="">State…</option>
            {locs.map((l) => (
              <option key={l.region} value={l.region}>{l.label}</option>
            ))}
          </select>
          <select value={city} onChange={(e) => setCity(e.target.value)} disabled={!region}>
            <option value="">City…</option>
            {cities.map((c) => (
              <option key={c.city} value={c.city}>{c.label}</option>
            ))}
          </select>
          <button className="btn btn-sm" onClick={saveLocation} disabled={!region}>Save location</button>
        </div>
      )}
      <button className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
    </div>
  );
}

function AddAccountModal({ onAdd, onClose }) {
  const [label, setLabel] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [note, setNote] = useState("");

  function submit(e) {
    e.preventDefault();
    if (!label && !phoneNumber) return;
    onAdd({ label, phoneNumber, note });
    onClose();
  }

  return (
    <Modal
      title="Add Google account"
      subtitle="Creates the account, then opens the cloud browser in a Remote browser window so you can finish Google login. The session is saved and assigned a sticky residential IP."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-row">
          <label>Label</label>
          <input placeholder="e.g. Sales line" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
        </div>
        <div className="modal-row">
          <label>Phone number (note)</label>
          <input placeholder="e.g. +1 555 010 1234" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} />
        </div>
        <div className="modal-row">
          <label>Note (optional)</label>
          <input placeholder="Anything to remember" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={!label && !phoneNumber}>Add &amp; log in</button>
        </div>
      </form>
    </Modal>
  );
}

// Connect / manage Google accounts as selectable cards. Each account is
// assigned a sticky residential proxy (state/city), shown on its card.
export default function AccountsPanel({ be }) {
  const [newestId, setNewestId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState(null); // pure UI highlight, no backend effect
  const [busy, setBusy] = useState({}); // id -> transient label ("Checking...", etc.)
  const [vncOpen, setVncOpen] = useState(false); // remote-browser (noVNC) viewer modal
  const prevIds = useRef(new Set(be.accounts.map((a) => a.id)));

  // Marks a card busy, sends the command, and auto-clears after a safety window.
  function runBusy(id, label, type) {
    setBusy((b) => ({ ...b, [id]: label }));
    be.send(type, { id });
    setTimeout(() => {
      setBusy((b) => (b[id] === label ? { ...b, [id]: undefined } : b));
    }, 8000);
  }

  // Opens the cloud browser for an account AND the noVNC viewer so the Google
  // login / Voice window can be seen and driven remotely (no local desktop).
  function openRemote(id, type, label) {
    runBusy(id, label, type);
    setVncOpen(true);
  }

  // Clear the "Checking..." badge as soon as that account's IP result arrives.
  useEffect(() => {
    setBusy((b) => {
      let changed = false;
      const next = { ...b };
      for (const id of Object.keys(b)) {
        if (b[id] === "Checking..." && be.proxyResults[id]) {
          next[id] = undefined;
          changed = true;
        }
      }
      return changed ? next : b;
    });
  }, [be.proxyResults]);

  // Detect a newly added account so we can highlight its assigned location.
  useEffect(() => {
    const current = be.accounts.map((a) => a.id);
    const added = current.find((id) => !prevIds.current.has(id));
    if (added) {
      setNewestId(added);
      const t = setTimeout(() => setNewestId(null), 8000);
      prevIds.current = new Set(current);
      return () => clearTimeout(t);
    }
    prevIds.current = new Set(current);
  }, [be.accounts]);

  return (
    <div className="accounts-tab">
      <div className="page-head">
        <div>
          <h2>Accounts</h2>
          <p>Connect Google accounts and manage their residential IPs. Use a card's Log in / Open browser to drive its cloud Chromium in the Remote browser window (sign in to Google there).</p>
        </div>
        <button className="btn" onClick={() => setAdding(true)}>
          <IconPlus size={15} /> Add Google account
        </button>
      </div>

      {/* Control bar */}
      <div className="ca-controlbar" style={{ marginBottom: 16 }}>
        <span className={"dot " + (be.connected ? "dot-on" : "dot-off")} />
        <span className="ca-cb-conn">{be.connected ? "Backend connected" : "Backend offline"}</span>
        {be.connected && (
          <span className={"ca-proxy " + (be.proxyEnabled ? "ca-proxy-on" : "ca-proxy-off")}>
            {be.proxyEnabled ? "Proxy ON" : "Proxy OFF — check .env"}
          </span>
        )}
        <span className="ca-spacer" />
        <button className="btn btn-ghost" onClick={() => be.send("status")}>Refresh</button>
      </div>

      {/* Account cards */}
      <div className="entity-grid">
        {be.accounts.map((a) => {
          const selected = a.id === selectedId;
          const s = a.stats || {};
          return (
            <div
              key={a.id}
              className={"entity-card " + (selected ? "selected " : "") + (a.id === newestId ? "just-added" : "")}
              onClick={() => setSelectedId(a.id)}
            >
              <span className="ec-check" />
              <div className="ec-top">
                <span className="ec-ico">
                  <IconAccounts size={18} />
                </span>
                <span className="ec-name">{a.label}</span>
              </div>
              <div className="acct-card-chips">
                <span className="acct-number">{a.phoneNumber || "no number"}</span>
                {a.proxy && (
                  <span className="acct-proxy" title={`Sticky residential IP, sid ${a.proxy.sid}`}>
                    {prettyLoc(a.proxy)}
                  </span>
                )}
              </div>

              {a.stats && (
                <div className="acct-card-stats">
                  <span><b>{s.calls || 0}</b> calls</span>
                  <span><b>{s.noPickup || 0}</b> no-pickup</span>
                  <span><b>{s.instantDecline || 0}</b> declined</span>
                  <span><b>{callbackPct(s)}%</b> call-back</span>
                </div>
              )}

              {(() => {
                const pr = be.proxyResults[a.id];
                if (busy[a.id]) return <div className="acct-ip muted">{busy[a.id]}</div>;
                if (!pr) return null;
                return pr.ok ? (
                  <div className="acct-ip ok">
                    IP {pr.ip || "?"}
                    {[pr.city, pr.region, pr.country].filter(Boolean).length
                      ? " - " + [pr.city, pr.region, pr.country].filter(Boolean).join(", ")
                      : ""}
                  </div>
                ) : (
                  <div className="acct-ip err">{pr.error}</div>
                );
              })()}

              <div className="ec-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => setEditingId(editingId === a.id ? null : a.id)}
                >
                  {editingId === a.id ? "Close" : "Edit"}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={Boolean(busy[a.id])}
                  onClick={() => runBusy(a.id, "Checking...", "checkProxy")}
                >
                  {busy[a.id] === "Checking..." ? "Checking..." : "Check IP"}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={busy[a.id] === "Rotating..."}
                  onClick={() => runBusy(a.id, "Rotating...", "rotateProxy")}
                  title="Assign a fresh residential IP from the fast pool (same city)"
                >
                  {busy[a.id] === "Rotating..." ? "Rotating..." : "Rotate IP"}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={busy[a.id] === "Opening browser..."}
                  onClick={() => openRemote(a.id, "showBrowser", "Opening browser...")}
                >
                  {busy[a.id] === "Opening browser..." ? "Opening..." : "Open browser"}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={busy[a.id] === "Opening login..."}
                  onClick={() => openRemote(a.id, "loginAccount", "Opening login...")}
                >
                  {busy[a.id] === "Opening login..." ? "Opening..." : "Log in"}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => be.send("removeAccount", { id: a.id })}>
                  Remove
                </button>
              </div>

              {editingId === a.id && (
                <AccountEditor be={be} account={a} onClose={() => setEditingId(null)} />
              )}
            </div>
          );
        })}

        <button className="add-card" onClick={() => setAdding(true)}>
          <IconPlus size={20} />
          Add Google account
        </button>
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <span className="section-label">Activity</span>
          <span className="muted">latest first</span>
        </div>
        <div className="card-body">
          <div className="ca-log-lines">
            {be.logs.length === 0 ? (
              <div className="log-line muted">No activity yet. Check IP or Log in to see results here.</div>
            ) : (
              be.logs
                .slice(-80)
                .reverse()
                .map((l, i) => (
                  <div key={i} className="log-line">{l.message}</div>
                ))
            )}
          </div>
        </div>
      </section>

      {adding && (
        <AddAccountModal
          onAdd={(payload) => {
            be.send("addAccount", payload);
            setVncOpen(true); // backend opens the cloud browser for Google login
          }}
          onClose={() => setAdding(false)}
        />
      )}

      {vncOpen && (
        <Modal
          title="Remote browser"
          subtitle="This is the cloud Chromium. Complete the Google sign-in here; the session is saved and reused for calls."
          onClose={() => setVncOpen(false)}
        >
          <iframe
            className="vnc-frame"
            title="Remote browser"
            src="/vnc/vnc.html?path=vnc/websockify&autoconnect=true&resize=remote&reconnect=true"
          />
        </Modal>
      )}
    </div>
  );
}
