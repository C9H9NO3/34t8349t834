// Maps an internal runFlow outcome ({ category, reason } plus the callback
// source `via`) to a single canonical outcome category used end-to-end:
// persisted in callHistory, broadcast to the UI, and used for re-run skipping.
//
// Canonical categories (the 5-bucket model):
//   schedule_callback - pressed 1 OR spoken denial ("this wasn't me"). The
//                       press-1-vs-voice distinction is kept in `via` for
//                       analytics, NOT as a separate category.
//   pickup_silent     - answered but no callback: silence, unrelated speech,
//                       "yes that was me / it's fine", or hung up after answer.
//   auto_decline      - rang then dropped before answer (instant decline);
//                       campaign retries once (DND), then concludes here.
//   no_answer         - rang out to timeout with no pickup (re-callable).
//   uncallable        - disconnected/invalid number, dial failure, OR call
//                       screening ("state your name"). Hang up, never re-call.

export function canonicalCategory(category, reason, _via = null) {
  const r = String(reason || "");

  // Callback confirmed (key 1 or voice) -> one bucket; `via` carries the detail.
  if (r === "callback") return "schedule_callback";

  // Answered but no callback scheduled.
  if (r === "no_callback" || r === "no_response" || r === "hung_up") return "pickup_silent";

  // Carrier intercept / screening / dialer failure -> not callable.
  if (r === "call_screening" || r === "wrong_number" || r === "dial_failed") return "uncallable";

  // Instant decline (and the campaign's post-retry conclusion).
  if (r === "instant_decline" || r === "declined_twice") return "auto_decline";

  // Rang out, or a transient error we can safely retry later.
  if (r === "no_answer") return "no_answer";
  if (r.startsWith("error")) return "no_answer";

  // Fallback by internal category bucket if the reason is unrecognized.
  if (category === "picked_up") return "pickup_silent";
  if (category === "uncallable") return "uncallable";
  if (category === "declined") return "auto_decline";
  return "no_answer";
}
