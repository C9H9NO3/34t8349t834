// Dependency-free DTMF (touch-tone) detector for the captured call audio.
//
// The flow already taps the callee's audio as PCM16 mono @ 24 kHz. We run a
// Goertzel filter bank for the 8 DTMF frequencies over a ~25 ms window that
// SLIDES every ~10 ms (overlapping), pick the strongest low- and high-group
// tone, validate energy + dominance + twist, and require the same digit across
// a couple of consecutive hops before emitting once per keypress (debounced by
// a silence gap). Overlapping windows are what make a short key tap (~40 ms)
// land fully inside 2-3 analysis windows regardless of where it starts, so a
// single press registers reliably.
//
// This is intentionally self-contained and only fed audio while a DTMF listen
// window is open, so it never touches the normal voice/transcription path.

const LOW_FREQS = [697, 770, 852, 941];
const HIGH_FREQS = [1209, 1336, 1477, 1633];
// rows = low group, cols = high group
const DIGITS = [
  ["1", "2", "3", "A"],
  ["4", "5", "6", "B"],
  ["7", "8", "9", "C"],
  ["*", "0", "#", "D"],
];

const DEFAULTS = {
  windowMs: 25, // Goertzel analysis window (needs ~20-25 ms for freq resolution)
  hopMs: 10, // slide the window this often (overlap => catches short taps)
  magThreshold: 0.04, // min tone power as a fraction of (window energy * N)
  dominance: 3, // strongest tone must beat the next in its group by this factor
  maxTwist: 12, // allowed ratio between low/high tone powers (either direction)
  persistHops: 2, // same digit must hold this many consecutive hops
  gapHops: 3, // this many non-detecting hops resets so a press re-emits
};

// Precompute the Goertzel coefficient for a frequency at a given sample rate.
function coeffFor(freq, sampleRate) {
  return 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
}

export function createDtmfDetector({ sampleRate = 24000, onDigit, onLog, config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const N = Math.max(160, Math.round((sampleRate * cfg.windowMs) / 1000));
  const H = Math.max(40, Math.round((sampleRate * cfg.hopMs) / 1000));
  const lowCoeffs = LOW_FREQS.map((f) => coeffFor(f, sampleRate));
  const highCoeffs = HIGH_FREQS.map((f) => coeffFor(f, sampleRate));

  // Sliding window: a ring buffer of the most recent N samples (O(1) per
  // sample), linearized into `win` (oldest-first) only when we run an analysis
  // hop, so Goertzel always sees contiguous, in-order samples.
  const ring = new Float32Array(N);
  const win = new Float32Array(N);
  let ringPos = 0; // next write index into `ring`
  let total = 0; // total samples seen (so we know when the ring is full)
  let sinceHop = 0;

  // Persistence / debounce state.
  let candidate = null;
  let candidateRun = 0;
  let lastEmitted = null;
  let silenceRun = 0;
  let emittedThisPress = false;

  const log = (m) => onLog && onLog(m);

  // Goertzel power for one coefficient over the most recent N samples of `win`.
  function goertzelPower(coeff) {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < N; i++) {
      const s0 = win[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  function strongest(coeffs) {
    let bestIdx = -1;
    let best = -1;
    let second = -1;
    for (let i = 0; i < coeffs.length; i++) {
      const p = goertzelPower(coeffs[i]);
      if (p > best) {
        second = best;
        best = p;
        bestIdx = i;
      } else if (p > second) {
        second = p;
      }
    }
    return { idx: bestIdx, power: best, second };
  }

  // Analyze the current window and return a detected digit (or null).
  function analyzeWindow() {
    let energy = 0;
    for (let i = 0; i < N; i++) energy += win[i] * win[i];
    if (energy <= 1e-6) return null;

    const low = strongest(lowCoeffs);
    const high = strongest(highCoeffs);
    const minTone = cfg.magThreshold * energy * N;

    if (low.power < minTone || high.power < minTone) return null;
    if (low.power < cfg.dominance * Math.max(low.second, 1e-9)) return null;
    if (high.power < cfg.dominance * Math.max(high.second, 1e-9)) return null;
    // Twist: the two tones should be within a reasonable amplitude ratio.
    const twist = low.power > high.power ? low.power / high.power : high.power / low.power;
    if (twist > cfg.maxTwist) return null;

    return DIGITS[low.idx][high.idx];
  }

  // Copy the ring into `win` in chronological (oldest-first) order.
  function linearize() {
    for (let i = 0; i < N; i++) win[i] = ring[(ringPos + i) % N];
  }

  function handleHop() {
    let digit = null;
    if (total >= N) {
      linearize();
      digit = analyzeWindow();
    }
    if (digit) {
      silenceRun = 0;
      if (digit === candidate) {
        candidateRun++;
      } else {
        candidate = digit;
        candidateRun = 1;
      }
      if (
        candidateRun >= cfg.persistHops &&
        !(emittedThisPress && digit === lastEmitted)
      ) {
        lastEmitted = digit;
        emittedThisPress = true;
        log(`DTMF detected: ${digit}`);
        if (onDigit) onDigit(digit);
      }
    } else {
      // A run of non-detecting hops ends the current press so the next
      // keypress (even the same digit) can emit again.
      silenceRun++;
      candidate = null;
      candidateRun = 0;
      if (silenceRun >= cfg.gapHops) emittedThisPress = false;
    }
  }

  // Append one sample to the ring (O(1)); analyze once per hop.
  function pushSample(x) {
    ring[ringPos] = x;
    ringPos = (ringPos + 1) % N;
    total++;
    if (++sinceHop >= H) {
      sinceHop = 0;
      handleHop();
    }
  }

  function pushPcm16(data) {
    if (!data) return;
    // Accept an Int16Array or a Node Buffer of little-endian PCM16.
    let int16;
    if (data instanceof Int16Array) {
      int16 = data;
    } else if (Buffer.isBuffer(data)) {
      int16 = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
    } else if (ArrayBuffer.isView(data)) {
      int16 = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
    } else {
      return;
    }
    for (let i = 0; i < int16.length; i++) pushSample(int16[i] / 32768);
  }

  function reset() {
    ringPos = 0;
    total = 0;
    sinceHop = 0;
    candidate = null;
    candidateRun = 0;
    lastEmitted = null;
    silenceRun = 0;
    emittedThisPress = false;
  }

  return { pushPcm16, reset };
}
