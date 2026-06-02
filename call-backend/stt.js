// Streams call audio (PCM16) to OpenAI's Realtime transcription API and emits
// partial/final transcript text via callbacks. No-ops gracefully without a key.
//
// OpenAI Realtime (GA) requirements - do NOT regress these:
//   - Do NOT send the `OpenAI-Beta` header. The GA API rejects the Beta shape
//     with {code: "beta_api_shape_disabled"} and closes the socket (code 4000).
//   - URL: wss://api.openai.com/v1/realtime?intent=transcription
//   - Configure via `session.update` -> session.type: "transcription" with
//     audio.input.format { type: "audio/pcm", rate: 24000 } (24 kHz mono PCM16).
//   - Result events: conversation.item.input_audio_transcription.delta/.completed
//   - Models: gpt-4o-mini-transcribe (current, supports server_vad) or
//     gpt-realtime-whisper (streaming; omit turn_detection, commit manually).

import WebSocket from "ws";
import { config } from "./config.js";

export function createTranscriber({ onPartial, onFinal, onLog } = {}) {
  const log = (m) => onLog && onLog(m);

  if (!config.openaiApiKey) {
    log("STT disabled (no OpenAI API key in config).");
    return { pushAudio() {}, close() {}, enabled: false };
  }

  let ws = null;
  let ready = false;
  const queue = [];
  // Log the first few distinct server event types so an unexpected response
  // shape is obvious in the dashboard log.
  const seenTypes = new Set();
  let typeLogBudget = 6;
  let vadStartLogged = false;
  let vadStopLogged = false;
  let lastErrorCode = null;

  function open() {
    // GA Realtime API: Authorization only. Sending the OpenAI-Beta header here
    // forces the disabled Beta shape (beta_api_shape_disabled / close 4000).
    ws = new WebSocket(
      "wss://api.openai.com/v1/realtime?intent=transcription",
      {
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
        },
      }
    );

    ws.on("open", () => {
      // GA Realtime transcription session shape (session.update / type:
      // "transcription" / audio.input.format). The older beta shape
      // (transcription_session.update + input_audio_format) is rejected and
      // produces no transcript.
      const transcription = {
        model: config.sttModel,
        language: config.sttLanguage || "en",
      };
      // `prompt` is supported for gpt-4o(-mini)-transcribe but NOT for
      // gpt-realtime-whisper - only include it when set and model supports it.
      if (config.sttPrompt && config.sttModel !== "gpt-realtime-whisper") {
        transcription.prompt = config.sttPrompt;
      }
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: config.sttSampleRate },
                transcription,
                turn_detection: { type: "server_vad" },
              },
            },
          },
        })
      );
      ready = true;
      while (queue.length) ws.send(queue.shift());
      log(`STT connected (pcm16 @ ${config.sttSampleRate} Hz, model ${config.sttModel}).`);
    });

    ws.on("message", (data) => {
      let evt;
      try {
        evt = JSON.parse(data.toString());
      } catch {
        return;
      }
      const t = evt.type || "";

      // One-time visibility into what the server actually sends back.
      if (typeLogBudget > 0 && !seenTypes.has(t)) {
        seenTypes.add(t);
        typeLogBudget--;
        log(`STT event: ${t}`);
      }

      // VAD lifecycle (server_vad) - confirms the server hears speech.
      if (t.endsWith("input_audio_buffer.speech_started")) {
        if (!vadStartLogged) {
          vadStartLogged = true;
          log("STT detected speech.");
        }
        return;
      }
      if (t.endsWith("input_audio_buffer.speech_stopped")) {
        if (!vadStopLogged) {
          vadStopLogged = true;
          log("STT speech ended.");
        }
        return;
      }

      // Transcription results: accept beta + GA event shapes.
      const isTranscription = t.includes("input_audio_transcription");
      if (
        (isTranscription && t.endsWith(".delta")) ||
        t === "response.audio_transcript.delta"
      ) {
        const text = evt.delta || evt.text || "";
        if (text) onPartial && onPartial(text);
      } else if (
        (isTranscription && (t.endsWith(".completed") || t.endsWith(".done"))) ||
        t === "response.audio_transcript.done"
      ) {
        const text = evt.transcript || evt.text || "";
        if (text) onFinal && onFinal(text);
      } else if (t === "error" || t.endsWith(".error")) {
        const errObj = evt.error || evt;
        lastErrorCode = (errObj && errObj.code) || lastErrorCode;
        log(`STT error: ${JSON.stringify(errObj)}`);
      }
    });

    ws.on("error", (err) => log(`STT socket error: ${err.message}`));
    ws.on("close", (code) => {
      if (code === 4000 || lastErrorCode === "beta_api_shape_disabled") {
        log(
          "STT rejected as Beta API - the OpenAI-Beta header must NOT be sent (GA API). " +
            "See the GA notes at the top of stt.js."
        );
      }
      ready = false;
      log(`STT closed (code ${code}).`);
    });
  }

  open();

  return {
    enabled: true,
    // base64 string or Buffer of PCM16 mono @ config.sttSampleRate
    pushAudio(base64Pcm) {
      const msg = JSON.stringify({
        type: "input_audio_buffer.append",
        audio: typeof base64Pcm === "string" ? base64Pcm : Buffer.from(base64Pcm).toString("base64"),
      });
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(msg);
      else queue.push(msg);
    },
    close() {
      try {
        ws && ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
