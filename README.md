# Kompass

Kompass is the workspace for MAINGAU's CRM and service teams. It sits on top of the team's insights service (customer profiles, dCLV decisions, segments, pains, governance) and adds what people work with every day:

- **Marketing mode:** Home with approvals, Campaigns (who and when → message → review and send), Automations, Customers, Analytics and the Live stream.
- **Service mode:** a Service desk for agents, customer search and an agent view of each customer, fed by the same event stream.
- **One assistant:** the Kompass bubble sees the current screen and works in the UI where you can watch it. It can prepare and propose. It can never send, approve or launch.

All customer data is synthetic (the challenge's mock data). Names are synthetic and labelled as such.

## Run it

You need Node 22 or newer.

```bash
cd kompass
npm run install:all
cp .env.example .env   # then fill in the values (ask the team for the LLM gateway token)
npm run dev            # web on http://localhost:5173, server on http://localhost:8787
```

The Electron desktop shell has three ways to start:
- **`npm run desktop`** starts the server, web and window together.
- **`npm run desktop:start`** builds the web app and starts the shell without Vite. If `npm run dev` is already running, it opens that UI instead of starting a second server.
- **`npm run desktop:remote`** opens the team server.

**On the team server:** http://130.83.85.181:44080/kompass/ and https://130.83.85.181:44443. To deploy, run `bash deploy/deploy.sh`; [deploy/README.md](deploy/README.md) explains the setup.

The server finds the insights service at `INSIGHTS_URL`. Without it, it tries `http://130.83.85.181:44080/svc`, then `http://localhost:8100`. Without the LLM settings everything works except the assistant's free-text answers.

## What is where

| Folder | What it holds |
|---|---|
| `server/` | Hono server: the workspace (campaigns, automations, approvals, templates, settings), the decision engine on top of the insights service, the event-stream replay (`live.ts`), the assistant agent (`agent.ts`) and analytics (`analytics.ts`) |
| `web/` | React + Vite + Tailwind app |
| `shared/` | Types and the catalogue of UI actions the assistant may use |
| `desktop/` | Electron shell |
| `deploy/`, `Dockerfile` | The deploy to the team's workshop server: a container behind the dashboard's nginx and an HTTPS proxy |
| `demo/` | The demo video: the recorder, the edit and renderer (`demo/video/`), the voiceover and music assets, the script (`SCRIPT.md`) |
| `docs/` | Personas, notes for the data team, UX flows |
| `api/openapi.yaml` | The server's API |
| `event_stream_2026-10-01.jsonl` | The challenge's event stream (1–3 Oct), replayed on the Live page and in the Service desk |

## Demo video

`demo/out/kompass-demo.mp4` is the demo video: 2:17, 1080p, with voiceover, music and captions. `demo/SCRIPT.md` has the story, the storyboard, the voiceover script and how each part is made.

It is built from parts that are kept, so a new render takes about three minutes:

```bash
npm run demo:video
```

For a 4K screen, `npm run demo:video:4k` writes `demo/out/kompass-demo-4k.mp4` (3840×2160, local only).

That command times the edit from the voiceover (`demo/assets/vo/`, generated locally with Qwen3-TTS) and from a raw take of the app. It then draws every frame in headless Chrome (`demo/video/compose.html`), mixes the voice with a synthesized beat, and encodes the MP4 with ffmpeg. The raw take is about 800 MB and stays local. Record it again with the app running (`npm run dev`), Google Chrome and ffmpeg installed:

```bash
npm run demo:record
```

The recorder (`demo/record.mjs`) resets the workspace and drives the app in headless Chrome. It opens the app with `?demo=1`. In that mode the assistant plays fixed scripts for the requests in the video (`server/src/demo.ts`) instead of waiting 20–60 s for the language model. The scripts make the same tool calls the model would, and those run for real; only the model's choices are fixed. Any other request still goes to the model. Open `http://localhost:5173/?demo=1` to use the fast assistant in a live demo.

## Things worth knowing

- **Event stream replay.** The Live page plays the stream from the end of the snapshot (30.09 23:59) to 03.10 20:00 and decides again for each customer an event touches: consent changes, complaints, failed charging, cart abandons and so on. Each decision shows its reason and the € effect. Duplicates, late and out-of-order events are handled by `ingested_at`.
- **Human approval.** Every message the system or the assistant drafts waits in Approvals on Home. Sending checks consent again at the moment of sending.
- **Reset before a demo.** Settings → Workspace → Reset, or `POST /api/workspace/reset`. `POST /api/live/reset` only rewinds the replay.
- **Logs.** Everything writes JSON lines to `server/logs/kompass.log` (`GET /api/logs` shows the latest). Check it first when something misbehaves.
