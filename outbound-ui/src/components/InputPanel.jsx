import React from "react";
import { detectVariables, unknownVariables } from "../lib/template.js";

export default function InputPanel({
  template,
  setTemplate,
  contactCount,
  numberCount,
  collapsed,
  setCollapsed,
}) {
  const vars = detectVariables(template);
  const unknown = new Set(unknownVariables(template));

  return (
    <section className="panel input-panel">
      <button
        className="panel-toggle"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
      >
        <span>{collapsed ? "Show" : "Hide"} script</span>
        <span className="muted">
          {contactCount} contacts | {numberCount} numbers
        </span>
      </button>

      {!collapsed && (
        <div className="input-grid input-grid-single">
          <div className="field">
            <label htmlFor="template">Script template</label>
            <p className="hint">
              Use <code>[first name]</code>, <code>[full name]</code>, <code>[email]</code>,{" "}
              <code>[number]</code>, <code>[numbers]</code>, <code>[city]</code>,{" "}
              <code>[state]</code> ...
            </p>
            <textarea
              id="template"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              spellCheck={false}
              placeholder="Write your call script with [variables]..."
            />
            {vars.length > 0 && (
              <div className="chips">
                {vars.map((v) => (
                  <span
                    key={v}
                    className={"chip " + (unknown.has(v) ? "chip-unknown" : "chip-known")}
                    title={unknown.has(v) ? "Unknown variable - left as-is" : "Will be filled"}
                  >
                    [{v}]
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
