import React from "react";
import { STATUSES, STATUS_CLASS } from "../constants.js";

export default function StatsBar({ counts, total }) {
  const called = counts["Called"] || 0;
  const remaining = total - called;

  return (
    <section className="stats">
      <div className="stat">
        <span className="stat-num">{total}</span>
        <span className="stat-label">numbers</span>
      </div>
      <div className="stat">
        <span className="stat-num">{called}</span>
        <span className="stat-label">called</span>
      </div>
      <div className="stat">
        <span className="stat-num">{remaining}</span>
        <span className="stat-label">remaining</span>
      </div>
      <div className="stat-bar-track" title={`${called} of ${total} called`}>
        <div
          className="stat-bar-fill"
          style={{ width: total ? `${(called / total) * 100}%` : "0%" }}
        />
      </div>
      <div className="status-counts">
        {STATUSES.map((s) => (
          <span key={s} className={"status-pill " + STATUS_CLASS[s]}>
            {s}: {counts[s] || 0}
          </span>
        ))}
      </div>
    </section>
  );
}
