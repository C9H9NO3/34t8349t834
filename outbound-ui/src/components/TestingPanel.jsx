import React, { useEffect, useMemo, useRef, useState } from "react";
import { digits } from "../lib/format.js";
import AccountPicker from "./AccountPicker.jsx";
import CategoryPicker from "./CategoryPicker.jsx";
import { leadMark, loadRecallCats, saveRecallCats } from "../lib/outcomes.js";

// Splits a free-form list (commas, semicolons, spaces, or newlines) into a
// clean, de-duplicated list of numbers for ad-hoc testing.
function parseNumbers(raw) {
  const seen = new Set();
  const out = [];
  for (const piece of String(raw || "").split(/[\s,;]+/)) {
    const n = piece.trim();
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// A scratchpad for testing: paste your OWN numbers (not a leads DB) and dial /
// run a single flow through whichever account you pick. Every account stays
// active, so the chosen account id is sent explicitly with each action.
export default function TestingPanel({ be }) {
  const accounts = be.accounts || [];
  const [acctId, setAcctId] = useState(be.activeId || accounts[0]?.id || "");
  const [raw, setRaw] = useState("");

  // Keep a valid account selected as the list changes.
  useEffect(() => {
    if (accounts.length && !accounts.some((a) => a.id === acctId)) {
      setAcctId(accounts[0].id);
    }
  }, [accounts, acctId]);

  const [count, setCount] = useState(0);
  // Callback trigger: "voice" (intent), "dtmf1" (press 1), "dtmfAny" (any key),
  // "hybrid" (press 1 or speak).
  const [triggerMode, setTriggerMode] = useState("voice");
  // Which prior-outcome categories to re-call (others are skipped). Persisted.
  const [recallCats, setRecallCats] = useState(() => loadRecallCats());
  useEffect(() => saveRecallCats(recallCats), [recallCats]);
  const [selectedAccts, setSelectedAccts] = useState(() => new Set(accounts.map((a) => a.id)));
  const knownAccts = useRef(new Set(accounts.map((a) => a.id)));

  // Keep selections that still exist; brand-new accounts default to selected.
  useEffect(() => {
    const ids = accounts.map((a) => a.id);
    const idSet = new Set(ids);
    setSelectedAccts((prev) => {
      const next = new Set([...prev].filter((id) => idSet.has(id)));
      for (const id of ids) if (!knownAccts.current.has(id)) next.add(id);
      return next;
    });
    knownAccts.current = idSet;
  }, [accounts]);

  const numbers = useMemo(() => parseNumbers(raw), [raw]);
  const session = (be.sessions || {})[acctId] || null;
  const ready = Boolean(acctId) && be.connected;
  const camp = be.campaign || {};
  const counts = camp.counts || {};

  function dial(number) {
    if (!number || !acctId) return;
    be.send("dial", { number, id: acctId });
  }
  function startFlow(number) {
    if (!number || !acctId) return;
    be.send("startFlow", { number, id: acctId, triggerMode });
  }
  function startCampaign() {
    if (numbers.length === 0) return;
    const leads = numbers.map((n) => ({ number: n }));
    const n = count > 0 ? count : leads.length;
    be.send("startCampaign", {
      leads,
      count: n,
      accountIds: [...selectedAccts],
      triggerMode,
      recallCategories: [...recallCats],
    });
  }

  return (
    <div className="testing">
      <div className="page-head">
        <div>
          <h2>Testing</h2>
          <p>Paste your own numbers (comma, space, or line separated) and dial or run a single flow through any account. For quick checks — not a campaign.</p>
        </div>
      </div>

      {/* Control bar */}
      <div className="ca-controlbar">
        <span className={"dot " + (be.connected ? "dot-on" : "dot-off")} />
        <span className="ca-cb-conn">{be.connected ? "Connected" : "Backend offline"}</span>
        <div className="segmented" role="group" aria-label="Browser visibility">
          <button className={"seg " + (!be.headless ? "seg-on" : "")} onClick={() => be.send("setHeadless", { headless: false })}>
            Visible
          </button>
          <button className={"seg " + (be.headless ? "seg-on" : "")} onClick={() => be.send("setHeadless", { headless: true })}>
            Hidden
          </button>
        </div>
        <label className="muted">Callback trigger</label>
        <div className="segmented" role="group" aria-label="Callback trigger">
          <button className={"seg " + (triggerMode === "voice" ? "seg-on" : "")} onClick={() => setTriggerMode("voice")} title="Detect a spoken callback (intent classifier)">
            Voice
          </button>
          <button className={"seg " + (triggerMode === "dtmf1" ? "seg-on" : "")} onClick={() => setTriggerMode("dtmf1")} title="Pressing 1 after 1.wav registers a callback">
            Press 1
          </button>
          <button className={"seg " + (triggerMode === "dtmfAny" ? "seg-on" : "")} onClick={() => setTriggerMode("dtmfAny")} title="Any keypress after 1.wav registers a callback">
            Any key
          </button>
          <button className={"seg " + (triggerMode === "hybrid" ? "seg-on" : "")} onClick={() => setTriggerMode("hybrid")} title="Press 1 or speak — either registers a callback">
            Hybrid
          </button>
        </div>
        <span className="ca-spacer" />
        <label className="muted">Account</label>
        <select
          className="ca-acct-select"
          value={acctId}
          onChange={(e) => setAcctId(e.target.value)}
        >
          {accounts.length === 0 ? (
            <option value="">No accounts — add one first</option>
          ) : (
            accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))
          )}
        </select>
      </div>

      {!be.connected && (
        <div className="ca-offline muted">
          Backend offline - start it with <code>cd call-backend &amp;&amp; npm start</code>
        </div>
      )}

      {/* Campaign: run the pasted numbers in parallel across all logged-in accounts */}
      <section className="card ca-campaign">
        <div className="card-header">
          <span className="section-label">Campaign (parallel across all logged-in accounts)</span>
        </div>
        <div className="card-body ca-campaign-body">
          <AccountPicker accounts={accounts} selected={selectedAccts} onChange={setSelectedAccts} />
          <CategoryPicker selected={recallCats} onChange={setRecallCats} />
          <div className="muted" style={{ fontSize: 12 }}>
            Only logged-in accounts are used. Numbers whose last call ended in an unchecked category are skipped; never-called numbers always run.
          </div>
          <div className="ca-campaign-controls">
            <label className="muted">How many numbers</label>
            <input
              className="ca-count"
              type="number"
              min="0"
              placeholder={`${numbers.length}`}
              value={count || ""}
              onChange={(e) => setCount(parseInt(e.target.value, 10) || 0)}
            />
            <span className="muted">of {numbers.length} pasted</span>
            {camp.running ? (
              <button className="btn btn-danger" onClick={() => be.send("stopCampaign")}>Stop campaign</button>
            ) : (
              <button className="btn" disabled={!be.connected || numbers.length === 0} onClick={startCampaign}>
                Start campaign
              </button>
            )}
          </div>
          <div className="ca-campaign-progress">
            <span className="pill">{camp.running ? "Running" : "Idle"}</span>
            <span className="pill">Done <b>{camp.done || 0}</b>/{camp.total || 0}</span>
            <span className="pill">In flight <b>{camp.inFlight || 0}</b></span>
            <span className="pill mk-callback">Schedule callback <b>{counts.schedule_callback || 0}</b></span>
            <span className="pill mk-pickedup">Pickup silent <b>{counts.pickup_silent || 0}</b></span>
            <span className="pill mk-declined">Auto-decline <b>{counts.auto_decline || 0}</b></span>
            <span className="pill mk-nopickup">No answer <b>{counts.no_answer || 0}</b></span>
            <span className="pill mk-uncallable">Uncallable <b>{counts.uncallable || 0}</b></span>
          </div>
        </div>
      </section>

      <section className="card ca-console">
        <div className="card-header">
          <span className="section-label">Numbers to test</span>
          <span className="badge">{numbers.length}</span>
        </div>
        <div className="card-body">
          <textarea
            className="testing-input"
            rows={3}
            placeholder="e.g. +1 555 010 1234, +1 555 010 5678, 5550109999"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />

          <div className="ca-actions" style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => be.send("playAudio", { id: acctId })}>Play audio</button>
            <button className="btn btn-ghost" onClick={() => be.send("stopAudio", { id: acctId })}>Stop</button>
            <button className="btn btn-ghost" onClick={() => be.send("stopFlow", { id: acctId })}>Stop flow</button>
            <button className="btn btn-danger" onClick={() => be.send("hangup", { id: acctId })}>Hang up</button>
          </div>

          {numbers.length === 0 ? (
            <p className="muted" style={{ marginTop: 12 }}>Type or paste one or more numbers above to get per-number Dial / Flow buttons.</p>
          ) : (
            <ul className="queue-list" style={{ marginTop: 12 }}>
              {numbers.map((n, i) => {
                const mark = leadMark(be.leadStatus[digits(n)]);
                return (
                  <li key={`${n}-${i}`}>
                    <div className="q-info">
                      <span className="q-num">{n}</span>
                    </div>
                    {mark ? (
                      <span className={"q-mark " + mark.cls} title={mark.reason || ""}>{mark.label}</span>
                    ) : (
                      <div className="ec-actions">
                        <button className="btn btn-sm" disabled={!ready} onClick={() => dial(n)}>Dial</button>
                        <button className="btn btn-sm btn-ghost" disabled={!ready} onClick={() => startFlow(n)}>Start flow</button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* Live state of the selected account */}
      <section className="card ca-sessions">
        <div className="card-header">
          <span className="section-label">Live session</span>
          {session && <span className={"pill " + (session.call && session.call !== "idle" ? "pill-live" : "")}>{session.call || "idle"}</span>}
        </div>
        <div className="card-body">
          {!session ? (
            <p className="muted">No live session for this account yet. Dial or start a flow to open it.</p>
          ) : (
            <>
              <div className="sess-meta">
                {session.number ? <span className="sess-num">{session.number}</span> : <span className="muted">no number</span>}
                {session.flowStep ? <span className="sess-step muted">{session.flowStep}</span> : null}
              </div>
              <div className="sess-transcript">
                {!session.transcript || session.transcript.length === 0 ? (
                  <span className="muted">No transcript yet.</span>
                ) : (
                  session.transcript.map((t, i) => (
                    <span key={i} className={t.kind === "partial" ? "t-partial" : "t-final"}>
                      {t.text}{" "}
                    </span>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </section>

      {/* Activity log */}
      <section className="card ca-logcard">
        <div className="card-header">
          <span className="section-label">Activity log</span>
        </div>
        <div className="card-body">
          <div className="ca-log-lines">
            {be.logs.length === 0 ? (
              <div className="log-line muted">No activity yet.</div>
            ) : (
              be.logs.slice(-80).map((l, i) => (
                <div key={i} className="log-line">{l.message}</div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
