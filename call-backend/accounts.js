// Registry of saved Google accounts. Each account has its own persistent
// Chromium profile directory (cookies/state) plus a human label and a
// phone-number note shown in the UI. The registry itself holds no secrets.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { randomLocation, isValidLocation } from "./usLocations.js";

const EMPTY_STATS = { calls: 0, noPickup: 0, instantDecline: 0, answered: 0, callback: 0 };

// Generates a sticky NodeMaven session id (8 alphanumeric chars). Keeping this
// constant for an account => it always egresses from the same residential IP.
function newSid() {
  return crypto.randomBytes(6).toString("hex").slice(0, 8);
}

function defaultProxy() {
  const loc = randomLocation();
  return { country: "us", region: loc.region, city: loc.city, sid: newSid() };
}

function readRegistry() {
  try {
    const raw = fs.readFileSync(config.accountsFile, "utf8");
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.accounts)) return data;
  } catch {
    /* missing/invalid -> fresh */
  }
  return { accounts: [], activeId: null };
}

function writeRegistry(reg) {
  fs.mkdirSync(path.dirname(config.accountsFile), { recursive: true });
  fs.writeFileSync(config.accountsFile, JSON.stringify(reg, null, 2), "utf8");
}

export function profileDir(id) {
  return path.join(config.profilesDir, id);
}

// Portable login state (decrypted cookies + localStorage) captured on the local
// machine and injected on the server. Stored as a SIBLING of the Chromium
// profile dir (not inside it) so Chromium never touches it. This is how a login
// survives the Windows->Linux move: raw Cookies DBs are OS-encrypted and can't
// cross machines, but storageState values can be re-encrypted natively.
export function storageStatePath(id) {
  return path.join(config.profilesDir, `${id}.storagestate.json`);
}

// Public view of an account (no internal paths).
function publicView(a) {
  return {
    id: a.id,
    label: a.label,
    phoneNumber: a.phoneNumber,
    note: a.note || "",
    createdAt: a.createdAt,
    lastUsedAt: a.lastUsedAt || null,
    proxy: a.proxy || null,
    stats: { ...EMPTY_STATS, ...(a.stats || {}) },
  };
}

// Backfills proxy + stats on accounts created before these fields existed.
// Returns true if anything was added (caller persists).
function ensureDefaults(a) {
  let changed = false;
  if (!a.proxy) {
    a.proxy = defaultProxy();
    changed = true;
  }
  if (!a.stats) {
    a.stats = { ...EMPTY_STATS };
    changed = true;
  }
  return changed;
}

export function list() {
  const reg = readRegistry();
  let changed = false;
  for (const a of reg.accounts) if (ensureDefaults(a)) changed = true;
  if (changed) writeRegistry(reg);
  return reg.accounts.map(publicView);
}

export function get(id) {
  const a = readRegistry().accounts.find((x) => x.id === id);
  return a ? publicView(a) : null;
}

// Returns the raw stored account object (incl. proxy region/city/sid) for
// bundling/export. Clones it so callers can't mutate the registry. Null if
// unknown.
export function raw(id) {
  const a = readRegistry().accounts.find((x) => x.id === id);
  return a ? JSON.parse(JSON.stringify(a)) : null;
}

// Raw view of every account (for "export all").
export function rawAll() {
  return readRegistry().accounts.map((a) => JSON.parse(JSON.stringify(a)));
}

// Upserts an imported account by id (keeps its proxy/sid so the egress IP pool
// matches the session it was logged in under). Backfills missing defaults and
// ensures its profile directory exists. Returns the public view.
export function importAccount(rawAccount) {
  if (!rawAccount || typeof rawAccount !== "object" || !rawAccount.id) {
    throw new Error("invalid account in bundle");
  }
  const reg = readRegistry();
  const incoming = {
    id: rawAccount.id,
    label: (rawAccount.label || "").trim() || rawAccount.phoneNumber || "Account",
    phoneNumber: (rawAccount.phoneNumber || "").trim(),
    note: (rawAccount.note || "").trim(),
    createdAt: rawAccount.createdAt || new Date().toISOString(),
    lastUsedAt: rawAccount.lastUsedAt || null,
    proxy: rawAccount.proxy || defaultProxy(),
    stats: { ...EMPTY_STATS, ...(rawAccount.stats || {}) },
  };
  const idx = reg.accounts.findIndex((x) => x.id === incoming.id);
  if (idx === -1) reg.accounts.push(incoming);
  else reg.accounts[idx] = incoming;
  if (!reg.activeId) reg.activeId = incoming.id;
  writeRegistry(reg);
  fs.mkdirSync(profileDir(incoming.id), { recursive: true });
  return publicView(incoming);
}

