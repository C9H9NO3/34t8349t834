// Shared-password gate for the hosted dashboard. When config.dashboardPassword
// is empty (local dev) auth is disabled and everything is allowed. When set,
// the client posts the password to /auth and receives an httpOnly cookie; the
// cookie is then required on the gated HTTP API routes and the WS upgrades.

import crypto from "node:crypto";
import { config } from "./config.js";

export function authEnabled() {
  return Boolean(config.dashboardPassword);
}

// Opaque cookie value derived from the password (never store the raw password).
export function expectedToken() {
  return crypto.createHash("sha256").update(String(config.dashboardPassword)).digest("hex");
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function checkPassword(pw) {
  if (!authEnabled()) return true;
  return typeof pw === "string" && safeEqual(pw, config.dashboardPassword);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// True if the request carries a valid auth cookie (or auth is disabled).
export function requestAuthorized(req) {
  if (!authEnabled()) return true;
  const token = parseCookies(req.headers.cookie).ds_auth;
  return Boolean(token) && safeEqual(token, expectedToken());
}

// Express middleware: 401 when unauthorized.
export function requireAuth(req, res, next) {
  if (requestAuthorized(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

// Builds the Set-Cookie header value for a successful login. Marks Secure when
// the client reached us over HTTPS (Railway terminates TLS at its proxy).
export function buildAuthCookie(req) {
  const https = req.headers["x-forwarded-proto"] === "https";
  const parts = [
    `ds_auth=${expectedToken()}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=2592000",
  ];
  if (https) parts.push("Secure");
  return parts.join("; ");
}
