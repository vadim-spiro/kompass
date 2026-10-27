# Kompass demo video: script, storyboard, how it is made

The jury's brief: a demo of at most 2–3 minutes that shows **what data, model and logic** are behind the product, judged on idea, execution, relevance and pitch. The video runs **2:15**.

## The story

The structure follows the pitch book (Kajdas, *Überzeugende Start-up-Pitches*):

- **Three acts.** Setup, then confrontation, then resolution.
- **The problem as a short story:** a starting situation, an obstacle, then the target situation.
- **The solution is the climax.** We show what changes for the people at MAINGAU (benefits), and the features only as the way there.
- **The problem and solution in one sentence:**
  > MAINGAU knows its customers, but the newsletter still goes to everyone; Kompass turns every customer signal into the next right step, and a human approves every message.

| Act | What the viewer learns | Lines |
|---|---|---|
| Setup | One customer, Jan. His charging fails, and the next morning he gets an upsell email. | hook_1–3 |
| Confrontation | MAINGAU has the data (647 signals a day), yet one newsletter goes to everyone, 0.6 % convert and nobody can prove what worked. Then the target: the next right step for every customer, at the right moment, on a channel they agreed to. | problem_1–3 |
| Resolution | Kompass: the live event stream, Clara's approvals, service before sales (Jan again), the AI that does the work on screen, the guardrails, the proof by control group. | reveal … close |

### Rules for attention

From the pitch book and a short research pass on product videos:

