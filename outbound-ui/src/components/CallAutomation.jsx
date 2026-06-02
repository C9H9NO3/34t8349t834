import React, { useEffect, useMemo, useRef, useState } from "react";
import GroupSelect from "./GroupSelect.jsx";
import AccountPicker from "./AccountPicker.jsx";
import CategoryPicker from "./CategoryPicker.jsx";
import { digits } from "../lib/format.js";
import { leadMark, loadRecallCats, saveRecallCats } from "../lib/outcomes.js";

// Builds a flat call queue (one row per number) from the parsed contacts.
function buildQueue(contacts) {
  const rows = [];
  contacts.forEach((c) => {
    (c.numbers.length ? c.numbers : []).forEach((number) => {
      rows.push({
        name: c.fullName,
        number,
        email: (c.emails && c.emails[0]) || "",
        city: c.city,
        state: c.state,
      });
    });
  });
  return rows;
}

function SessionCard({ s }) {
  const inCall = s.call && s.call !== "idle";
  return (
    <div className={"sess-card " + (inCall ? "in-call" : "")}>
      <div className="sess-head">
        <span className="sess-label">{s.label || s.id?.slice(0, 8)}</span>
        <span className={"pill " + (inCall ? "pill-live" : "")}>{s.call || "idle"}</span>
        <span className={"sess-cap " + (s.audioCapture ? "on" : "")}>
          {s.audioCapture ? "Listening" : "—"}
        </span>
      </div>
      <div className="sess-meta">
        {s.number ? <span className="sess-num">{s.number}</span> : <span className="muted">no number</span>}
        {s.flowStep ? <span className="sess-step muted">{s.flowStep}</span> : null}
      </div>
      <div className="sess-transcript">
        {!s.transcript || s.transcript.length === 0 ? (
          <span className="muted">No transcript yet.</span>
        ) : (
          s.transcript.map((t, i) => (
            <span key={i} className={t.kind === "partial" ? "t-partial" : "t-final"}>
              {t.text}{" "}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

export default function CallAutomation({ be, contacts, groups, activeGroupId, setActiveGroupId }) {
  const queue = useMemo(() => buildQueue(contacts), [contacts]);
  const [count, setCount] = useState(0);
  const [search, setSearch] = useState("");
  // Callback trigger: "voice" (intent), "dtmf1" (press 1), "dtmfAny" (any key),
  // "hybrid" (press 1 or speak).
  const [triggerMode, setTriggerMode] = useState("voice");
  // Which prior-outcome categories to re-call (others are skipped). Persisted.
  const [recallCats, setRecallCats] = useState(() => loadRecallCats());
  useEffect(() => saveRecallCats(recallCats), [recallCats]);
  const [selectedAccts, setSelectedAccts] = useState(() => new Set(be.accounts.map((a) => a.id)));
  const knownAccts = useRef(new Set(be.accounts.map((a) => a.id)));

  // Keep selections that still exist; brand-new accounts default to selected.
  useEffect(() => {
    const ids = be.accounts.map((a) => a.id);
    const idSet = new Set(ids);
    setSelectedAccts((prev) => {
      const next = new Set([...prev].filter((id) => idSet.has(id)));
      for (const id of ids) if (!knownAccts.current.has(id)) next.add(id);
      return next;
    });
    knownAccts.current = idSet;
  }, [be.accounts]);

  const sessionList = useMemo(() => Object.values(be.sessions || {}), [be.sessions]);
  const activeAccount = be.accounts.find((a) => a.id === be.activeId) || null;
  const ready = Boolean(activeAccount) && be.loggedIn;
  const camp = be.campaign || {};

  function dial(number) {
    if (!number) return;
    be.send("dial", { number });
  }
  function startCampaign() {
    const leads = queue.map((r) => ({ number: r.number, name: r.name, email: r.email }));
    const n = count > 0 ? count : leads.length;
    be.send("startCampaign", {
      leads,
      count: n,
      accountIds: [...selectedAccts],
      triggerMode,
      recallCategories: [...recallCats],
    });
  }

  const visibleQueue = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return queue;
    return queue.filter((r) => r.name.toLowerCase().includes(q) || r.number.includes(q));
  }, [queue, search]);

  const counts = camp.counts || {};

  return (
    <div className="ca">
      <div className="page-head">
        <div>
          <h2>Call Automation</h2>
          <p>Run parallel Google Voice flows and campaigns with live transcripts.</p>
        </div>
      </div>

      {/* Control bar */}
      <div className="ca-controlbar">
        <span className={"dot " + (be.connected ? "dot-on" : "dot-off")} />
        <div className="ca-cb-status">
          <span className="ca-cb-conn">{be.connected ? "Connected" : "Backend offline"}</span>
          <span className="ca-cb-from muted">
            {sessionList.length} session{sessionList.length === 1 ? "" : "s"} open
          </span>
        </div>
        <span className="ca-spacer" />
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
        <button className="btn btn-ghost" onClick={() => be.send("status")}>Refresh</button>
      </div>

      {!be.connected && (
        <div className="ca-offline muted">
          Backend offline - start it with <code>cd call-backend &amp;&amp; npm start</code>
        </div>
      )}

      {/* Campaign */}
      <section className="card ca-campaign">
        <div className="card-header">
          <span className="section-label">Campaign (parallel across all logged-in accounts)</span>
        </div>
        <div className="card-body ca-campaign-body">
          <GroupSelect
            groups={groups}
            activeGroupId={activeGroupId}
            setActiveGroupId={setActiveGroupId}
            count={contacts.length}
          />
          <AccountPicker accounts={be.accounts} selected={selectedAccts} onChange={setSelectedAccts} />
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
              placeholder={`${queue.length}`}
              value={count || ""}
              onChange={(e) => setCount(parseInt(e.target.value, 10) || 0)}
            />
            <span className="muted">of {queue.length} in queue</span>
            {camp.running ? (
              <button className="btn btn-danger" onClick={() => be.send("stopCampaign")}>Stop campaign</button>
            ) : (
              <button className="btn" disabled={!be.connected || queue.length === 0} onClick={startCampaign}>
                Start campaign
              </button>
            )}
          </div>
          <div className="ca-campaign-progress">
            <span className="pill">{camp.running ? "Running" : "Idle"}</span>
            <span className="pill">Done <b>{camp.done || 0}</b>/{camp.total || 0}</span>
            <span className="pill">In flight <b>{camp.inFlight || 0}</b></span>
            <span className="pill mk-pickedup">Picked up <b>{counts.picked_up || 0}</b></span>
            <span className="pill mk-nopickup">No pickup <b>{counts.no_pickup || 0}</b></span>
            <span className="pill mk-uncallable">Uncallable <b>{counts.uncallable || 0}</b></span>
          </div>
        </div>
      </section>

      {/* Live sessions */}
      <section className="card ca-sessions">
        <div className="card-header">
          <span className="section-label">Live sessions</span>
          <span className="badge">{sessionList.length}</span>
        </div>
        <div className="card-body">
          {sessionList.length === 0 ? (
            <p className="muted">No sessions open yet. Log into accounts on the Accounts tab, then start a campaign or a manual flow.</p>
          ) : (
            <div className="sess-grid">
              {sessionList.map((s) => (
                <SessionCard key={s.id} s={s} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Queue (with outcome marks) + Activity log */}
      <div className="ca-grid">
        <section className="card ca-queue">
          <div className="card-header">
            <span className="section-label">Call queue</span>
            <span className="badge">{visibleQueue.length}</span>
          </div>
          <div className="card-body">
            <input
              className="ca-search"
              type="search"
              placeholder="Search name or number..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {visibleQueue.length === 0 ? (
              <p className="muted">Pick a Leads group (above) or add leads on the Leads tab to populate the queue.</p>
            ) : (
              <ul className="queue-list">
                {visibleQueue.map((row, i) => {
                  const mark = leadMark(be.leadStatus[digits(row.number)]);
                  return (
                    <li key={`${row.number}-${i}`}>
                      <div className="q-info">
                        <span className="q-name">{row.name}</span>
                        <span className="q-num">{row.number}</span>
                      </div>
                      {mark ? (
                        <span className={"q-mark " + mark.cls} title={mark.reason || ""}>
                          {mark.label}
                        </span>
                      ) : (
                        <button className="btn btn-sm" disabled={!ready} onClick={() => dial(row.number)}>
                          Dial
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="card ca-logcard">
          <div className="card-header">
            <span className="section-label">Activity log</span>
            <span className={"muted " + (be.sttEnabled ? "" : "")}>{be.sttEnabled ? "STT on" : "STT off"}</span>
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
    </div>
  );
}
