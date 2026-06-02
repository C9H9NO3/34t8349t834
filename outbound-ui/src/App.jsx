import React, { useEffect, useMemo, useState } from "react";
import Sidebar from "./components/Sidebar.jsx";
import Topbar from "./components/Topbar.jsx";
import Toaster from "./components/Toaster.jsx";
import Login from "./components/Login.jsx";
import Dashboard from "./components/Dashboard.jsx";
import GroupSelect from "./components/GroupSelect.jsx";
import InputPanel from "./components/InputPanel.jsx";
import StatsBar from "./components/StatsBar.jsx";
import StatsPanel from "./components/StatsPanel.jsx";
import CallCard from "./components/CallCard.jsx";
import ScriptModal from "./components/ScriptModal.jsx";
import CallAutomation from "./components/CallAutomation.jsx";
import TestingPanel from "./components/TestingPanel.jsx";
import LeadsPanel from "./components/LeadsPanel.jsx";
import AccountsPanel from "./components/AccountsPanel.jsx";
import SettingsPanel from "./components/SettingsPanel.jsx";
import { parseContacts } from "./lib/parseContacts.js";
import { fillTemplate } from "./lib/template.js";
import { useBackend } from "./lib/useBackend.js";
import { STATUSES, DEFAULT_TEMPLATE, SAMPLE_CONTACTS } from "./constants.js";

const LS = {
  contacts: "ob_contacts", // legacy single-box contacts (migrated to a group)
  template: "ob_template",
  tracking: "ob_tracking",
  groups: "ob_lead_groups",
  activeGroup: "ob_active_group",
};

function loadLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Seeds the initial lead groups, migrating any legacy single-box contacts.
function initialGroups() {
  const existing = loadLS(LS.groups, null);
  if (Array.isArray(existing) && existing.length) return existing;
  const legacy = loadLS(LS.contacts, null);
  const text = typeof legacy === "string" && legacy.trim() ? legacy : SAMPLE_CONTACTS;
  return [{ id: "default", name: "Default", text }];
}

// Stable id per call card so tracking survives re-paste / refresh.
function cardId(contact, number) {
  const who = (contact.emails[0] || contact.fullName || "").toLowerCase();
  return `${who}|${number || ""}`;
}

export default function App() {
  const be = useBackend();
  const [groups, setGroups] = useState(initialGroups);
  const [activeGroupId, setActiveGroupId] = useState(
    () => loadLS(LS.activeGroup, null) || groups[0]?.id || null
  );
  const [template, setTemplate] = useState(() => loadLS(LS.template, DEFAULT_TEMPLATE));
  const [tracking, setTracking] = useState(() => loadLS(LS.tracking, {}));
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [expandedId, setExpandedId] = useState(null);
  const [tab, setTab] = useState("dashboard");

  useEffect(() => {
    localStorage.setItem(LS.groups, JSON.stringify(groups));
  }, [groups]);
  useEffect(() => {
    localStorage.setItem(LS.activeGroup, JSON.stringify(activeGroupId));
  }, [activeGroupId]);
  useEffect(() => {
    localStorage.setItem(LS.template, JSON.stringify(template));
  }, [template]);
  useEffect(() => {
    localStorage.setItem(LS.tracking, JSON.stringify(tracking));
  }, [tracking]);

  // Keep a valid active group selected.
  useEffect(() => {
    if (groups.length && !groups.some((g) => g.id === activeGroupId)) {
      setActiveGroupId(groups[0].id);
    }
  }, [groups, activeGroupId]);

  const activeGroup = groups.find((g) => g.id === activeGroupId) || groups[0] || null;
  const contacts = useMemo(
    () => parseContacts(activeGroup ? activeGroup.text : ""),
    [activeGroup]
  );

  // One call item per contact x number (contacts with no number get one item).
  const items = useMemo(() => {
    const out = [];
    contacts.forEach((contact) => {
      const numbers = contact.numbers.length ? contact.numbers : [""];
      numbers.forEach((number) => {
        out.push({
          id: cardId(contact, number),
          contact,
          number,
          script: fillTemplate(template, contact, number),
        });
      });
    });
    return out;
  }, [contacts, template]);

  function updateRecord(id, patch) {
    setTracking((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  const counts = useMemo(() => {
    const c = {};
    items.forEach((it) => {
      const s = tracking[it.id]?.status || "Not called";
      c[s] = (c[s] || 0) + 1;
    });
    return c;
  }, [items, tracking]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      const status = tracking[it.id]?.status || "Not called";
      if (filter !== "All" && status !== filter) return false;
      if (q && !it.contact.fullName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, tracking, search, filter]);

  if (be.authRequired) {
    return <Login onSubmit={be.login} error={be.authError} />;
  }

  return (
    <div className="shell">
      <Toaster toasts={be.toasts} onDismiss={be.dismissToast} />
      <Sidebar tab={tab} setTab={setTab} />

      <div className="main">
        <Topbar tab={tab} be={be} search={search} setSearch={setSearch} />

        <div className="content">
          {tab === "dashboard" && (
            <Dashboard setTab={setTab} accounts={be.accounts} contactCount={contacts.length} />
          )}

          {tab === "call" && (
            <CallAutomation
              be={be}
              contacts={contacts}
              groups={groups}
              activeGroupId={activeGroupId}
              setActiveGroupId={setActiveGroupId}
            />
          )}

          {tab === "testing" && <TestingPanel be={be} />}

          {tab === "leads" && (
            <LeadsPanel
              groups={groups}
              setGroups={setGroups}
              activeGroupId={activeGroupId}
              setActiveGroupId={setActiveGroupId}
            />
          )}

          {tab === "accounts" && <AccountsPanel be={be} />}

          {tab === "stats" && (
            <StatsPanel counts={counts} total={items.length} accounts={be.accounts} />
          )}

          {tab === "settings" && <SettingsPanel be={be} />}

          {tab === "outreach" && (
            <>
              <div className="page-head">
                <div>
                  <h2>Outreach</h2>
                  <p>Generate per-contact call scripts and track your progress.</p>
                </div>
                <GroupSelect
                  groups={groups}
                  activeGroupId={activeGroupId}
                  setActiveGroupId={setActiveGroupId}
                  count={contacts.length}
                />
              </div>

              <InputPanel
                template={template}
                setTemplate={setTemplate}
                contactCount={contacts.length}
                numberCount={items.length}
                collapsed={collapsed}
                setCollapsed={setCollapsed}
              />

              <StatsBar counts={counts} total={items.length} />

              <div className="toolbar">
                <input
                  className="search"
                  type="search"
                  placeholder="Search by name..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <div className="filters">
                  {["All", ...STATUSES].map((f) => (
                    <button
                      key={f}
                      className={"filter-chip " + (filter === f ? "active" : "")}
                      onClick={() => setFilter(f)}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              <main className="cards">
                {visible.length === 0 ? (
                  <p className="empty">
                    {items.length === 0
                      ? "Pick a Leads group (above) or add leads on the Leads tab to generate call scripts."
                      : "No cards match this filter/search."}
                  </p>
                ) : (
                  visible.map((it) => (
                    <CallCard
                      key={it.id}
                      item={it}
                      record={tracking[it.id] || {}}
                      onUpdate={updateRecord}
                      onExpand={(item) => setExpandedId(item.id)}
                    />
                  ))
                )}
              </main>

              <ScriptModal
                item={items.find((it) => it.id === expandedId) || null}
                onClose={() => setExpandedId(null)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
