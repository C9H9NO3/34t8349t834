// Runs in the page (via addInitScript) before any page script. It wraps the
// microphone so Google Voice receives a MediaStreamDestination we control: your
// real mic is mixed in (normal talking works) and we can play an audio file
// through it on demand. The far side hears the file live - no VB-CABLE/mpv.
//
// Exposes on window:
//   __injectAudio(base64)   - decode + play the audio into the mic
//   __stopInjectedAudio()   - stop the currently playing injected audio

export function audioInjectInit() {
  try {
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) return;

    // Shared registry of LOCAL track ids (our real mic + the stream we hand to
    // Google Voice). The capture script (remoteCapture.js) uses this to make
    // sure it never transcribes our own outgoing microphone audio.
    if (!window.__localStreamTrackIds) window.__localStreamTrackIds = new Set();
    const markLocal = (stream) => {
      try {
        stream.getTracks().forEach((t) => window.__localStreamTrackIds.add(t.id));
      } catch (e) {
        /* ignore */
      }
    };

    const origGUM = md.getUserMedia.bind(md);
    let ctx = null;
    let dest = null;
    let micConnected = false;
    let currentSource = null;

    function ensureContext() {
      if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        dest = ctx.createMediaStreamDestination();
        // The stream GV receives as its "microphone" is local - never capture.
        markLocal(dest.stream);
      }
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return ctx;
    }

    // Capture the real mic once and mix it into the destination. In mic-less
    // mode (headless/cloud host, set via window.__INJECT_MICLESS) we skip this
    // entirely so ONLY the injected WAV reaches the call - there is no mic to
    // capture and nothing of the host's audio can leak.
    async function connectRealMic() {
      if (micConnected) return;
      micConnected = true;
      if (window.__INJECT_MICLESS) return;
      try {
        const real = await origGUM({ audio: true });
        markLocal(real);
        const src = ctx.createMediaStreamSource(real);
        src.connect(dest);
      } catch (e) {
        // No real mic / denied: injected audio still works on its own.
      }
    }

    // Override getUserMedia: hand Google Voice our controllable stream.
    md.getUserMedia = async function (constraints) {
      if (!constraints || !constraints.audio) {
        return origGUM(constraints);
      }
      ensureContext();
      await connectRealMic();
      // If video was also requested, fetch it from the real device and merge.
      if (constraints.video) {
        try {
          const v = await origGUM({ video: constraints.video });
          const merged = new MediaStream([
            ...dest.stream.getAudioTracks(),
            ...v.getVideoTracks(),
          ]);
          return merged;
        } catch (e) {
          /* fall through to audio-only */
        }
      }
      return dest.stream;
    };

    function b64ToArrayBuffer(b64) {
      const bin = atob(b64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      return bytes.buffer;
    }

    window.__stopInjectedAudio = function () {
      if (currentSource) {
        try {
          currentSource.stop();
        } catch (e) {
          /* ignore */
        }
        currentSource = null;
      }
    };

    window.__injectAudio = async function (b64) {
      ensureContext();
      // Make sure GV has the stream wired even if injection happens first.
      await connectRealMic();
      let buf;
      try {
        buf = await ctx.decodeAudioData(b64ToArrayBuffer(b64));
      } catch (e) {
        // Browsers can't decode every WAV encoding (e.g. 24-bit/32-bit PCM).
        // Surface a clear, actionable message instead of a generic failure.
        throw new Error(
          "could not decode audio file - re-export as 16-bit PCM WAV (or MP3)"
        );
      }
      window.__stopInjectedAudio();
      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.connect(dest);
      source.onended = () => {
        if (currentSource === source) currentSource = null;
      };
      currentSource = source;
      source.start();
      return { durationSec: buf.duration };
    };
  } catch (e) {
    /* never break the page */
  }
}
