// Generates a clear, short melody as a 16-bit PCM WAV with no dependencies.
// Used as the "test audio" injected into the Google Voice mic via Chromium's
// --use-file-for-fake-audio-capture (which requires a .wav file).
//
//   node gen_test_audio.js
//
// Output: audio/testtone.wav

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "audio", "testtone.wav");

const SAMPLE_RATE = 48000;
const AMP = 0.28; // headroom to avoid clipping

// "Twinkle Twinkle Little Star" first two phrases - very recognizable.
const N = {
  C: 261.63, D: 293.66, E: 329.63, F: 349.23, G: 392.0, A: 440.0,
};
const melody = [
  ["C", 0.4], ["C", 0.4], ["G", 0.4], ["G", 0.4], ["A", 0.4], ["A", 0.4], ["G", 0.8],
  ["F", 0.4], ["F", 0.4], ["E", 0.4], ["E", 0.4], ["D", 0.4], ["D", 0.4], ["C", 0.8],
];

function noteSamples(freq, durSec) {
  const total = Math.floor(SAMPLE_RATE * durSec);
  const out = new Float32Array(total);
  const attack = Math.floor(SAMPLE_RATE * 0.01);
  const release = Math.floor(SAMPLE_RATE * 0.04);
  for (let i = 0; i < total; i++) {
    let env = 1;
    if (i < attack) env = i / attack;
    else if (i > total - release) env = Math.max(0, (total - i) / release);
    out[i] = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * AMP * env;
  }
  return out;
}

// Build the full track.
const chunks = [];
for (const [name, dur] of melody) chunks.push(noteSamples(N[name], dur));
const totalLen = chunks.reduce((a, c) => a + c.length, 0);
const samples = new Float32Array(totalLen);
let off = 0;
for (const c of chunks) {
  samples.set(c, off);
  off += c.length;
}

// Encode as 16-bit PCM mono WAV.
const dataBytes = samples.length * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16); // fmt chunk size
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(SAMPLE_RATE, 24);
buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
buf.writeUInt16LE(2, 32); // block align
buf.writeUInt16LE(16, 34); // bits per sample
buf.write("data", 36);
buf.writeUInt32LE(dataBytes, 40);
for (let i = 0; i < samples.length; i++) {
  const s = Math.max(-1, Math.min(1, samples[i]));
  buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buf);
console.log(`Wrote ${OUT} (${(dataBytes / 1024).toFixed(0)} KB, ${(totalLen / SAMPLE_RATE).toFixed(1)}s)`);
