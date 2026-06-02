import React from "react";
import {
  IconOutreach,
  IconPhone,
  IconLeads,
  IconAccounts,
  IconStats,
} from "./icons.jsx";

const CARDS = [
  {
    id: "outreach",
    title: "Outreach",
    desc: "Turn lead lists into per-contact call scripts and track who you've reached.",
    Icon: IconOutreach,
  },
  {
    id: "call",
    title: "Call Automation",
    desc: "Run parallel Google Voice flows and campaigns with live transcripts.",
    Icon: IconPhone,
  },
  {
    id: "leads",
    title: "Leads",
    desc: "Import CSV/TXT lead databases and pick which one to work.",
    Icon: IconLeads,
  },
  {
    id: "accounts",
    title: "Accounts",
    desc: "Connect Google accounts, each on its own sticky residential IP.",
    Icon: IconAccounts,
  },
  {
    id: "stats",
    title: "Stats",
    desc: "Outreach pipeline counts and per-account call performance.",
    Icon: IconStats,
  },
];

export default function Dashboard({ setTab, accounts = [], contactCount = 0 }) {
  return (
    <div className="dashboard">
      <div className="dash-hero">
        <div className="dash-eyebrow">Toolkit</div>
        <h1>Your call &amp; outreach workspace</h1>
        <p>
          Pick a tool to get to work. {accounts.length} account
          {accounts.length === 1 ? "" : "s"} connected, {contactCount} contacts in the active group.
        </p>
      </div>

      <div className="tool-grid">
        {CARDS.map(({ id, title, desc, Icon }) => (
          <button key={id} className="tool-card" onClick={() => setTab(id)}>
            <span className="tool-pill">AVAILABLE</span>
            <span className="tool-ico">
              <Icon size={22} />
            </span>
            <span className="tool-title">{title}</span>
            <span className="tool-desc">{desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
