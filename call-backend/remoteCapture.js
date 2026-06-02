// Runs in the page (via addInitScript). Captures the REMOTE party's audio from
// the Google Voice call, downsamples it to 16 kHz PCM16, and hands it to Node
// through Playwright bindings (window.__sttPush) for live transcription.
//
// Why bindings instead of a WebSocket: an insecure ws://127.0.0.1 connection
// opened from inside https://voice.google.com is blocked by Chrome (mixed
// content / Private Network Access), so the socket silently never opens.
// Playwright bindings ride Playwright's own channel and are not subject to
// page CSP / mixed-content / PNA, so audio always reaches the backend.

export function remoteCaptureInit() {
  try {
    // OpenAI Realtime transcription requires 24 kHz mono PCM16.
    const TARGET_RATE = 24000;

    function log(m) {
      try {
        if (typeof window.__sttLog === "function") window.__sttLog(String(m));
      } catch (e) {
        /* ignore */
      }
    }
    function state(s) {
      try {
        if (typeof window.__sttState === "function") window.__sttState(String(s));
      } catch (e) {
        /* ignore */
      }
    }
    function push(b64) {
      try {
        if (typeof window.__sttPush === "function") window.__sttPush(b64);
      } catch (e) {
        /* ignore */
      }
    }

    let ctx = null;
    const connectedTrackIds = new Set();
    // Active capture nodes by track id, so we can tear them down on call end.
    const activeNodes = new Map();

    function isLocalTrack(track) {
      try {
        return Boolean(
          window.__localStreamTrackIds && window.__localStreamTrackIds.has(track.id)
        );
      } catch (e) {
        return false;
      }
    }

    // Disconnect the audio nodes for a track. When `silent` is true we are
    // replacing the source (re-dial / extra track) and must NOT emit
    // capture-idle, so the open STT session keeps running uninterrupted.
    function teardownTrack(trackId, { silent = false } = {}) {
      const n = activeNodes.get(trackId);
      if (n) {
        try {
          n.processor.onaudioprocess = null;
          n.src.disconnect();
          n.processor.disconnect();
          n.sink.disconnect();
        } catch (e) {
          /* ignore */
        }
        activeNodes.delete(trackId);
      }
      connectedTrackIds.delete(trackId);
      if (!silent && activeNodes.size === 0) {
        state("capture-idle");
        log("all capture tracks ended");
      }
    }

    function teardownAll() {
      for (const id of Array.from(activeNodes.keys())) teardownTrack(id);
    }

    // Heartbeat: every ~2s report peak level + chunk count so we can tell
    // whether we're capturing real speech or silence/wrong track.
    let chunkCount = 0;
    let peakLevel = 0;
    let lastHeartbeat = 0;
    function heartbeat() {
      const now = Date.now();
      if (now - lastHeartbeat < 2000) return;
      lastHeartbeat = now;
      const lvl = peakLevel.toFixed(3);
      const cs = ctx ? ctx.state : "none";
      log(`audio level=${lvl}, chunks=${chunkCount}, ctx=${cs}`);
      peakLevel = 0;
    }

    function downsample(buffer, inRate, outRate) {
      if (outRate >= inRate) return buffer;
      const ratio = inRate / outRate;
      const newLen = Math.round(buffer.length / ratio);
      const result = new Float32Array(newLen);
      let oRes = 0;
      let oBuf = 0;
      while (oRes < newLen) {
        const next = Math.round((oRes + 1) * ratio);
        let acc = 0;
        let cnt = 0;
        for (let i = oBuf; i < next && i < buffer.length; i++) {
          acc += buffer[i];
          cnt++;
        }
        result[oRes] = cnt ? acc / cnt : 0;
        oRes++;
        oBuf = next;
      }
      return result;
    }

    // Encode an Int16Array's bytes to base64 (chunked to avoid arg limits).
    function pcm16ToBase64(int16) {
      const bytes = new Uint8Array(int16.buffer);
      let binary = "";
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        binary += String.fromCharCode.apply(
          null,
          bytes.subarray(i, i + CH)
        );
      }
      return btoa(binary);
    }

    function floatToPcm16(f32) {
      const out = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        const s = Math.max(-1, Math.min(1, f32[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }

    async function ensureAudioContext() {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch (e) {
          /* ignore */
        }
      }
      return ctx;
    }

    // Wire a MediaStream's audio track into a ScriptProcessor that pushes PCM.
    function attachStream(stream, sourceLabel) {
      if (!stream || typeof stream.getAudioTracks !== "function") return;
      stream.getAudioTracks().forEach((track) => {
        if (connectedTrackIds.has(track.id)) return;
        // Never transcribe our own outgoing microphone (remote audio only).
        if (isLocalTrack(track)) {
          log(`skipped local mic track (${sourceLabel})`);
          return;
        }
        // Capture exactly ONE source. If another track is already active (an
        // extra negotiated track or a re-dial), silently drop it and switch to
        // this newest one - feeding two streams into one STT buffer interleaves
        // the audio, which doubles words and confuses language detection.
        if (activeNodes.size > 0) {
          for (const id of Array.from(activeNodes.keys())) {
            teardownTrack(id, { silent: true });
          }
          log("switched capture to newest remote track");
        }
        connectedTrackIds.add(track.id);
        state("track");
        log(`audio track attached via ${sourceLabel}`);
        ensureAudioContext()
          .then((audioCtx) => {
            const src = audioCtx.createMediaStreamSource(new MediaStream([track]));
            const processor = audioCtx.createScriptProcessor(4096, 1, 1);
            src.connect(processor);
            const sink = audioCtx.createGain();
            sink.gain.value = 0;
            processor.connect(sink);
            sink.connect(audioCtx.destination);
            processor.onaudioprocess = (e) => {
              const input = e.inputBuffer.getChannelData(0);
              // Track peak amplitude for the heartbeat.
              for (let i = 0; i < input.length; i++) {
                const a = Math.abs(input[i]);
                if (a > peakLevel) peakLevel = a;
              }
              const down = downsample(input, audioCtx.sampleRate, TARGET_RATE);
              push(pcm16ToBase64(floatToPcm16(down)));
              chunkCount++;
              heartbeat();
            };
            activeNodes.set(track.id, { src, processor, sink });
            // Tear down when the call's remote track ends/mutes.
            track.addEventListener("ended", () => teardownTrack(track.id));
            track.addEventListener("mute", () => teardownTrack(track.id));
          })
          .catch((err) => log(`attachStream error: ${err && err.message}`));
      });
    }

    // --- Path 1: intercept RTCPeerConnection remote tracks ----------------- //
    try {
      const NativeRTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (NativeRTC) {
        function hookPeerConnection(pc) {
          // The "track" event fires for REMOTE (receiver) tracks only - this is
          // the authoritative source of the other party's incoming audio.
          pc.addEventListener("track", (ev) => {
            if (ev.streams && ev.streams[0]) attachStream(ev.streams[0], "rtc-track");
            else if (ev.track && ev.track.kind === "audio") {
              attachStream(new MediaStream([ev.track]), "rtc-track");
            }
          });
          pc.addEventListener("connectionstatechange", () => {
            const s = pc.connectionState;
            if (s === "closed" || s === "failed" || s === "disconnected") {
              log(`pc ${s} - tearing down capture`);
              teardownAll();
            }
          });
        }
        function Wrapped(...args) {
          const pc = new NativeRTC(...args);
          hookPeerConnection(pc);
          return pc;
        }
        Wrapped.prototype = NativeRTC.prototype;
        window.RTCPeerConnection = Wrapped;
        if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped;
        log("RTCPeerConnection hook installed");
      }
    } catch (e) {
      log(`RTC hook error: ${e && e.message}`);
    }

    // --- Path 2 (fallback): grab remote audio from media elements ---------- //
    // GV plays the remote party through an <audio>/<video> element whose
    // srcObject is a MediaStream. Capture it in case the track event is missed.
    try {
      const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
      if (proto) {
        const desc = Object.getOwnPropertyDescriptor(proto, "srcObject");
        if (desc && desc.set && desc.get) {
          Object.defineProperty(proto, "srcObject", {
            configurable: true,
            enumerable: desc.enumerable,
            get() {
              return desc.get.call(this);
            },
            set(stream) {
              try {
                if (stream && typeof stream.getAudioTracks === "function") {
                  attachStream(stream, "media-element");
                }
              } catch (e) {
                /* ignore */
              }
              return desc.set.call(this, stream);
            },
          });
          log("HTMLMediaElement.srcObject hook installed");
        }
      }
    } catch (e) {
      log(`media-element hook error: ${e && e.message}`);
    }

    state("capture-ready");
    log("capture ready");
  } catch (e) {
    /* never break the page */
  }
}
