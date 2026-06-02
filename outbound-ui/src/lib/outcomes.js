// Single source of truth for canonical call-outcome categories on the frontend.
// Mirrors the backend canonicalCategory() vocabulary. Each entry carries a UI
// label, a css class for the mark chip, and whether it is included by default
// when re-running a batch (defaultRecall=false => skipped by default).

export const CATEGORY_META = {
  schedule_callback: { label: "Schedule callback", cls: "mk-callback", defaultRecall: false },
  pickup_silent: { label: "Pickup silent", cls: "mk-pickedup", defaultRecall: true },
  auto_decline: { label: "Auto-decline", cls: "mk-declined", defaultRecall: true },
  no_answer: { label: "No answer", cls: "mk-nopickup", defaultRecall: true },
  uncallable: { label: "Uncallable", cls: "mk-uncallable", defaultRecall: false },
};

// Ordered list of categories for pickers / summaries.
export const CATEGORY_ORDER = [
  "schedule_callback",
  "pickup_silent",
  "auto_decline",
  "no_answer",
  "uncallable",
];

// The default INCLUDED set for re-runs (categories with defaultRecall=true).
export function defaultRecallSet() {
  return new Set(CATEGORY_ORDER.filter((c) => CATEGORY_META[c]?.defaultRecall));
}

const RECALL_LS_KEY = "ob_recall_cats";

// Loads the persisted re-call category selection, falling back to the default.
export function loadRecallCats() {
  try {
    const raw = localStorage.getItem(RECALL_LS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.filter((c) => CATEGORY_META[c]));
    }
  } catch {
    /* ignore */
  }
  return defaultRecallSet();
}

export function saveRecallCats(set) {
  try {
    localStorage.setItem(RECALL_LS_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}

// Maps a lead/outcome status object to a mark chip { label, cls, reason }.
// Handles live campaign statuses and concluded canonical categories.
export function leadMark(ls) {
  if (!ls) return null;
  if (ls.status === "calling") return { label: "Calling…", cls: "mk-calling" };
  if (ls.status === "queued") return { label: "Queued", cls: "mk-queued" };
  if (ls.status === "stopped") return { label: "Stopped", cls: "mk-stopped" };
  if (ls.status === "skipped") {
    const meta = CATEGORY_META[ls.category];
    return { label: "Skipped", cls: "mk-skipped", reason: meta ? meta.label : ls.reason };
  }
  if (ls.status === "done") {
    const meta = CATEGORY_META[ls.category];
    if (meta) {
      // For a scheduled callback, surface HOW it was confirmed (analytics:
      // pressed 1 vs spoken) as the chip detail while keeping one category.
      let reason = ls.reason;
      if (ls.category === "schedule_callback") {
        reason = ls.via === "dtmf" ? "pressed 1" : ls.via === "voice" ? "voice" : ls.reason;
      }
      return { label: meta.label, cls: meta.cls, reason };
    }
  }
  return null;
}
