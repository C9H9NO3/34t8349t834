// MP3 playback into a specific output device (the VB-CABLE virtual mic feed).
//
// Uses mpv for device-targeted playback (`--audio-device`). If mpv or the device
// can't be found, it falls back to the OS default output device, in which case
// you should set "CABLE Input" as your default playback device while calling.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { config } from "./config.js";

let cachedDeviceId = null;
let resolved = false;
let current = null; // currently playing child process

export function listMpvDevices() {
  const res = spawnSync(config.mpvPath || "mpv", ["--audio-device=help"], {
    encoding: "utf8",
  });
  if (res.error) return { ok: false, error: res.error.message, raw: "" };
  return { ok: true, raw: (res.stdout || "") + (res.stderr || "") };
}

// Resolve the mpv audio-device id whose description matches config.audioOutputDevice.
function resolveDevice() {
  if (resolved) return cachedDeviceId;
  resolved = true;
  const wanted = (config.audioOutputDevice || "").toLowerCase();
  if (!wanted) return (cachedDeviceId = null);

  const { ok, raw } = listMpvDevices();
  if (!ok) return (cachedDeviceId = null);

  // Lines look like:  'wasapi/{guid}' (CABLE Input (VB-Audio Virtual Cable))
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/'([^']+)'\s*\((.*)\)\s*$/);
    if (!m) continue;
    const id = m[1];
    const desc = m[2].toLowerCase();
    if (desc.includes(wanted) || wanted.includes(desc)) {
      cachedDeviceId = id;
      break;
    }
  }
  return cachedDeviceId;
}

export function isPlaying() {
  return current !== null;
}

export function stop() {
  if (current) {
    try {
      current.kill();
    } catch {
      /* ignore */
    }
    current = null;
  }
}

// Plays a single file to the target device. Resolves when playback finishes.
export function playFile(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      reject(new Error(`audio file not found: ${filePath}`));
      return;
    }
    stop();

    const args = ["--no-video", "--no-terminal", "--really-quiet"];
    const deviceId = resolveDevice();
    if (deviceId) args.push(`--audio-device=${deviceId}`);
    args.push(filePath);

    let child;
    try {
      child = spawn(config.mpvPath || "mpv", args, { stdio: "ignore" });
    } catch (err) {
      reject(new Error(`failed to launch mpv: ${err.message}`));
      return;
    }
    current = child;

    child.on("error", (err) => {
      current = null;
      reject(new Error(`mpv error: ${err.message}`));
    });
    child.on("exit", (code) => {
      current = null;
      // code may be null when killed by stop(); treat as resolved.
      resolve({ code });
    });
  });
}

export function deviceStatus() {
  return {
    requested: config.audioOutputDevice,
    resolvedId: resolveDevice(),
    mpvAvailable: listMpvDevices().ok,
  };
}
