// Quick regression check: launch Chromium through the configured proxy path
// (bridge by default) and confirm it can reach an IP-echo endpoint. Prints the
// egress JSON and exits 0 on success, 1 on failure - without opening Google
// Voice, so you can isolate proxy problems.
//
// Usage: npm run test:proxy

import { chromium } from "playwright";
import { config } from "../config.js";
import * as accounts from "../accounts.js";
import { proxyMode, proxyStatus, playwrightProxy } from "../proxy.js";
import { startBridge, stopBridge } from "../proxyBridge.js";

async function main() {
  const st = proxyStatus();
  const mode = proxyMode();
  console.log(`proxy: ${st.ok ? `ON (${mode})` : `OFF — ${st.reason}`}`);

  const list = accounts.list();
  const activeId = accounts.getActiveId();
  const acct = (activeId && accounts.get(activeId)) || list[0];
  if (!acct) {
    console.error("No accounts configured - add one in the dashboard first.");
    process.exit(1);
  }
  console.log(`account: ${acct.label} (assigned ${acct.proxy?.region}/${acct.proxy?.city})`);

  let proxy = null;
  if (mode === "bridge") {
    const { url } = await startBridge(acct);
    console.log(`bridge: ${url}`);
    proxy = { server: url };
  } else if (mode === "socks5" || mode === "direct") {
    proxy = playwrightProxy(acct);
  }

  const useBundled = Boolean(proxy && config.proxy.useBundledChromium);
  const launchOpts = { headless: true };
  if (proxy) launchOpts.proxy = proxy;
  if (config.stealth?.channel && !useBundled) launchOpts.channel = config.stealth.channel;

  let browser;
  try {
    browser = await chromium.launch(launchOpts).catch(async (err) => {
      if (launchOpts.channel) {
        console.warn(`channel launch failed (${err.message}); using bundled Chromium`);
        delete launchOpts.channel;
        return chromium.launch(launchOpts);
      }
      throw err;
    });
    const page = await browser.newPage();
    await page.goto("https://ipinfo.io/json", { waitUntil: "domcontentloaded", timeout: 20000 });
    const text = await page.evaluate(() => document.body.innerText || "");
    console.log("egress:", text.trim());
    console.log("RESULT: OK");
    process.exitCode = 0;
  } catch (err) {
    console.error("RESULT: FAILED —", err.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopBridge();
  }
}

main();
