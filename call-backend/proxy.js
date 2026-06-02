// Builds NodeMaven residential proxy settings for a Google Voice account.
//
// NodeMaven username encodes targeting + sticky session:
//   USER-country-us-region-<state>-city-<city>-sid-<sticky>-filter-<quality>
// Same `sid` => same residential IP (sticky). Residential is the default
// (no `-type-mobile`). Host gate.nodemaven.com, HTTP port 8080.

import { config, refreshProxyEnv } from "./config.js";

// Whether proxying is on AND we have credentials to use it.
export function proxyConfigured() {
  refreshProxyEnv();
  const p = config.proxy;
  return Boolean(p && p.enabled && p.user && p.pass);
}

/** Human-readable reason when proxyConfigured() is false (for logs / UI). */
export function proxyStatus() {
  refreshProxyEnv();
  const p = config.proxy || {};
  if (!p.enabled) return { ok: false, reason: "PROXY_ENABLED is not true in .env" };
  if (!p.user) return { ok: false, reason: "NODEMAVEN_USER missing in .env" };
  if (!p.pass) return { ok: false, reason: "NODEMAVEN_PASS missing in .env" };
  return { ok: true, reason: "NodeMaven residential proxy active" };
}

// How Chromium reaches NodeMaven: "off" | "bridge" | "socks5" | "direct".
// "bridge" is the default (localhost proxy that injects auth on CONNECT).
export function proxyMode() {
  if (!proxyConfigured()) return "off";
  const p = config.proxy;
  if (p.useSocks5) return "socks5";
  if (p.bridge) return "bridge";
  return "direct";
}

// Builds the NodeMaven username string for an account's assigned location.
export function buildProxyUsername(acct) {
  const p = config.proxy;
  const loc = (acct && acct.proxy) || {};
  const parts = [p.user, "country", loc.country || p.country || "us"];
  if (loc.region) parts.push("region", loc.region);
  if (loc.city) parts.push("city", loc.city);
  if (loc.sid) parts.push("sid", loc.sid);
  if (p.filter) parts.push("filter", p.filter);
  // Speed prioritization: NodeMaven draws from its fast pool when the username
  // carries "speed-fast" (e.g. filter-medium-speed-fast = Quality + Speed).
  if (p.speedFast) parts.push("speed", "fast");
  return parts.join("-");
}

// Returns a Playwright `proxy` object for the account, or null if disabled.
// Honors the SOCKS5 fallback toggle; the bridge mode is handled separately in
// the controller (it points Chromium at a localhost proxy instead).
export function playwrightProxy(acct) {
  if (!proxyConfigured()) return null;
  const p = config.proxy;
  if (p.useSocks5) {
    return {
      server: `socks5://${p.host}:${p.socksPort || 1080}`,
      username: buildProxyUsername(acct),
      password: p.pass,
    };
  }
  return {
    server: `http://${p.host}:${p.port}`,
    username: buildProxyUsername(acct),
    password: p.pass,
  };
}
