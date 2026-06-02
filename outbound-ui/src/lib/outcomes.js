// Single source of truth for canonical call-outcome categories on the frontend.
// Mirrors the backend canonicalCategory() vocabulary. Each entry carries a UI
// label, a css class for the mark chip, and whether it is included by default
// when re-running a batch (defaultRecall=false => skipped by default).

export const CATEGORY_META = {
  pressed_1: { label: "Pressed 1", cls: "mk-pressed", defaultRecall: false },
  callback_voice: { label: "Callback (voice)", cls: "mk-callback", defaultRecall: false },
  call_screened: { label: "Call screened", cls: "mk-screened", defaultRecall: false },
  uncallable: { label: "Uncallable", cls: "mk-uncallable", defaultRecall: false },
  picked_up: { label: "Picked up - no key", cls: "mk-pickedup", defaultRecall: true },
  no_callback: { label: "Said no", cls: "mk-nocallback", defaultRecall: true },
  hung_up_early: { label: "Hung up early", cls: "mk-hungup", defaultRecall: true },
  no_answer: { label: "No answer", cls: "mk-nopickup", defaultRecall: true },
  declined: { label: "Declined", cls: "mk-declined", defaultRecall: true },
};

// Ordered list of categories for pickers / summaries.
export const CATEGORY_ORDER = [
  "pressed_1",
  "callback_voice",
  "picked_up",
  "no_callback",
  "hung_up_early",
  "no_answer",
  "declined",
  "call_screened",
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
    if (meta) return { label: meta.label, cls: meta.cls, reason: ls.reason };
  }
  return null;
}
