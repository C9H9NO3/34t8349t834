import React from "react";
import {
  IconDashboard,
  IconOutreach,
  IconPhone,
  IconLeads,
  IconAccounts,
  IconStats,
  IconSparkle,
  IconSettings,
} from "./icons.jsx";

// Grouped navigation. Each item drives the existing tab state in App.
const GROUPS = [
  {
    label: "Menu",
    items: [
      { id: "dashboard", label: "Dashboard", Icon: IconDashboard },
      { id: "outreach", label: "Outreach", Icon: IconOutreach },
      { id: "call", label: "Call Automation", Icon: IconPhone },
      { id: "testing", label: "Testing", Icon: IconSparkle },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "leads", label: "Leads", Icon: IconLeads },
      { id: "accounts", label: "Accounts", Icon: IconAccounts },
      { id: "stats", label: "Stats", Icon: IconStats },
      { id: "settings", label: "Settings", Icon: IconSettings },
    ],
  },
];

export default function Sidebar({ tab, setTab }) {
  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <div className="sb-logo" aria-hidden />
        <div className="sb-brand-text">
          <span className="sb-brand-title">Toolkit</span>
          <span className="sb-brand-sub">Call &amp; outreach</span>
        </div>
      </div>

      {GROUPS.map((group) => (
        <div key={group.label}>
          <div className="sb-group-label">{group.label}</div>
          {group.items.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={"nav-item " + (tab === id ? "active" : "")}
              onClick={() => setTab(id)}
            >
              <span className="nav-ico">
                <Icon size={17} />
              </span>
              {label}
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}
