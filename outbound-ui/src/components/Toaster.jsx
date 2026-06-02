import React from "react";

// Renders transient toast notifications from useBackend. Auto-expiry is handled
// in the hook; clicking a toast dismisses it early.
export default function Toaster({ toasts = [], onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={"toast toast-" + (t.kind || "info")}
          onClick={() => onDismiss && onDismiss(t.id)}
          role="status"
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
