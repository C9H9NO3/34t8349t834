import React, { useMemo, useRef, useState } from "react";
import { parseContacts } from "../lib/parseContacts.js";
import Modal from "./Modal.jsx";
import { IconUpload, IconLeads, IconPlus } from "./icons.jsx";
import {
  buildImport,
  csvToPipeText,
  fileBaseName,
  readFileText,
} from "../lib/importLeads.js";

let _gid = 0;
function newGroupId() {
  _gid += 1;
  return `g_${Date.now().toString(36)}_${_gid}`;
}

const MAP_FIELDS = [
  { key: "name", label: "Full name" },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
];

// Lead databases as selectable cards. Import CSV/TXT files (pipe-delimited or
// true CSV) into a named database; the active database feeds Outreach + Call.
export default function LeadsPanel({ groups, setGroups, activeGroupId, setActiveGroupId }) {
  const [editingId, setEditingId] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [imp, setImp] = useState(null); // { fileName, mode, text?, headers?, rows?, mapping?, hasHeader? }
  const [displayName, setDisplayName] = useState("");
  const [mapping, setMapping] = useState(null);
  const fileRef = useRef(null);

  const editing = groups.find((g) => g.id === editingId) || null;

  function addEmpty() {
    const g = { id: newGroupId(), name: `Database ${groups.length + 1}`, text: "" };
    setGroups([...groups, g]);
    setActiveGroupId(g.id);
    setEditingId(g.id);
  }

  function rename(id, name) {
    setGroups(groups.map((g) => (g.id === id ? { ...g, name } : g)));
  }
  function setText(id, text) {
    setGroups(groups.map((g) => (g.id === id ? { ...g, text } : g)));
  }
  function remove(id) {
    const next = groups.filter((g) => g.id !== id);
    setGroups(next);
    if (activeGroupId === id) setActiveGroupId(next[0]?.id || null);
    if (editingId === id) setEditingId(null);
  }

  async function handleFiles(fileList) {
    const file = fileList && fileList[0];
    if (!file) return;
    try {
      const text = await readFileText(file);
      const descriptor = buildImport(text);
      setImp({ fileName: file.name, ...descriptor });
      setDisplayName(fileBaseName(file.name));
      setMapping(descriptor.mode === "csv" ? { ...descriptor.mapping } : null);
    } catch {
      // best-effort; ignore unreadable files
    }
  }

  // Text that will actually be stored for the pending import.
  const importText = useMemo(() => {
    if (!imp) return "";
    if (imp.mode === "pipe") return imp.text;
    if (imp.mode === "csv" && mapping) return csvToPipeText(imp.rows, mapping);
    return "";
  }, [imp, mapping]);

  const importCount = useMemo(() => parseContacts(importText).length, [importText]);

  function confirmImport() {
    if (!imp) return;
    const g = { id: newGroupId(), name: displayName.trim() || "Imported", text: importText };
    setGroups([...groups, g]);
    setActiveGroupId(g.id);
    setImp(null);
    setMapping(null);
    setEditingId(g.id);
  }

  return (
    <div className="leads">
      <div className="page-head">
        <div>
          <h2>Leads</h2>
          <p>Import CSV/TXT databases and pick which one to work in Outreach and Call Automation.</p>
        </div>
        <span className="muted">{groups.length} databases</span>
      </div>

      {/* Import dropzone */}
      <div
        className={"dropzone " + (dragging ? "drag" : "")}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <IconUpload size={26} />
          <div>
            <b>Drop a CSV or TXT file</b> or click to browse
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Pipe format (<code>Name | email | number | City, State</code>) or comma-separated columns
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          style={{ display: "none" }}
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {/* Database cards */}
      <div className="entity-grid" style={{ marginTop: 16 }}>
        {groups.map((g) => {
          const count = parseContacts(g.text).length;
          const selected = g.id === activeGroupId;
          return (
            <div
              key={g.id}
              className={"entity-card " + (selected ? "selected" : "")}
              onClick={() => setActiveGroupId(g.id)}
            >
              <span className="ec-check" />
              <div className="ec-top">
                <span className="ec-ico">
                  <IconLeads size={18} />
                </span>
                <span className="ec-name">{g.name}</span>
              </div>
              <span className="ec-sub">{count} contacts</span>
              <div className="ec-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => setEditingId(editingId === g.id ? null : g.id)}
                >
                  {editingId === g.id ? "Close" : "Edit"}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => remove(g.id)}>
                  Delete
                </button>
              </div>
            </div>
          );
        })}

        <button className="add-card" onClick={addEmpty}>
          <IconPlus size={20} />
          New empty database
        </button>
      </div>

      {/* Inline editor */}
      {editing && (
        <section className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <input
              className="group-name"
              value={editing.name}
              onChange={(e) => rename(editing.id, e.target.value)}
              style={{ fontWeight: 600 }}
            />
            <span className="muted">{parseContacts(editing.text).length} contacts</span>
          </div>
          <div className="card-body">
            <p className="hint">
              One contact per line: <code>Name | email | number | City, State</code>
            </p>
            <textarea
              className="leads-textarea"
              value={editing.text}
              onChange={(e) => setText(editing.id, e.target.value)}
              spellCheck={false}
              placeholder="Paste lead lines here, one per line..."
            />
          </div>
        </section>
      )}

      {/* Import modal (name + optional CSV column mapper) */}
      {imp && (
        <Modal
          title="Import leads"
          subtitle={`From ${imp.fileName} - ${imp.mode === "csv" ? "CSV columns" : "pipe format"}`}
          onClose={() => setImp(null)}
        >
          <div className="modal-row">
            <label>Display name</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Texas batch"
              autoFocus
            />
          </div>

          {imp.mode === "csv" && mapping && (
            <div className="modal-row">
              <label>Map columns</label>
              <div className="modal-map-grid">
                {MAP_FIELDS.map((f) => (
                  <div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span className="muted" style={{ fontSize: 11.5 }}>{f.label}</span>
                    <select
                      value={mapping[f.key]}
                      onChange={(e) =>
                        setMapping({ ...mapping, [f.key]: parseInt(e.target.value, 10) })
                      }
                    >
                      <option value={-1}>- none -</option>
                      {imp.headers.map((h, i) => (
                        <option key={i} value={i}>{h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="muted" style={{ fontSize: 13 }}>{importCount} contacts will be imported.</p>

          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setImp(null)}>Cancel</button>
            <button className="btn" disabled={importCount === 0} onClick={confirmImport}>
              Import {importCount > 0 ? `(${importCount})` : ""}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
