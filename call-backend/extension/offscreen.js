// Captures the tab audio (via the provided streamId), keeps it audible, and
// streams 16 kHz PCM16 frames to the backend's /audio WebSocket.

const BACKEND_AUDIO_WS = "ws://127.0.0.1:8787/audio";
const TARGET_RATE = 16000;

let ws = null;
let ctx = null;
let source = null;
let processor = null;
let stream = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "start-capture") start(msg.streamId);
  if (msg.type === "stop-capture") stop();
});

async function start(streamId) {
  stop();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  ctx = new AudioContext();
  source = ctx.createMediaStreamSource(stream);

  // Keep the call audible to the user.
  source.connect(ctx.destination);

  ws = new WebSocket(BACKEND_AUDIO_WS);
  ws.binaryType = "arraybuffer";

  processor = ctx.createScriptProcessor(4096, 1, 1);
  source.connect(processor);
  // Mute the processor branch so we don't double the audio.
  const silent = ctx.createGain();
  silent.gain.value = 0;
  processor.connect(silent);
  silent.connect(ctx.destination);

  processor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const down = downsample(input, ctx.sampleRate, TARGET_RATE);
    ws.send(floatToPcm16(down));
  };
}

function stop() {
  try {
    processor && processor.disconnect();
    source && source.disconnect();
    stream && stream.getTracks().forEach((t) => t.stop());
    ctx && ctx.close();
    ws && ws.close();
  } catch {
    /* ignore */
  }
  processor = source = stream = ctx = ws = null;
}

function downsample(buffer, inRate, outRate) {
  if (outRate >= inRate) return buffer;
  const ratio = inRate / outRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < newLen) {
    const nextOffset = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffset && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffset;
  }
  return result;
}

function floatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}
