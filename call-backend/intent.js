// Classifies the customer's spoken reply (live transcript) into a call-flow
// intent: "callback" (deny/needs a human follow-up), "no_callback" (confirmed,
// handled), or "unclear" (keep listening). Uses OpenAI chat completions with
// the prompt in config.intent; falls back to a regex when no API key is set.
// Never throws and never hangs (hard timeout + abort-signal aware).

import { config } from "./config.js";

// Regex fallback used only when there is no OpenAI key. Intentionally simple.
const FALLBACK_CALLBACK =
  /\b(call\s*me\s*back|call\s*back|wasn'?t\s*me|that'?s\s*not\s*me|not\s*me|i\s*did\s*n'?t|i\s*never|never\s*(made|did|authorized)|this\s*is\s*n'?t\s*me|speak\s*to\s*(someone|a\s*person|a\s*human))\b/i;
const FALLBACK_NO =
  /\b(yes,?\s*(that\s*was\s*me|i\s*did|it\s*was\s*me)|that'?s\s*(right|correct|me)|it'?s\s*fine|no\s*problem|yeah\s*i\s*did|that\s*was\s*me)\b/i;
const FALLBACK_SCREENING =
  /\b(say\s+your\s+name|state\s+(your\s+name|the\s+reason)|press\s+(one|1)\s+to\s+connect|being\s+screened|call\s+screening|screening\s+service|record\s+your\s+name|(provide|give\s+me|may\s+i\s+(ask|have|get)|can\s+i\s+(ask|have|get|take)|who'?s|whom)\s+.*\b(name|calling|message)|i'?ll\s+see\s+if\s+(this\s+person|they|he|she)('?s|\s+is|\s+are)?\s*(available|here|in)|let\s+me\s+(see|check)\s+if\s+(they|he|she|this\s+person)|are\s+they\s+expecting|what('?s| is)\s+this\s+regarding|take\s+a\s+message)\b/i;
const FALLBACK_WRONG =
  /\b(not\s+in\s+service|been\s+disconnected|no\s+longer\s+in\s+service|cannot\s+be\s+completed|check\s+the\s+number|number\s+you\s+(have\s+)?dialed|not\s+a\s+working\s+number)\b/i;

function fallbackClassify(text) {
  if (FALLBACK_WRONG.test(text)) return { intent: "wrong_number", confidence: 0.5, reason: "regex" };
  if (FALLBACK_SCREENING.test(text)) return { intent: "call_screening", confidence: 0.5, reason: "regex" };
  if (FALLBACK_CALLBACK.test(text)) return { intent: "callback", confidence: 0.5, reason: "regex" };
  if (FALLBACK_NO.test(text)) return { intent: "no_callback", confidence: 0.5, reason: "regex" };
  return { intent: "unclear", confidence: 0, reason: "regex-none" };
}

const VALID_INTENTS = ["callback", "no_callback", "call_screening", "wrong_number", "unclear"];

// transcript: accumulated customer speech. signal: optional AbortSignal (flow).
export async function classifyIntent(transcript, signal) {
  const text = (transcript || "").trim();
  if (!text) return { intent: "unclear", confidence: 0, reason: "empty" };

  if (!config.openaiApiKey) return fallbackClassify(text);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.intent.timeoutMs || 6000);
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.intent.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: config.intent.prompt },
          { role: "user", content: `Customer reply (live transcript):\n"""${text}"""` },
        ],
      }),
      signal: ac.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Fail safe: don't block the flow on an API hiccup - try the regex.
      return { ...fallbackClassify(text), reason: `http ${res.status} ${body.slice(0, 120)}` };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {};
    }
    const intent = VALID_INTENTS.includes(parsed.intent) ? parsed.intent : "unclear";
    return {
      intent,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
      reason: parsed.reason || "",
    };
  } catch (err) {
    // Timeout/abort/network: fall back to regex so the flow keeps moving.
    return { ...fallbackClassify(text), reason: `error ${err.message}` };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
