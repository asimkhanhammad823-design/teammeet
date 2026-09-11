# TeamMeet

**Live links for this install**

| | Link | Notes |
|---|---|---|
| ☁️ Cloud (always on, PC can be off) | `https://teammeet-g0vt.onrender.com/r/<room>` | Render free tier; first visit after 15 min idle takes ~30–50 s |
| 💻 From this PC | `https://brick-ragged-moneybags.ngrok-free.dev/r/<room>` | ngrok permanent domain; server auto-starts at Windows logon |
| 🏠 Same Wi‑Fi | `https://192.168.100.16:3443/r/<room>` | No internet needed; accept the certificate warning once |

Cloud redeploy after code changes: push to GitHub, then Render dashboard → **Manual Deploy → Deploy latest commit** (the repo is connected as a public URL, so it does not auto-deploy).

Free, self-hosted team video meetings — **unlimited length**, **full-meeting recording**, **live speaker-labelled transcript**. Zero running cost: audio/video goes peer-to-peer, recording is saved on your own disk, transcription uses the browser's built-in engine.

## Features

| | |
|---|---|
| 🎥 HD video + Opus audio | 720p/30fps camera, echo cancellation, noise suppression |
| 🖥️ Screen sharing | Spotlight layout for everyone (and in the recording) |
| ⏺️ Recording | Composite of all participants + mixed audio, streamed **directly to disk** – 3 hours+ is fine |
| 📝 Live transcript | Every participant is transcribed with their name; export **TXT / SRT / JSON** |
| 💬 Chat, ✋ raise hand, 👥 people list | Speaking indicator, unread badges |
| 🔗 Invite links | `https://your-host/r/room-code` |
| 💸 Cost | **0** — no media server, no paid APIs |

Best experience: **Chrome or Edge** on desktop (needed for recording-to-disk and speech recognition). Firefox/Safari can join and see others' captions, but cannot transcribe or record.

---

## 1. Run it (Windows)

```bash
npm install
```

```bash
npm start
```

Open <http://localhost:3000>. (Or just double-click `start.bat`.)

`localhost` counts as secure, so camera/mic work immediately for you. **Other people need an HTTPS link.**

## 2. The invite link (shown in the lobby)

The lobby has an **Invite link** box with **Copy** and **WhatsApp** buttons. Once a public link exists it shows there automatically; the **Copy link** button inside the meeting uses the same address.

### Option 0 — permanent link with ngrok (configured for this install)

`config.json` holds `NGROK_DOMAIN` (a free reserved ngrok domain). The server starts `ngrok http 3000 --domain …` itself, so the invite address is **always the same**, across restarts and network drops. One-time setup on a new PC: `winget install Ngrok.Ngrok`, then `ngrok update`, then `ngrok config add-authtoken <token>` from <https://dashboard.ngrok.com/get-started/your-authtoken>. Visitors see ngrok's "You are about to visit…" page once — click **Visit Site**.

### Option A — automatic internet link (fallback, no account)

`npm start` tries free tunnel providers **in order** until one gives an HTTPS address, and reconnects automatically if it drops:

1. **Cloudflare quick tunnel** (`cloudflared`, HTTP/2 mode) — `winget install Cloudflare.cloudflared`
2. **localhost.run** via the built-in Windows `ssh` client
3. **serveo.net** via `ssh`

The invite box shows *getting public link… (provider)* → **public link ready via …** within ~10–30 s. The hostname changes every time the server restarts, so start the server, copy the link, send it. If every provider is blocked by your network the box says **internet link unavailable — retrying**; the server keeps trying in the background. `TUNNEL=0` disables all of this.

### Option B — same Wi‑Fi link (no internet needed)

The server also listens on **HTTPS port 3443** with a self-signed certificate (created once in `.cert/`). The lobby shows the *Same Wi‑Fi* link, e.g. `https://192.168.1.20:3443/r/room`. Teammates on the same network open it and accept the browser's certificate warning once (**Advanced → Proceed**). Ideal for offices; audio/video stays on the LAN. `NO_HTTPS=1` disables it, `HTTPS_PORT` changes the port.

