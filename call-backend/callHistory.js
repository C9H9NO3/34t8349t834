// Persistent per-number call-outcome history. Keyed by digits-only phone number
// so the same callee is recognized across leads databases and accounts. The
// latest concluded outcome wins; we keep attempt counts and timestamps so a
// re-run can skip numbers by category (e.g. never re-call an "uncallable").
//
// Holds no secrets - just numbers and how their last call concluded.

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { digits } from "./util.js";

function readStore() {
  try {
    const raw = fs.readFileSync(config.callHistoryFile, "utf8");
    const data = JSON.parse(raw);
    if (data && data.entries && typeof data.entries === "object") return data;
  } catch {
    /* missing/invalid -> fresh */
  }
  return { entries: {} };
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(config.callHistoryFile), { recursive: true });
  fs.writeFileSync(config.callHistoryFile, JSON.stringify(store, null, 2), "utf8");
}

// Records (or updates) the latest concluded outcome for a number. `category`
// is the canonical outcome category; `reason` is the detailed reason; `via` is
// the callback source ("dtmf" | "voice" | null). Returns the stored entry.
export function record({ number, category, reason, via = null }) {
  const key = digits(number);
  if (!key) return null;
  const store = readStore();
  const now = new Date().toISOString();
  const prev = store.entries[key];
  const entry = {
    number: number || (prev && prev.number) || key,
    category,
    reason: reason || "",
    via: via || null,
    attempts: (prev && prev.attempts ? prev.attempts : 0) + 1,
    firstCalledAt: (prev && prev.firstCalledAt) || now,
    lastCalledAt: now,
  };
  store.entries[key] = entry;
  writeStore(store);
  return entry;
}

export function get(numberOrDigits) {
  const key = digits(numberOrDigits);
  if (!key) return null;
  return readStore().entries[key] || null;
}

// Full map of entries keyed by digits.
export function all() {
  return readStore().entries;
}

// Clears the entire history. Returns the number of entries removed.
export function clear() {
  const store = readStore();
  const n = Object.keys(store.entries).length;
  writeStore({ entries: {} });
  return n;
}

// Clears only entries whose canonical category matches. Returns count removed.
export function clearCategory(category) {
  const store = readStore();
  let n = 0;
  for (const [key, e] of Object.entries(store.entries)) {
    if (e.category === category) {
      delete store.entries[key];
      n++;
    }
  }
  if (n) writeStore(store);
  return n;
}
