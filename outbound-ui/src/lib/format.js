// Small shared formatting helpers used across panels.

// Human-readable proxy location (backend stores lowercase/underscored values).
export function prettyLoc(proxy) {
  if (!proxy) return "";
  const cap = (s) =>
    (s || "")
      .split("_")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  return [cap(proxy.city), cap(proxy.region)].filter(Boolean).join(", ");
}

// Call-back rate = call-backs / total calls (whole percent).
export function callbackPct(stats) {
  if (!stats || !stats.calls) return 0;
  return Math.round((stats.callback / stats.calls) * 100);
}

// Digits-only form for matching a dialed number to a parsed contact.
export function digits(s) {
  return (s || "").replace(/\D/g, "");
}