### Option C — Render.com free web service (permanent link, PC can be off)

Recommended for a fixed link you send once and keep using.

1. Push this folder to a GitHub repo.
2. On Render: **New → Web Service**, connect the repo. `render.yaml` is picked up automatically (build `npm install`, start `npm start`).
3. You get `https://teammeet-xxxx.onrender.com` — the invite box picks it up automatically (`RENDER_EXTERNAL_URL`).

Free instances sleep after 15 minutes idle; the first visit takes ~30 s to wake. The server only relays signaling, so the free tier is more than enough.

### Option D — Any VPS / Docker

```bash
docker build -t teammeet . && docker run -p 3000:3000 teammeet
```

Put it behind Caddy/Nginx with Let's Encrypt for HTTPS.

## 3. Using it

1. Enter your name, pick a room code (or generate one), choose transcript language and recording quality → **Join**.
2. Click **Copy link** and send it to the team.
3. **⏺ Record** — Chrome asks where to save the `.webm`; it's then written continuously, so even a 3-hour meeting only uses disk space, not RAM. Keep the window open (don't minimise) while recording.
4. **CC** — turns on live transcription of *your* microphone. Everyone who turns on CC is added to the shared transcript with their name. Open the **Transcript** panel to export TXT/SRT/JSON. When you stop a recording, the TXT is downloaded automatically.

Keyboard: `M` mic · `V` camera · `S` screen · `R` record · `C` captions · `H` hand.

## Recording sizes

| Quality | Bitrate | 1 hour | 3 hours |
|---|---|---|---|
| 540p | 1.4 Mbps | ~0.6 GB | ~1.9 GB |
| 720p (default) | 2.5 Mbps | ~1.1 GB | ~3.4 GB |
| 1080p | 4.5 Mbps | ~2 GB | ~6 GB |

The `.webm` plays in VLC, Chrome, Windows Media Player (Win11) and uploads directly to YouTube/Drive. If a player can't seek (MediaRecorder doesn't write a duration header), remux once with ffmpeg — no quality loss, takes seconds:

```bash
ffmpeg -i meeting.webm -c copy meeting-fixed.mp4
```

## Limits & honest notes

- **Mesh topology**: every participant sends video to every other participant, so quality adapts automatically to room size — up to 4 people: 720p · 5–8: 480p · 9–12: 360p · 13–20: 240p/15 fps (≈4–5 Mbps total upload). Screen share stays full resolution. Up to 20 people per room (`MAX_PEERS`); on weak connections have some people turn video off.
- **Transcript quality** depends on the browser engine (Google in Chrome, Microsoft in Edge). Urdu (`ur-PK`), Hindi, English and 100+ other languages are supported. Each person transcribes their own mic, so someone on Firefox/phone Safari won't appear in the transcript.
- **TURN**: when two people are both behind strict NATs, traffic relays through a TURN server. The free Open Relay project is preconfigured; for guaranteed reliability set your own with `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.
- **Privacy**: media is end-to-end between browsers (DTLS-SRTP). The server sees names, chat and captions only while relaying them and stores nothing.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `MAX_PEERS` | `20` | Max participants per room |
| `PUBLIC_URL` | auto | Public HTTPS address shown in the invite box (auto from the tunnel or Render) |
| `TUNNEL` | `1` | Set `0` to disable the automatic internet tunnel |
| `HTTPS_PORT` | `3443` | Port of the same-Wi‑Fi HTTPS listener |
| `NO_HTTPS` | — | Set `1` to disable the LAN HTTPS listener |
| `TURN_URLS` | Open Relay | Comma-separated `turn:`/`turns:` URLs |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | — | TURN credentials |

## Project layout

```
server.js             signaling server (Express + Socket.IO)
public/index.html     lobby + meeting UI
public/css/style.css
public/js/app.js      app logic, UI, chat, controls
public/js/rtc.js      WebRTC mesh (perfect negotiation)
public/js/recorder.js canvas compositor + MediaRecorder + direct-to-disk writer
public/js/transcript.js speech recognition + transcript log/exports
```

MIT licence.
