// Maps an internal runFlow outcome ({ category, reason } plus the callback
// source `via`) to a single canonical outcome category used end-to-end:
// persisted in callHistory, broadcast to the UI, and used for re-run skipping.
//
// Canonical categories:
//   pressed_1       - callback via DTMF key 1
//   callback_voice  - spoken callback
//   call_screened   - screening detected (automated or human gatekeeper)
//   uncallable      - wrong/disconnected/dial-failed number
//   picked_up       - answered, greeting played, no callback/keypress
//   no_callback     - answered, explicitly declined a callback
//   hung_up_early   - answered then hung up before a conclusion
//   no_answer       - rang with no pickup / transient error
//   declined        - instant decline (rejected immediately) / declined twice

export function canonicalCategory(category, reason, via = null) {
  const r = String(reason || "");
  if (r === "callback") return via === "dtmf" ? "pressed_1" : "callback_voice";
  if (r === "no_callback") return "no_callback";
  if (r === "no_response") return "picked_up";
  if (r === "hung_up") return "hung_up_early";
  if (r === "call_screening") return "call_screened";
  if (r === "wrong_number" || r === "dial_failed") return "uncallable";
  if (r === "instant_decline" || r === "declined_twice") return "declined";
  if (r === "no_answer") return "no_answer";
  if (r.startsWith("error")) return "no_answer"; // transient -> re-callable

  // Fallback by category bucket if the reason is unrecognized.
  if (category === "picked_up") return "picked_up";
  if (category === "uncallable") return "uncallable";
  if (category === "declined") return "declined";
  return "no_answer";
}