- **Something changes on screen every 3–5 seconds,** and every 2–3 seconds in the hook. No dead time, and no footage that looks sped up.
- **Words in big type appear about 0.1 s before they are spoken** (`LEAD` in `compose.js`), so the eye is there when the ear gets it.
- **Big type shows keywords, never whole sentences.** Captions carry the full line at the bottom for anyone watching muted, and are left out where the line is already on screen in big type.
- **The camera zooms to what the voice talks about,** at 1.5–2.3×. Each zoom holds at least 1.5 s, usually 2.5–4 s. Every callout ring names the thing in two or three words.
- **One idea per shot.** The montage of jump cuts ("Charts. Customer lists. Campaigns.") is the one place where the pace is deliberately high.
- **Callbacks.** Jan from the hook comes back in the service part ("Remember Jan?"). The close repeats the three promises: live data in, the next right step out, humans in control.
- **Colours:** navy, white, sun yellow (#ffe500) for what matters, violet (#6d43d1) for Kompass's AI. No red.
- **Two cursors.** The violet one with the "Kompass" pill is the AI acting on screen. The black one is the person (Clara or Mehmet).

## Storyboard

Times are from the current edit; `node demo/video/edit.mjs` prints them again.

| Time | Voice | On screen | Device |
|---|---|---|---|
| 0:00 | hook_1 | "Thursday 17:22", then two "Charging failed" notifications; the second one shakes. | A moment everyone knows |
| 0:06 | hook_2 | "Next morning 08:00", and a MAINGAU newsletter. Its subject, "Switch your tariff and save!", gets highlighted word by word. | Contrast |
| 0:12 | hook_3 | Yellow strikes through the email and the time. "**Wrong** message. **Wrong** moment." | The obstacle, in four words |
| 0:16 | problem_1 | One customer, then four chips flying in (Contracts, Charging, Tickets, Consents). A counter runs to 647 while particles stream in. | The data exists |
| 0:26 | problem_2 | A grid of 70 people all get the same envelope. "Same text. Everyone." Then "0.6 %", "What worked?" and "No control group. No proof." | The pain, as numbers |
| 0:35 | problem_3 | Each person gets their own badge (offer, fix, info, wait), a time and a channel tick. "The next **right step.**" The background warms up and the music builds. | The target situation |
| 0:43 | reveal | On the beat drop: a flash, the Kompass mark and wordmark. The logo lifts, the app rises into view, then "Every signal → the next right step." and "A human approves". | The climax |
| 0:51 | data | "Live, every event as it happens": events flow from the insights service into Kompass ("Re-evaluated as events happen"). Then a short replay of one day: the list re-ranks as events come in. Chips: Churn risk, Best offer · € value, Best time to reach. | What data and model |
| 1:02 | home | Home: the day's numbers, then one draft with rings on Channel, Offer and "What it's worth". The review sheet with "Why", then "Only Clara sends" on the Approve button. | Logic and a reason for every decision |
| 1:14 | service_1 | Title slam: "**Service** comes before sales." The music stops for one beat. | Rule of the product |
| 1:17 | service_2 | "Remember Jan?" Then the service desk: Jan's failed charge, "Fix first" on top, "Every offer held back", "Upset". | Callback |
| 1:27 | ai_1 | "And you can use **AI** to do **everything**." AI arrives big with the bubble's gradient and glow and shrinks as the words come in. "Everything" punches in yellow with a shine, an underline and a burst. AI turns into Kompass's cursor and flies into the app. | The second drop |
| 1:31 | ai_2 | "Just ask." The prompt is typed. The cursor clicks Campaigns in the sidebar, the camera moves to the chat where the steps tick off, then zooms out while Kompass picks the audience, the offer and the timing and writes the message (Du / Sie). | Watch the AI work |
| 1:42 | ai_3 | Jump cuts on the beat: Charts, Customer lists, Campaigns, with the cursor carried across the cuts. Then four screens at once. | High pace |
| 1:48 | guard_1 | Kompass's cursor reaches for the send button, a yellow lock slams down: "But it **can't** send." | Trust |
| 1:50 | guard_2 | Guardrails: Consent, Open complaints, Contact limits. Clara clicks Request approval; "Only then it goes out". | Zero violations, shown |
| 2:01 | proof | Analytics: uplift against the control group per channel. "Proven, or flagged as not proven". | Proof, not claims |
| 2:07 | close | Kompass. "Live data in. The **next right step** out. Humans in control." Footer: synthetic data. | The promise, repeated |

## Voiceover

The source of truth is `demo/video/script.json`: `text` is what the line says (captions and this file), and `say` is how the speech model has to read it (Jan → Yan, AI → A.I., numbers as words).

| Line | Text |
|---|---|
| hook_1 | 17:22. Jan's car won't charge. Again. |
| hook_2 | The next morning, his inbox lights up: "Switch your tariff and save!" |
| hook_3 | Wrong message. Wrong moment. |
| problem_1 | MAINGAU knows a lot about its customers: contracts, charging, tickets, consents. 647 signals on a single day. |
| problem_2 | But the newsletter still goes to everyone, with the same text. 0.6 % convert, and nobody can say what worked. |
| problem_3 | What if every customer got the next right step? At the right moment, on a channel they said yes to. |
| reveal | Meet Kompass. It turns every customer signal into the next right step, and a human approves every message. |
| data | Kompass reads every event from our insights service the moment it happens. Every event re-ranks that customer: churn risk, the best offer and what it's worth, and the best time to reach them. |
| home | Clara from CRM starts her day here. Every draft shows its channel, its offer, what it's worth, and why. Nothing goes out without her. |
| service_1 | Service comes before sales. |
| service_2 | Remember Jan? In service mode, Mehmet sees the failed charge first. Kompass puts the fix on top, and holds back every offer while Jan is upset. |
| ai_1 | And you can use AI to do everything. |
| ai_2 | Just ask. Kompass opens a campaign, picks the audience and the offer, finds each customer's best time, and writes every message, in Du and in Sie. |
| ai_3 | Charts. Customer lists. Campaigns. It works right on screen, where you can watch it. |
| guard_1 | But it can't send. |
| guard_2 | Consent, open complaints and contact limits are checked for every single customer. Clara approves, and only then does anything go out. |
| proof | Every campaign keeps a control group, so you can prove what worked. |
| close | Kompass. Live data in. The next right step out. Humans in control. |

## What is real in the video

- **The app.** Every app shot is the running Kompass app on the challenge's synthetic data, recorded in one take. Customer names are synthetic.
- **The assistant.** It runs in demo mode (`?demo=1`, `server/src/demo.ts`). The model's choices are fixed so the video does not wait 20–60 s for the language model, but the tool calls and screen actions run for real.
- **Kompass's cursor.** The app draws it while it acts. The recording hides it and logs its path, and the edit draws it again, so it stays sharp when the camera zooms. One move is scripted: reaching for the send button in "But it can't send."
- **"Live"** stands for the event stream from the insights service; the replay shows one day of events.
- **The voice** is generated locally with Qwen3-TTS. The **music** is synthesized from scratch by `music.py` (no samples, so there is nothing to license). The sound effects are synthesized in `mix.mjs`.

## How it is made

Everything lives in `demo/`. A full render takes about three minutes on a laptop and reuses all the slow parts.

| Step | Command (from `kompass/`) | Input | Output | Kept? |
|---|---|---|---|---|
| 1. Voice | `"$HOME/Library/Application Support/claude-maxxing-voice/tts-env/bin/python" -I demo/video/tts.py` | `video/script.json` | `assets/vo/*.wav` and `manifest.json` (word timings) | Committed. Only changed lines are spoken again. |
| 2. Take | `npm --prefix demo run record` (app running, `npm run dev`) | the app | `out/take/` (frames at 2560×1600 plus `take.json` with marks and cursor paths) | Local only, about 800 MB. Re-record in about 2.5 min. |
| 3. Edit | `node demo/video/edit.mjs` | the voice timings, the take marks | `out/timeline.json` | Made on every render |
| 4. Picture | `npm --prefix demo run render` | timeline, take, `video/compose.html` + `compose.js` | `out/frames/` | Local only |
| 5. Sound | (part of step 4) `video/mix.mjs` | voice, beat, effects | `out/mix/kompass-mix.wav` | The beat is kept in `assets/music/beat.m4a` and made again only when the edit changes the arrangement |
| 6. File | (part of step 4) | frames and mix | `out/kompass-demo.mp4`, H.264 1080p30 with AAC, under 50 MB | Committed |

- **Check a look quickly:** `node demo/video/render.mjs --stills=12,47.5,90` writes single frames and contact sheets to `out/stills/` in seconds.
- **Render a part:** `--from=40 --to=60` writes `out/part.mp4`. `--fps=10` gives a quick preview.
- **4K for a big screen:** `npm run demo:video:4k` (`render.mjs --scale=2`) writes `out/kompass-demo-4k.mp4`, 3840×2160. Chrome draws every frame at twice the pixels, so titles, captions and rings are sharp. The app recording is 2560×1600, so close-ups of the app are upscaled a little. It takes a few times longer than the 1080p render, and the file stays local (too big for git).
- **Change a line:** edit `script.json`, run step 1, then render. The edit is timed from the voice's word timings, so everything on screen moves with the new words.
- **Change the cut:** `edit.mjs` holds one block per part of the story. Shots, camera keys, callouts and chips are timed from spoken words (`at(line, /word/)`) and from marks in the take (`mark("home.row")`).
- **New take:** the edit is timed from the take's marks, so a new recording drops in. `record.mjs` logs the boxes of the elements the callouts point at.

### Sound

- **Loudness.** The mix is set to −16 LUFS with a true peak of −1.5 dBTP, using two loudnorm passes.
- **Voice.** At 1.05× tempo, high-passed at 90 Hz, −2 dB at 250 Hz, +2.5 dB at 3.5 kHz, with light compression.
- **Beat.** 120 BPM. Key words fall on beats ("Kompass", "Service", "AI", "can't"). The arrangement follows the story:
  - tension under the problem
  - a build into the reveal, then a drop
  - groove under the explanations, with a one-beat stop before "Service"
  - a build and drop for the AI part, and a stop before "can't"
  - an outro
- **Ducking.** In the gaps the beat sits about 5 dB under the voice's loudness. Under speech it dips another 11 dB (fast attack, 0.5 s release), and dips less on the hits.
