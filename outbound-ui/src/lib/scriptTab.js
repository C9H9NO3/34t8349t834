// Opens a filled call script in a new browser tab as a standalone, readable page.

function esc(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function openScriptTab(item) {
  if (!item) return;
  const { contact, number, script } = item;
  const title = esc(contact.fullName || "Script");
  const meta = [number, contact.emails[0], contact.location]
    .filter(Boolean)
    .map(esc)
    .join("  &bull;  ");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title} - call script</title>
<style>
  body { margin: 0; background: #0f1115; color: #eef1f6;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 44px 24px; }
  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -0.02em; }
  .meta { color: #9aa3b2; margin-bottom: 26px; font-size: 15px; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: inherit;
    font-size: 21px; line-height: 1.75; background: #171a21; border: 1px solid #2a2f3a;
    border-radius: 14px; padding: 30px; margin: 0; }
  button { margin-top: 20px; background: #3a6bff; color: #fff; border: none;
    border-radius: 8px; padding: 11px 18px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:hover { background: #5b8cff; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${title}</h1>
    <div class="meta">${meta}</div>
    <pre id="script">${esc(script)}</pre>
    <button onclick="navigator.clipboard.writeText(document.getElementById('script').innerText)">Copy script</button>
  </div>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (win) {
    win.document.open();
    win.document.write(html);
    win.document.close();
    return;
  }
  // Popup blocked: fall back to a blob URL the user can open manually.
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
