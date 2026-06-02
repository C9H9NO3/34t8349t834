import React from "react";

// Dropdown to choose the active lead group. Shared by Outreach + Call Automation.
export default function GroupSelect({ groups, activeGroupId, setActiveGroupId, count }) {
  return (
    <div className="group-select">
      <label className="group-select-label">Leads group</label>
      <select
        value={activeGroupId || ""}
        onChange={(e) => setActiveGroupId(e.target.value)}
      >
        {groups.length === 0 && <option value="">No groups yet</option>}
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
      {typeof count === "number" && (
        <span className="muted group-select-count">{count} contacts</span>
      )}
    </div>
  );
}
