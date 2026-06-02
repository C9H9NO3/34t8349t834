import React from "react";

const TITLES = {
  dashboard: "Dashboard",
  outreach: "Outreach",
  call: "Call Automation",
  testing: "Testing",
  leads: "Leads",
  accounts: "Accounts",
  stats: "Stats",
  settings: "Settings",
};

// Top bar: current page title, optional search, headless toggle, and a live
// backend status pill.
export default function Topbar({ tab, be, search, setSearch }) {
  return (
    <header className="app-topbar">
      <span className="tb-title">{TITLES[tab] || "Toolkit"}</span>
      <input
        className="tb-search"
        type="search"
        placeholder="Search..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <span className="tb-spacer" />
      <div className="segmented" role="group" aria-label="Browser visibility">
        <button
          className={"seg " + (!be.headless ? "seg-on" : "")}
          onClick={() => be.send("setHeadless", { headless: false })}
        >
          Visible
        </button>
        <button
          className={"seg " + (be.headless ? "seg-on" : "")}
          onClick={() => be.send("setHeadless", { headless: true })}
        >
          Hidden
        </button>
      </div>
      <span className="ready-pill">
        <span
          className="dot"
          style={{ background: be.connected ? "var(--green)" : "var(--red)" }}
        />
        {be.connected ? "Ready" : "Offline"}
      </span>
    </header>
  );
}
