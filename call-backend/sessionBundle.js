// Export/import a logged-in Google Voice session as a portable zip so you can
// log in on a LOCAL backend (headed Chromium) and move the saved session to the
// live (headless) server. A bundle carries the account record (incl. its sticky
// proxy region/city/sid so the server egresses from the same residential pool)
// plus the Chromium profile directory, with cache folders stripped to keep it
// small.
//
// Single-account bundle layout:
//   account.json
//   profile/<chromium user-data files…>
// Multi-account bundle layout ("export all"):
//   manifest.json            { multi: true, ids: [...] }
//   accounts/<id>/account.json
//   accounts/<id>/profile/<…>

import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import * as accounts from "./accounts.js";

// Profile sub-paths that are pure cache / crash data: never needed to stay
// logged in, and they dominate the on-disk size (hundreds of MB). Matched by
// exact (case-insensitive) path segment so e.g. "Service Worker/CacheStorage"
// is dropped while "Service Worker/Database" (the registration) is kept.
const EXCLUDE_SEGMENTS = new Set([
  "cache",
  "code cache",
  "gpucache",
  "dawncache",
  "dawngraphitecache",
  "dawnwebgpucache",
  "grshadercache",
  "shadercache",
  "graphitedawncache",
  "cachestorage",
  "scriptcache",
  "component_crx_cache",
  "extensions_crx_cache",
  "crashpad",
  "crash reports",
]);

function isExcluded(rel) {
  const segs = rel.toLowerCase().split("/");
  if (segs.some((s) => EXCLUDE_SEGMENTS.has(s))) return true;
  const last = segs[segs.length - 1];
  return last.endsWith(".log");
}

// Lists profile files (relative, forward-slashed) minus excluded cache paths.
function profileFiles(id) {
  const root = accounts.profileDir(id);
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (isExcluded(rel)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile()) out.push({ abs, rel });
    }
  };
  walk(root, "");
  return out;
}

function addProfile(zip, id, zipPrefix) {
  for (const { abs, rel } of profileFiles(id)) {
    try {
      zip.addFile(`${zipPrefix}/${rel}`, fs.readFileSync(abs));
    } catch {
      /* skip unreadable/locked file */
    }
  }
}

// Builds a single-account bundle Buffer. Throws on unknown id.
export function buildSingle(id) {
  const acct = accounts.raw(id);
  if (!acct) throw new Error("unknown account");
  const zip = new AdmZip();
  zip.addFile("account.json", Buffer.from(JSON.stringify(acct, null, 2)));
  addProfile(zip, id, "profile");
  return zip.toBuffer();
}

// Builds a bundle with every saved account.
export function buildAll() {
  const list = accounts.rawAll();
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from(JSON.stringify({ multi: true, ids: list.map((a) => a.id), createdAt: new Date().toISOString() }, null, 2))
  );
  for (const acct of list) {
    zip.addFile(`accounts/${acct.id}/account.json`, Buffer.from(JSON.stringify(acct, null, 2)));
    addProfile(zip, acct.id, `accounts/${acct.id}/profile`);
  }
  return zip.toBuffer();
}

// Restores one account's registry entry + profile from the zip. profilePrefix
// is the zip path prefix ("profile/" or "accounts/<id>/profile/").
function restoreOne(zip, acct, profilePrefix) {
  const view = accounts.importAccount(acct);
  const dir = accounts.profileDir(acct.id);
  // Replace any existing profile so stale state can't conflict with the upload.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const base = path.resolve(dir);
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/\\/g, "/");
    if (!name.startsWith(profilePrefix)) continue;
    const rel = name.slice(profilePrefix.length);
    if (!rel) continue;
    const resolved = path.resolve(path.join(dir, rel));
    if (resolved !== base && !resolved.startsWith(base + path.sep)) continue; // zip-slip guard
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, e.getData());
  }
  return view;
}

// Imports a bundle (single or multi). Returns { restored: [{id,label}], count }.
export function importBundle(buffer) {
  if (!buffer || !buffer.length) throw new Error("empty upload");
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new Error("not a valid .zip session bundle");
  }
  const names = new Map(zip.getEntries().map((e) => [e.entryName.replace(/\\/g, "/"), e]));
  const restored = [];

  if (names.has("account.json")) {
    const acct = JSON.parse(names.get("account.json").getData().toString("utf8"));
    restoreOne(zip, acct, "profile/");
    restored.push({ id: acct.id, label: acct.label });
  } else {
    const ids = new Set();
    for (const name of names.keys()) {
      const m = name.match(/^accounts\/([^/]+)\/account\.json$/);
      if (m) ids.add(m[1]);
    }
    if (ids.size === 0) throw new Error("bundle has no account.json");
    for (const id of ids) {
      const acct = JSON.parse(names.get(`accounts/${id}/account.json`).getData().toString("utf8"));
      restoreOne(zip, acct, `accounts/${id}/profile/`);
      restored.push({ id: acct.id, label: acct.label });
    }
  }
  return { restored, count: restored.length };
}