// Returns the raw proxy assignment for an account (assigning + persisting one
// if missing), so the controller can route Chromium through it.
export function getProxy(id) {
  const reg = readRegistry();
  const a = reg.accounts.find((x) => x.id === id);
  if (!a) return null;
  if (ensureDefaults(a)) writeRegistry(reg);
  return a.proxy;
}

// Reassigns an account's residential location (state/city). Generates a fresh
// sticky session id so the new location maps to a new residential IP. Returns
// the updated public view, or null on unknown account / invalid location.
export function setLocation(id, { region, city } = {}) {
  if (!isValidLocation(region, city)) return null;
  const reg = readRegistry();
  const a = reg.accounts.find((x) => x.id === id);
  if (!a) return null;
  a.proxy = { country: "us", region, city: city || null, sid: newSid() };
  writeRegistry(reg);
  return publicView(a);
}

// Rotates an account to a fresh residential IP while keeping its region/city.
// Generates a new sticky session id so NodeMaven hands out a different IP from
// the active (speed-prioritized) pool. Returns the updated public view, or null.
export function rotateProxy(id) {
  const reg = readRegistry();
  const a = reg.accounts.find((x) => x.id === id);
  if (!a) return null;
  const prev = a.proxy || defaultProxy();
  a.proxy = {
    country: prev.country || "us",
    region: prev.region || null,
    city: prev.city || null,
    sid: newSid(),
  };
  writeRegistry(reg);
  return publicView(a);
}

// Increments a per-account stat counter and persists.
export function bumpStat(id, key, n = 1) {
  const reg = readRegistry();
  const a = reg.accounts.find((x) => x.id === id);
  if (!a) return;
  if (!a.stats) a.stats = { ...EMPTY_STATS };
  a.stats[key] = (a.stats[key] || 0) + n;
  writeRegistry(reg);
}

export function add({ label, phoneNumber, note }) {
  const reg = readRegistry();
  const id = crypto.randomUUID();
  const account = {
    id,
    label: (label || "").trim() || phoneNumber || "Account",
    phoneNumber: (phoneNumber || "").trim(),
    note: (note || "").trim(),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    proxy: defaultProxy(),
    stats: { ...EMPTY_STATS },
  };
  reg.accounts.push(account);
  if (!reg.activeId) reg.activeId = id;
  writeRegistry(reg);
  fs.mkdirSync(profileDir(id), { recursive: true });
  return publicView(account);
}

export function update(id, patch) {
  const reg = readRegistry();
  const a = reg.accounts.find((x) => x.id === id);
  if (!a) return null;
  if (patch.label !== undefined) a.label = patch.label;
  if (patch.phoneNumber !== undefined) a.phoneNumber = patch.phoneNumber;
  if (patch.note !== undefined) a.note = patch.note;
  if (patch.lastUsedAt !== undefined) a.lastUsedAt = patch.lastUsedAt;
  writeRegistry(reg);
  return publicView(a);
}

export function remove(id) {
  const reg = readRegistry();
  const idx = reg.accounts.findIndex((x) => x.id === id);
  if (idx === -1) return false;
  reg.accounts.splice(idx, 1);
  if (reg.activeId === id) reg.activeId = reg.accounts[0]?.id || null;
  writeRegistry(reg);
  // Best-effort delete of the profile directory + portable state sidecar.
  try {
    fs.rmSync(profileDir(id), { recursive: true, force: true });
    fs.rmSync(storageStatePath(id), { force: true });
  } catch {
    /* ignore */
  }
  return true;
}

export function getActiveId() {
  return readRegistry().activeId;
}

export function setActiveId(id) {
  const reg = readRegistry();
  if (id !== null && !reg.accounts.some((x) => x.id === id)) return false;
  reg.activeId = id;
  const a = reg.accounts.find((x) => x.id === id);
  if (a) a.lastUsedAt = new Date().toISOString();
  writeRegistry(reg);
  return true;
}
