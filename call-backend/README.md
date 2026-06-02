# Call Automation Backend (Google Voice)

A local Node service that drives a real Google Voice session via Playwright,
plays MP3s into the call through a virtual microphone, and live-transcribes the
other party. The dashboard's **Call Automation** tab connects to it over a
localhost WebSocket. You stay in control (manual answered / play / hang up).

> Compliance: This places calls that play prerecorded audio and transcribes the
> other party. Prerecorded/auto-dialed calls and call recording are regulated
> (e.g. TCPA in the US, two-party recording-consent states). Only call your own
> contacts who have consented, and follow the laws that apply to you.
>
> ToS note: Automating the Google Voice web UI is against Google's Terms of
> Service and can get the account limited or banned. Use at your own risk.

## Prerequisites

1. Node 18+.
2. Install dependencies and the Playwright browser:

   ```bash
   cd call-backend
   npm install
   npx playwright install chromium
   ```

3. Install audio tools:
   - **VB-CABLE** (virtual audio cable): https://vb-audio.com/Cable/ — install,
     then reboot. This creates `CABLE Input` / `CABLE Output` devices.
   - **mpv** (device-targeted MP3 playback): https://mpv.io/ — make sure `mpv`
     is on your PATH (or set `mpvPath` in `config.js`).

## One-time audio setup (Windows)

1. Windows Sound settings → set the browser's **microphone** to
   `CABLE Output (VB-Audio Virtual Cable)`. The simplest way: set
   `CABLE Output` as the **Default** recording device (and Default
   Communications device) while you run calls. Chromium uses the default mic,
   so the far side will hear whatever we play into `CABLE Input`.
2. Find the exact playback-device name mpv expects and confirm it matches
   `config.audioOutputDevice`:

   ```bash
   npm run devices
   ```

   Look for a line like `'wasapi/{...}' (CABLE Input (VB-Audio Virtual Cable))`.

3. Put your MP3s in `call-backend/audio/` as `greeting.mp3` and `followup.mp3`
   (or change the names in `config.js`).

## Log in to Google (one time)

```bash
npm run login
```

A Chromium window opens at Google Voice. Log in (and approve the mic prompt if
asked). The session is saved in `.gv-profile/` and reused later. Close with
Ctrl+C when done.

## Run

```bash
npm start
```

You should see it listening on `http://127.0.0.1:8787`. Now open the dashboard
(`outbound-ui`), go to the **Call Automation** tab — it should show
"Backend connected".

## Transcription

1. Put your OpenAI key in `call-backend/.env` as `OPENAI_API_KEY=...` and restart
   the backend.
2. During a call, audio is captured **automatically** from the Google Voice page
   (WebRTC remote track → backend → OpenAI). The dashboard shows **Listening**
   when the stream is active.
3. **Extension (optional fallback):** set `loadExtensionOnStart: true` in
   `config.js`, restart the backend, use **Visible** (not Hidden) mode, then
   click the puzzle-piece icon → **GV Call Audio Capture** on the Voice tab
   (badge shows **REC**). Not required for the automated call flow.

### OpenAI Realtime (GA) requirements — do not regress

The transcription socket (`stt.js`) must use the **GA** Realtime API. Getting any
of these wrong yields `beta_api_shape_disabled` and WebSocket close code `4000`,
i.e. no transcript:

- **No `OpenAI-Beta` header.** Authorization only.
- URL: `wss://api.openai.com/v1/realtime?intent=transcription`.
- Configure via `session.update` → `session.type: "transcription"` with
  `audio.input.format { type: "audio/pcm", rate: 24000 }` (24 kHz mono PCM16).
- Result events: `conversation.item.input_audio_transcription.delta` / `.completed`.
- Models: `gpt-4o-mini-transcribe` (current, supports `server_vad`) or
  `gpt-realtime-whisper` (streaming; omit `turn_detection`, commit manually).

Capture sends **remote/incoming audio only** (the local mic is tagged and skipped),
and capture/STT are torn down on hang-up.

## Typical call loop

1. Dashboard → Call Automation → **Log in to Google** (first time only).
2. Click **Dial** on a queued number.
3. When they pick up, click **They answered**, then **Play greeting** /
   **Run sequence** (greeting → delay → follow-up).
4. Watch the live transcript; click **Hang up** when done.

## Files

- `server.js` — control + audio WebSocket server (localhost only).
- `playwrightController.js` — persistent Chromium, login, dial, hang up.
- `audio.js` — MP3 playback to the VB-CABLE device (via mpv).
- `stt.js` — streams captured audio to OpenAI Realtime transcription.
- `extension/` — tabCapture extension that streams call audio to `/audio`.
- `config.js` — all settings (selectors, device names, files, key).

## Troubleshooting

- **Dial does nothing**: Google Voice changed its HTML. Update the selectors in
  `config.js` using the open window's devtools.
- **Far side can't hear the MP3**: the browser mic isn't `CABLE Output`, or the
  MP3 isn't playing to `CABLE Input`. Re-check the audio setup and `npm run devices`.
- **Re-login prompts**: Google sometimes re-challenges; just `npm run login` again.
