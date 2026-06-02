// Localhost HTTP proxy that forwards Chromium traffic to NodeMaven, injecting
// the Proxy-Authorization header on the CONNECT tunnel ourselves.
//
// Why: Chromium/Playwright sometimes fails the upstream HTTPS CONNECT with
// ERR_TUNNEL_CONNECTION_FAILED when the proxy username is a long encoded
// string (NodeMaven's region/city/sid format). curl with the same creds works,
// so the credentials are fine - it's Chromium's in-browser auth path. We point
// Chromium at this unauthenticated localhost proxy and add the auth upstream,
// which sidesteps the issue entirely.
//
// ISOLATION: each Google Voice session gets its OWN bridge instance on its own
// ephemeral localhost port (createBridge -> { url, port, stop }). Bridges never
// share state, so parallel sessions never clobber one another's proxy.

import http from "node:http";
import net from "node:net";
import { config, refreshProxyEnv } from "./config.js";
import { buildProxyUsername } from "./proxy.js";

let logger = null;

export function setBridgeLogger(fn) {
  logger = typeof fn === "function" ? fn : null;
}
function log(message) {
  if (logger) logger(`[bridge] ${message}`);
}

// Routine per-connection tunnel resets (ECONNRESET/EPIPE/ETIMEDOUT) are noise -
// almost always ad/tracker domains the remote closes. Keep them out of the
// dashboard: log to console only, and surface at most one throttled summary
// line every 30s so a real, persistent proxy problem is still discoverable.
const NOISY_TUNNEL = /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|socket hang up/i;
let droppedTunnelErrors = 0;
let lastTunnelSummary = 0;
function noteTunnelError(tag, message) {
  console.warn(`[bridge] [${tag}] tunnel error: ${message}`);
  droppedTunnelErrors += 1;
  const now = Date.now();
  if (now - lastTunnelSummary > 30000) {
    if (droppedTunnelErrors > 1 && logger) {
      logger(`[bridge] suppressed ${droppedTunnelErrors} transient tunnel resets (last 30s)`);
    }
    lastTunnelSummary = now;
    droppedTunnelErrors = 0;
  }
}

function upstreamAuth(acct) {
  const p = config.proxy;
  const token = Buffer.from(`${buildProxyUsername(acct)}:${p.pass}`).toString("base64");
  return `Basic ${token}`;
}

// Starts an isolated bridge for one account. Resolves with the localhost URL
// Chromium should use as its proxy server, plus a stop() to tear it down.
export function createBridge(acct) {
  return new Promise((resolve, reject) => {
    refreshProxyEnv();
    const p = config.proxy;
    const upstreamHost = p.host;
    const upstreamPort = p.port;
    const auth = upstreamAuth(acct);
    const tag = acct && acct.id ? acct.id.slice(0, 8) : "?";

    const srv = http.createServer((req, res) => {
      // Plain HTTP request: forward to the upstream proxy using the absolute URL
      // form and our injected Proxy-Authorization header.
      const headers = { ...req.headers, "proxy-authorization": auth };
      const proxyReq = http.request(
        { host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );
      proxyReq.on("error", (err) => {
        log(`[${tag}] http forward error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(proxyReq);
    });

    // HTTPS tunnel: open our own CONNECT to NodeMaven with auth, then relay the
    // raw byte stream both ways. We pipe NodeMaven's CONNECT response straight
    // back to the client rather than parsing it ourselves - NodeMaven sends the
    // 200 response headers across multiple TCP segments, so waiting to parse a
    // full header here stalls the tunnel. The client reads the upstream 200 and
    // proceeds with its TLS handshake.
    srv.on("connect", (req, clientSocket, head) => {
      const upstream = net.connect(upstreamPort, upstreamHost, () => {
        upstream.write(
          `CONNECT ${req.url} HTTP/1.1\r\n` +
            `Host: ${req.url}\r\n` +
            `Proxy-Authorization: ${auth}\r\n\r\n`
        );
        if (head && head.length) upstream.write(head);
        // Sniff (not consume) the upstream CONNECT status purely for logging, so
        // a non-200 (e.g. 503 = exit unavailable, 407 = auth) is visible in the
        // dashboard instead of surfacing only as a generic browser tunnel error.
        let sniffed = false;
        const sniff = (chunk) => {
          if (sniffed) return;
          sniffed = true;
          const line = chunk.slice(0, chunk.indexOf("\r\n") >>> 0 || chunk.length).toString();
          if (!/ 2\d\d /.test(line)) log(`[${tag}] upstream CONNECT ${req.url}: ${line.trim()}`);
        };
        upstream.on("data", sniff);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", (err) => {
        // Routine resets -> console-only/throttled; anything else -> dashboard.
        if (NOISY_TUNNEL.test(err.message)) noteTunnelError(tag, `${req.url}: ${err.message}`);
        else log(`[${tag}] tunnel error (${req.url}): ${err.message}`);
        clientSocket.destroy();
      });
      // Destroy the paired socket on close (not just error) so tunnels from a
      // closing browser don't linger and keep generating resets.
      clientSocket.on("error", () => upstream.destroy());
      clientSocket.on("close", () => upstream.destroy());
      upstream.on("close", () => clientSocket.destroy());
    });

    srv.on("error", (err) => reject(err));
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      log(`[${tag}] listening on 127.0.0.1:${port} -> ${upstreamHost}:${upstreamPort}`);
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        try {
          srv.close();
        } catch {
          /* ignore */
        }
      };
      resolve({ url: `http://127.0.0.1:${port}`, port, stop });
    });
  });
}
