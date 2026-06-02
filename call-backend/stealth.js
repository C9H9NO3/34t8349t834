// Stealth init script applied to every page before its own scripts run.
// Patches the common JavaScript signals automation tools leak so the browser
// looks like a normal Chrome. Pointing Playwright at real Chrome (channel:
// 'chrome') covers the network/TLS layer; this covers the JS layer.
//
// Exported as a plain function and passed to context.addInitScript().

export function stealthInit() {
  // --- navigator.webdriver -> undefined ---
  try {
    Object.defineProperty(Object.getPrototypeOf(navigator), "webdriver", {
      get: () => undefined,
      configurable: true,
    });
  } catch (e) {
    /* ignore */
  }
  try {
    delete Object.getPrototypeOf(navigator).webdriver;
  } catch (e) {
    /* ignore */
  }

  // --- window.chrome (present in real Chrome, missing under automation) ---
  try {
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }
    window.chrome.app = window.chrome.app || {
      isInstalled: false,
      InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
      RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
    };
    window.chrome.csi = window.chrome.csi || function () {};
    window.chrome.loadTimes = window.chrome.loadTimes || function () {};
  } catch (e) {
    /* ignore */
  }

  // --- navigator.languages ---
  try {
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
      configurable: true,
    });
  } catch (e) {
    /* ignore */
  }

  // --- navigator.plugins / mimeTypes (empty under automation) ---
  try {
    const pluginData = [
      { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
      { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
    ];
    const fakePlugins = pluginData.map((p) => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name: { value: p.name },
        filename: { value: p.filename },
        description: { value: p.description },
        length: { value: 1 },
      });
      return plugin;
    });
    Object.defineProperty(navigator, "plugins", {
      get: () => {
        const arr = fakePlugins.slice();
        arr.item = (i) => arr[i];
        arr.namedItem = (n) => arr.find((x) => x.name === n);
        arr.refresh = () => {};
        return arr;
      },
      configurable: true,
    });
  } catch (e) {
    /* ignore */
  }

  // --- permissions.query (notifications should be "prompt", not "denied") ---
  try {
    const original = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (parameters) =>
      parameters && parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission === "denied" ? "prompt" : Notification.permission })
        : original(parameters);
  } catch (e) {
    /* ignore */
  }

  // --- WebGL vendor/renderer -> a real GPU string instead of SwiftShader ---
  try {
    const spoof = function (getParameter) {
      return function (parameter) {
        // UNMASKED_VENDOR_WEBGL
        if (parameter === 37445) return "Google Inc. (Intel)";
        // UNMASKED_RENDERER_WEBGL
        if (parameter === 37446)
          return "ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)";
        return getParameter.call(this, parameter);
      };
    };
    if (typeof WebGLRenderingContext !== "undefined") {
      const gp = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = spoof(gp);
    }
    if (typeof WebGL2RenderingContext !== "undefined") {
      const gp2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = spoof(gp2);
    }
  } catch (e) {
    /* ignore */
  }

  // --- realistic hardware values ---
  try {
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8, configurable: true });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8, configurable: true });
  } catch (e) {
    /* ignore */
  }
}
