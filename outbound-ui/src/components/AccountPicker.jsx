import React from "react";

// Controlled multi-select for choosing which accounts join a campaign.
// `selected` is a Set of account ids; `onChange` receives a new Set.
export default function AccountPicker({ accounts = [], selected, onChange }) {
  const sel = selected instanceof Set ? selected : new Set(selected || []);

  function toggle(id) {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }
  function selectAll() {
    onChange(new Set(accounts.map((a) => a.id)));
  }
  function selectNone() {
    onChange(new Set());
  }

  if (accounts.length === 0) {
    return <div className="acct-pick-row muted">No accounts yet — add one on the Accounts tab.</div>;
  }

  return (
    <div className="acct-pick-row">
      <span className="acct-pick-label muted">Accounts</span>
      {accounts.map((a) => {
        const on = sel.has(a.id);
        return (
          <button
            key={a.id}
            type="button"
            className={"acct-pick " + (on ? "on" : "")}
            aria-pressed={on}
            onClick={() => toggle(a.id)}
            title={a.phoneNumber || a.label}
          >
            <span className="acct-pick-box">{on ? "✓" : ""}</span>
            {a.label}
          </button>
        );
      })}
      <span className="ca-spacer" />
      <button type="button" className="btn btn-sm btn-ghost" onClick={selectAll}>All</button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={selectNone}>None</button>
    </div>
  );
}
