// Lists the audio output devices mpv can see, so you can copy the exact name for
// config.audioOutputDevice (look for "CABLE Input (VB-Audio Virtual Cable)").

import { listMpvDevices } from "./audio.js";

const { ok, raw, error } = listMpvDevices();
if (!ok) {
  console.error("Could not run mpv. Install mpv and ensure it's on PATH.");
  if (error) console.error(error);
  process.exit(1);
}
console.log(raw);
