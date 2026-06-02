import React from "react";
import { CATEGORY_META, CATEGORY_ORDER } from "../lib/outcomes.js";

// Controlled multi-select for choosing which prior-outcome categories should be
// RE-CALLED on the next batch. `selected` is a Set of canonical category ids;
// numbers whose last outcome is NOT in this set are skipped. Never-called
// numbers are always included regardless of this selection.
export default function CategoryPicker({ selected, onChange }) {
  const sel = selected instanceof Set ? selected : new Set(selected || []);

  function toggle(id) {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }
  function selectAll() {
    onChange(new Set(CATEGORY_ORDER));
  }
  function selectNone() {
    onChange(new Set());
  }

  return (
    <div className="acct-pick-row">
      <span className="acct-pick-label muted">Re-call</span>
      {CATEGORY_ORDER.map((id) => {
        const on = sel.has(id);
        const meta = CATEGORY_META[id];
        return (
          <button
            key={id}
            type="button"
            className={"acct-pick " + (on ? "on" : "")}
            aria-pressed={on}
            onClick={() => toggle(id)}
            title={on ? "Will be re-called" : "Skipped on re-run"}
          >
            <span className="acct-pick-box">{on ? "✓" : ""}</span>
            {meta.label}
          </button>
        );
      })}
      <span className="ca-spacer" />
      <button type="button" className="btn btn-sm btn-ghost" onClick={selectAll}>All</button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={selectNone}>None</button>
    </div>
  );
}
