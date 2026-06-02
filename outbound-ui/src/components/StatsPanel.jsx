import React from "react";
import StatsBar from "./StatsBar.jsx";
import { prettyLoc, callbackPct } from "../lib/format.js";

// Stats tab: the outreach pipeline counts plus per-account call stats.
export default function StatsPanel({ counts, total, accounts }) {
  return (
    <div className="stats-tab">
      <div className="page-head">
        <div>
          <h2>Stats</h2>
          <p>Outreach pipeline counts and per-account call performance.</p>
        </div>
      </div>

      <section className="card">
        <div className="card-header">
          <span className="section-label">Outreach pipeline</span>
        </div>
        <div className="card-body">
          <StatsBar counts={counts} total={total} />
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <span className="section-label">Per-account call stats</span>
          <span className="muted">{accounts.length} accounts</span>
        </div>
        <div className="card-body">
          {accounts.length === 0 ? (
            <p className="muted">No Google accounts connected yet.</p>
          ) : (
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Location</th>
                  <th>Calls</th>
                  <th>No-pickup</th>
                  <th>Declined</th>
                  <th>Call-backs</th>
                  <th>Call-back %</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const s = a.stats || {};
                  return (
                    <tr key={a.id}>
                      <td>{a.label}</td>
                      <td className="muted">{prettyLoc(a.proxy) || "-"}</td>
                      <td>{s.calls || 0}</td>
                      <td>{s.noPickup || 0}</td>
                      <td>{s.instantDecline || 0}</td>
                      <td>{s.callback || 0}</td>
                      <td>{callbackPct(s)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
