// The edit of the Kompass demo video: which voiceover line plays when, what is on screen meanwhile,
// where the camera looks, what the music does. Writes demo/out/timeline.json for compose.html and
// render.mjs. Everything is timed from the voiceover's word timings (demo/assets/vo/manifest.json)
// and the marks of the raw take (demo/out/take/take.json), so a new take or a re-spoken line moves
// the picture with it.
//
// The story follows the pitch book: hook (Jan's failed charge and the wrong email), problem (the
// data is there, the newsletter still goes to everyone), the target (the next right step for every
// customer), the solution (Kompass) shown in the real app, the guardrails, the proof, the close.
//
// Run: node demo/video/edit.mjs   (render.mjs runs it too)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, "..");
export const TEMPO = 1.05; // the voiceover plays this much faster than spoken (pitch kept)
export const BPM = 120;
const BEAT = 60 / BPM;
const W = 1920;
const H = 1080;
const FULL = { cx: 640, cy: 400, zoom: 1.2 };
const LEAD = 0.1; // on-screen words lead the voice by this much (compose.js uses the same)

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r2 = (x) => Math.round(x * 1000) / 1000;

export function buildTimeline() {
  const manifest = JSON.parse(readFileSync(join(DEMO, "assets/vo/manifest.json"), "utf8"));
  const script = JSON.parse(readFileSync(join(HERE, "script.json"), "utf8"));
  const take = JSON.parse(readFileSync(join(DEMO, "out/take/take.json"), "utf8"));
  const M = take.marks;
  const mark = (n) => {
    if (!M[n]) throw new Error(`the take has no mark "${n}"; record it again (npm --prefix demo run record)`);
    return M[n];
  };
  const box = (n) => mark(n).box;

  // ---------- voiceover placement ----------
  const lines = Object.fromEntries(script.lines.map((l) => [l.id, l]));
  const vo = (id) => {
    const m = manifest[id];
    if (!m) throw new Error(`no voiceover clip for "${id}"; run npm --prefix demo run vo`);
    return { dur: m.seconds / TEMPO, words: m.words.map((w) => ({ w: w.w.trim(), t: w.t / TEMPO, end: (w.end ?? w.t + 0.3) / TEMPO })) };
  };
  const placed = [];
  let T = 0;
  /** Places a line `gap` seconds after the last one; `snap` moves it so that word lands on the next beat. */
  function say(id, gap = 0.35, opt = {}) {
    const v = vo(id);
    let start = opt.at ?? T + gap;
    if (opt.snap) {
      const w = v.words.find((x) => opt.snap.test(x.w));
      if (!w) throw new Error(`"${id}" has no word matching ${opt.snap}`);
      const on = Math.ceil((start + w.t) / BEAT - 1e-6) * BEAT;
      start = on - w.t;
    }
    const p = { id, start: r2(start), end: r2(start + v.dur), words: v.words.map((x) => ({ w: x.w, t: r2(start + x.t), end: r2(start + x.end) })) };
    placed.push(p);
    T = p.end;
    return p;
  }
  /** Time of the n-th word of a placed line that matches re. */
  const at = (p, re, n = 0) => {
    const hits = p.words.filter((x) => re.test(x.w));
    if (!hits[n]) throw new Error(`"${p.id}" has no word ${n} matching ${re} (heard: ${p.words.map((x) => x.w).join(" ")})`);
    return hits[n].t;
  };

  // ---------- camera ----------
  /** The camera that frames a box of the app (app px), kept inside the app when zoomed in. */
  function frame(b, o = {}) {
    const z = o.zoom ?? clamp(Math.min(W / (b.w * (o.pad ?? 1.3)), H / (b.h * (o.pad ?? 1.3))), 1.2, 2.3);
    let x = o.cx ?? b.x + b.w / 2;
    let y = o.cy ?? b.y + b.h / 2;
    const vw = W / z;
    const vh = H / z;
    x = vw <= 1280 ? clamp(x, vw / 2, 1280 - vw / 2) : 640;
    // free: the window's bottom edge may come up, so what sits low in the app can clear the captions.
    if (!o.free) y = vh <= 800 ? clamp(y, vh / 2, 800 - vh / 2) : 400;
    return { cx: r2(x), cy: r2(y), zoom: r2(z) };
  }
  const key = (t, cam, d = 0.55, ease) => ({ t: r2(t), d, ...cam, ...(ease ? { ease } : {}) });
  const pt = (x, y) => ({ x: x - 1, y: y - 1, w: 2, h: 2 });

  // The first move of Kompass's cursor in a session started from the corner of the page (fixed in the app
  // since); the edit lets it start at the bubble like every later move.
  const G = take.ghost;
  const first = G.findIndex((g) => g.at);
  if (first >= 0) {
    const stop = G.findIndex((g, i) => i > first && g.at && (!G[i + 1]?.at || G[i + 1].t - g.t > 0.2));
    const origin = G.find((g, i) => i > stop && g.at && (!G[i + 1] || !G[i + 1].at))?.at ?? [851, 753];
    const a = G[first];
    const b = G[stop];
    const path = [];
    for (let t = a.t; t < b.t; t += 1 / 60) {
      const k = (t - a.t) / (b.t - a.t);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      path.push({ t: r2(t), at: [r2(origin[0] + (b.at[0] - origin[0]) * e), r2(origin[1] + (b.at[1] - origin[1]) * e)] });
    }
    G.splice(first, stop - first, ...path);
  }
  const ORIGIN = [851, 753]; // where the cursor parks: the bubble

  const shots = [];
  const sfx = [];
  const hits = [];
  const mood = [{ t: 0, warm: 0 }];
  const noCaption = new Set(["hook_3", "service_1", "ai_1", "guard_1", "close"]);

  // ================= 1. Hook: 17:22, Jan's charging fails. The next morning: "Switch your tariff and save!" =================
  const h1 = say("hook_1", 0.5);
  const h2 = say("hook_2", 0.4);
  const h3 = say("hook_3", 0.3);
  const subject = ["Switch", "your", "tariff", "and", "save!"].map((text, i) => ({ text, t: h2.words.filter((x) => /switch|your|tariff|and|save/i.test(x.w))[i]?.t ?? h2.end }));
  const hookOut = h3.end + 0.15;
  shots.push({
    kind: "hook",
    start: 0,
    end: r2(hookOut + 0.5),
    k: { clock: Math.min(h1.words[0].t - 0.1, 0.3), card1: at(h1, /car/) - 0.1, again: at(h1, /again/i) - 0.05, morning: h2.start - 0.15, email: at(h2, /inbox/i) - 0.1, wrong1: at(h3, /wrong/i), wrong2: at(h3, /wrong/i, 1), out: hookOut },
    subject,
    wrong: [
      { text: "Wrong", t: at(h3, /wrong/i), cls: "sun" },
      { text: "message.", t: at(h3, /message/i) },
      { text: "Wrong", t: at(h3, /wrong/i, 1), cls: "sun" },
      { text: "moment.", t: at(h3, /moment/i) },
    ],
  });
  hits.push(at(h1, /again/i), at(h3, /wrong/i), at(h3, /wrong/i, 1));
  sfx.push({ t: at(h1, /car/) - 0.12, kind: "pop" }, { t: at(h1, /again/i) - 0.08, kind: "thud" }, { t: at(h2, /inbox/i) - 0.12, kind: "pop" }, { t: hookOut - 0.1, kind: "whoosh" });

  // ================= 2. Problem: the data is there; one newsletter for all; 0,6 %; what worked? Then the target. =================
  const p1 = say("problem_1", 0.5);
  const p2 = say("problem_2", 0.4);
  const p3 = say("problem_3", 0.45);
  const nrs = [
    { text: "The", t: at(p3, /^the$/i) },
    { text: "next", t: at(p3, /next/i) },
    { text: "right", t: at(p3, /right/i), cls: "sun" },
    { text: "step.", t: at(p3, /step/i), cls: "sun" },
  ];
  shots.push({
    kind: "problem",
    start: r2(hookOut),
    end: r2(p3.end + 0.75),
    k: {
      knows: p1.words[0].t + 0.1,
      chips: [at(p1, /contracts/i), at(p1, /charging/i), at(p1, /tickets/i), at(p1, /consents/i)],
      n647: p1.words.find((x) => /647|six/i.test(x.w)).t,
      signals: at(p1, /signals/i),
      newsletter: at(p2, /newsletter/i),
      everyone: at(p2, /everyone/i),
      same: at(p2, /same/i),
      pct: p2.words.find((x) => /^0|zero/i.test(x.w)).t,
      convert: at(p2, /convert/i),
      nobody: at(p2, /nobody/i),
      what: at(p2, /what/i),
      worked: at(p2, /worked/i),
      whatif: at(p3, /what/i),
      every: at(p3, /every/i),
      step: at(p3, /step/i),
      moment: at(p3, /moment/i),
      channel: at(p3, /channel/i),
      out: r2(p3.end + 0.35),
    },
    nrs,
    underFrom: 2,
  });
  mood.push({ t: at(p3, /what/i), warm: 1, d: 2 });
  sfx.push({ t: p1.words.find((x) => /647|six/i.test(x.w)).t - 0.2, kind: "riser", d: 0.9 }, { t: at(p2, /everyone/i) - 0.1, kind: "whoosh", gain: 0.5 }, { t: at(p2, /worked/i) - 0.05, kind: "pop" });

  // ================= 3. Reveal: Meet Kompass (the drop) =================
  const rv = say("reveal", 0.55, { snap: /^k?compass/i });
  const drop1 = at(rv, /compass/i);
  hits.push(drop1);
  shots.push({
    kind: "reveal",
    start: r2(drop1 - 0.6),
    end: r2(rv.end + 0.5),
    k: { kompass: drop1, turns: at(rv, /turns/i), human: at(rv, /human/i), out: r2(rv.end + 0.1) },
    line1: [
      { text: "Every", t: at(rv, /every/i) },
      { text: "signal", t: at(rv, /signal/i) },
      { text: "→", t: at(rv, /into/i), cls: "mute" },
      { text: "the", t: at(rv, /^the$/i) },
      { text: "next", t: at(rv, /next/i), cls: "sun" },
      { text: "right", t: at(rv, /right/i), cls: "sun" },
      { text: "step.", t: at(rv, /step/i), cls: "sun" },
    ],
    line2: [
      { text: "A", t: at(rv, /^a$/i) },
      { text: "human", t: at(rv, /human/i), cls: "sun" },
      { text: "approves", t: at(rv, /approves/i) },
      { text: "every", t: at(rv, /every/i, 1) },
      { text: "message.", t: at(rv, /message/i) },
    ],
  });
  const homeStill = mark("home.start").t + 0.6;
  shots.push({
    kind: "app",
    start: r2(at(rv, /turns/i) - 0.4),
    end: r2(rv.end + 0.5),
    clips: [{ start: 0, end: 999, from: homeStill, to: homeStill }],
    cam: [key(0, { cx: 640, cy: 247, zoom: 0.97 })],
    enter: { t: r2(at(rv, /turns/i) - 0.1), d: 0.9, from: { opacity: 0, dy: 380, rotX: 26, scale: 0.9 } },
    exit: { t: r2(rv.end + 0.05), d: 0.45, to: { opacity: 0, scale: 0.92, dy: 30 } },
  });
  sfx.push({ t: at(rv, /turns/i) - 0.45, kind: "whoosh" });

  // ================= 4. Live data: the event stream comes in, then every event re-ranks the customer =================
  const da = say("data", 0.45);
  const liveIn = at(da, /every/i, 1) - 0.25;
  shots.push({
    kind: "night",
    start: r2(rv.end + 0.2),
    end: r2(liveIn + 0.5),
    k: { night: da.words[0].t + 0.1, reads: at(da, /reads/i), service: at(da, /service/i), out: r2(liveIn - 0.45) },
  });
  mood.push({ t: da.start, warm: 0.35, d: 1.5 });
  // The replay of one day: the list re-ranks as the day's events come in. Short, it only has to show "up to date".
  const liveOut = da.end + 0.25;
  const playAt = take.clicks.find((c) => c.t > 1 && c.t < 3)?.t ?? 1.9;
  const pauseAt = take.clicks.find((c) => c.t > playAt + 1)?.t ?? mark("live.end").t;
  const liveRate = Math.min(1, (pauseAt - 0.1 - (playAt - 0.35)) / (liveOut - liveIn));
  shots.push({
    kind: "app",
    start: r2(liveIn),
    end: r2(liveOut),
    clips: [{ start: r2(liveIn), end: r2(liveOut), from: r2(playAt - 0.35), to: r2(playAt - 0.35 + (liveOut - liveIn) * liveRate) }],
    cam: [key(liveIn, FULL), key(liveIn + 0.9, frame({ x: 30, y: 40, w: 700, h: 330 }, { zoom: 1.75 }), 0.9)],
    enter: { t: r2(liveIn), d: 0.6, from: { opacity: 0, scale: 1.06 } },
    human: true,
    // Inside the newest decision card, right of its text, so the Event stream header stays readable.
    chips: [
      { t0: at(da, /turn|churn/i) - LEAD, t1: liveOut, x: 1430, y: 755, text: "Churn risk", icon: "alert", color: "", anchor: "right", from: "right" },
      { t0: at(da, /offer/i) - LEAD, t1: liveOut, x: 1430, y: 810, text: "Best offer · € value", icon: "tag", color: "", anchor: "right", from: "right" },
      { t0: at(da, /time/i) - LEAD, t1: liveOut, x: 1430, y: 865, text: "Best time to reach", icon: "clock", color: "", anchor: "right", from: "right" },
    ],
  });
  sfx.push({ t: liveIn - 0.15, kind: "whoosh", gain: 0.6 });

  // ================= 5. Home: Clara's day; every draft says channel, offer, value, why =================
  const hm = say("home", 0.6);
  // "Service" lands on a beat; the home shot holds until just before the music stops for it.
  const s1 = say("service_1", 0.55, { snap: /service/i });
  const svc = at(s1, /service/i);
  const homeEnd = Math.max(hm.end + 0.45, svc - 0.55);
  const homeIn = liveOut;
  const t0 = mark("home.start").t;
  const toChannel = take.pointer.find((p) => p.t > mark("home.list").t - 0.1);
  const toEuro = take.pointer.find((p) => p.t > toChannel.t + 0.5);
  const reviewClick = take.clicks.find((c) => c.t > toEuro.t).t;
  // Clip 2 runs so the pointer reaches the channel icon on "channel" and the value on "worth".
  const chOut = at(hm, /channel/i);
  const euOut = at(hm, /worth/i);
  const chTake = toChannel.t + toChannel.ms / 1000;
  const euTake = toEuro.t + toEuro.ms / 1000;
  const rate = (euTake - chTake) / (euOut - chOut);
  const c2Start = Math.max(homeIn + 2.5, chOut - (chTake - (t0 + 0.2)) / rate);
  const c2From = chTake - (chOut - c2Start) * rate;
  const c3Start = at(hm, /^and$/i) - 0.25;
  const c2End = c3Start;
  const c3From = reviewClick - 0.1;
  const row = box("home.row");
  const review = box("home.review");
  shots.push({
    kind: "app",
    start: r2(homeIn),
    end: r2(homeEnd),
    clips: [
      { start: r2(homeIn), end: r2(c2Start), from: t0 + 0.3, to: t0 + 0.3 },
      { start: r2(c2Start), end: r2(c2End), from: r2(c2From), to: r2(c2From + (c2End - c2Start) * rate) },
      { start: r2(c3Start), end: r2(homeEnd), from: r2(c3From), to: r2(c3From + (homeEnd - c3Start) * 0.85) },
    ],
    cam: [
      key(homeIn, FULL),
      key(homeIn + 0.6, frame(box("home.kpis"), { zoom: 1.45 }), 1.4),
      key(at(hm, /every/i) - 0.3, frame(row, { zoom: 1.9, cx: row.x + 330 }), 0.7),
      key(c3Start + 0.1, frame(review, { zoom: 1.75, cy: review.y + 200 }), 0.6),
      key(at(hm, /nothing/i) - 0.2, frame({ x: 900, y: 560, w: 360, h: 160 }, { zoom: 1.6, free: true }), 0.8),
    ],
    human: true,
    callouts: [
      { t0: chOut - 0.1, t1: c3Start, box: { x: toChannel.to.x - 16, y: toChannel.to.y - 16, w: 32, h: 32 }, label: "Channel", side: "top", pad: 6 },
      { t0: at(hm, /offer/i) - 0.1, t1: c3Start, box: { x: row.x + 368, y: row.y + 10, w: 123, h: 22 }, label: "Offer", side: "top", pad: 6 },
      { t0: euOut - 0.15, t1: c3Start, box: { x: toEuro.to.x - 34, y: toEuro.to.y - 12, w: 68, h: 24 }, label: "What it's worth", side: "top", pad: 6 },
      { t0: Math.max(c3Start + 0.5, at(hm, /why/i) - 0.15), t1: at(hm, /nothing/i) + 0.05, box: review, label: "Why", side: "left", pad: 8 },
      { t0: at(hm, /nothing/i) + 0.1, t1: hm.end + 0.4, box: { x: 1155, y: 734, w: 106, h: 37 }, label: "Only Clara sends", icon: "lock", side: "top", pad: 8 },
    ],
    chips: [{ t0: hm.start + 0.1, t1: at(hm, /every/i) - 0.2, x: 120, y: 120, text: "Clara · CRM", icon: "user", color: "white", anchor: "left", from: "left" }],
  });
  sfx.push({ t: c3Start - 0.1, kind: "whoosh", gain: 0.4 });

  // ================= 6. Service before sales =================
  hits.push(svc);
  shots.push({
    kind: "title",
    start: r2(homeEnd),
    end: r2(s1.end + 0.55),
    out: r2(s1.end + 0.2),
    lines: [
      { size: 230, y: 470, words: [{ text: "Service", t: svc, slam: true }] },
      { size: 74, y: 600, words: [{ text: "comes", t: at(s1, /comes/i), cls: "sun" }, { text: "before", t: at(s1, /before/i), cls: "sun" }] },
      { size: 150, y: 790, words: [{ text: "sales.", t: at(s1, /sales/i), cls: "mute" }] },
    ],
  });
  const s2 = say("service_2", 0.5);
  const svcIn = s1.end + 0.55;
  shots.push({
    kind: "callback",
    start: r2(svcIn - 0.05),
    end: r2(at(s2, /service/i) + 0.2),
    k: { t0: svcIn - 0.05, label: at(s2, /remember/i), out: at(s2, /service/i) - 0.75 },
  });
  const deskClickAt = take.clicks.find((c) => c.t > mark("service.desk").t).t;
  const sA = at(s2, /service/i) - 0.35;
  const sB = at(s2, /first/i) + 0.35;
  const desk = box("service.desk");
  const fix = box("service.fix");
  const held = box("service.dontoffer");
  const afterScroll = mark("service.dontoffer").t + 1.0;
  // The click on Jan's call lands at the end of "first"; before it, the desk with Jan on top.
  const aRate = 1.0;
  const aFrom = deskClickAt - (sB - 0.25 - sA) * aRate;
  shots.push({
    kind: "app",
    start: r2(sA),
    end: r2(s2.end + 0.4),
    clips: [
      { start: r2(sA), end: r2(sB), from: r2(aFrom), to: r2(aFrom + (sB - sA) * aRate) },
      { start: r2(sB), end: r2(s2.end + 0.4), from: r2(afterScroll), to: r2(afterScroll + 0.4) },
    ],
    cam: [
      key(sA, frame(desk, { zoom: 1.75 })),
      key(sB, frame({ x: 425, y: 200, w: 830, h: 270 }, { zoom: 1.6 }), 0.6),
      key(at(s2, /holds/i) - 0.3, frame(held, { zoom: 1.75, cy: held.y + 30 }), 0.6),
      key(at(s2, /while/i) - 0.25, frame({ x: 60, y: 100, w: 1200, h: 380 }, { zoom: 1.4 }), 0.7),
    ],
    enter: { t: r2(sA), d: 0.45, from: { opacity: 0, scale: 0.94 } },
    human: true,
    chips: [{ t0: sA + 0.2, t1: sB - 0.1, x: 1840, y: 130, text: "Mehmet · Service", icon: "headset", color: "white", anchor: "right", from: "right" }],
    callouts: [
      { t0: at(s2, /failed/i) - 0.1, t1: sB, box: desk, label: "Failed charge, upset", icon: "bolt", side: "right", pad: 6 },
      { t0: at(s2, /fix/i) - 0.1, t1: at(s2, /holds/i) - 0.2, box: { x: fix.x, y: held.y - fix.h - 1, w: fix.w, h: fix.h }, label: "Fix first", icon: "wrench", side: "top", pad: 8 },
      { t0: at(s2, /holds/i) - 0.05, t1: at(s2, /while/i) - 0.2, box: held, label: "Every offer held back", icon: "lock", side: "top", pad: 8 },
      { t0: at(s2, /upset/i) - 0.2, t1: s2.end + 0.4, box: { x: desk.x + 110, y: desk.y + 55, w: 64, h: 21 }, label: "Upset", side: "right", pad: 5 },
    ],
  });
  sfx.push({ t: homeEnd - 0.1, kind: "whoosh", gain: 0.6 }, { t: sA - 0.1, kind: "whoosh", gain: 0.5 });

  // ================= 7. "And you can use AI to do everything." =================
  const a1 = say("ai_1", 0.65, { snap: /^a\.?i\.?$/i });
  const aiWord = at(a1, /^a\.?i\.?$/i);
  const every = at(a1, /everything/i);
  hits.push(aiWord, every);
  const morph = a1.end + 0.12;
  const fly = morph + 0.35;
  const land = fly + 0.62;
  const typing = take.clicks.find((c) => c.t > mark("ai.bubble").t - 1).t; // the click into the bubble
  const sent = mark("ai.sent").t;
  const a2 = say("ai_2", 0.0, { at: land + 0.12 });
  const camBubble = frame({ x: 820, y: 700, w: 430, h: 90 }, { zoom: 2.0 });
  const landAt = [960 + (ORIGIN[0] - camBubble.cx) * camBubble.zoom, 540 + (ORIGIN[1] - camBubble.cy) * camBubble.zoom];
  shots.push({
    kind: "ai",
    start: r2(a1.start - 0.1),
    end: r2(land + 0.1),
    size: 96,
    y: 575,
    words: [
      { text: "And", t: at(a1, /and/i) },
      { text: "you", t: at(a1, /you/i) },
      { text: "can", t: at(a1, /can/i) },
      { text: "use", t: at(a1, /use/i) },
      { text: "AI", t: aiWord, ai: true, dur: 0.5, scale: [[0, 3.1], [at(a1, /^to$/i) - 0.1, 2.1], [at(a1, /^do$/i) - 0.1, 1.55], [every - 0.1, 1.0]] },
      { text: "to", t: at(a1, /^to$/i) },
      { text: "do", t: at(a1, /^do$/i) },
      { text: "everything.", t: every, hero: true },
    ],
    k: { morph, fly, land },
    landAt: landAt.map(r2),
    landScale: r2(camBubble.zoom * 1.15),
  });
  sfx.push({ t: aiWord - 1.2, kind: "riser", d: 1.15 }, { t: morph + 0.1, kind: "pop" }, { t: fly, kind: "whoosh", gain: 0.6 });

  // The campaign, built on screen. Each clip is timed so the action lands on its words.
  const stopsIn = (t0, t1) => {
    const out = [];
    for (let i = 1; i < take.ghost.length - 1; i++) {
      const a = take.ghost[i];
      const b = take.ghost[i + 1];
      if (a.t >= t0 && a.t <= t1 && a.at && take.ghost[i - 1].at && (!b.at || b.t - a.t > 0.2)) out.push(a);
    }
    return out;
  };
  const camp = stopsIn(sent, mark("ai.done").t + 1);
  const navStop = camp[0]; // the Campaigns link in the sidebar
  const audStop = camp[1]; // the audience card
  const timingStop = camp.find((s) => s.t > audStop.t + 3) ?? camp[3];
  const reviewStop = camp.find((s) => s.at[1] < 100 && s.at[0] > 300) ?? camp[camp.length - 2];
  const aiClips = [];
  const clip = (start, end, from, to) => aiClips.push({ start: r2(start), end: r2(end), from: r2(from), to: r2(to) });
  const cTyped = at(a2, /ask/i) + 0.35; // "Just ask." while the prompt is typed
  clip(land - 0.2, cTyped, typing - 0.1, sent);
  const cNav = at(a2, /campaign/i) + 0.3; // the cursor clicks Campaigns on "opens a campaign"
  clip(cTyped, cNav, sent, navStop.t + 0.55);
  const cChat = at(a2, /audience/i) + 0.15; // camera on the chat: the steps tick
  clip(cNav, cChat, navStop.t + 0.55, audStop.t - 0.25);
  const cAud = at(a2, /finds/i) - 0.1; // picks the audience and the offer
  clip(cChat, cAud, audStop.t - 0.25, audStop.t + 2.6);
  const cTime = at(a2, /writes/i) - 0.15; // finds each customer's best time
  clip(cAud, cTime, timingStop.t - 1.2, timingStop.t + 0.7);
  const cWrite = a2.end + 0.25; // writes every message, in Du and in Sie
  clip(cTime, cWrite, timingStop.t + 1.3, reviewStop.t - 0.2);

  // ai_3: "Charts. Customer lists. Campaigns." Jump cuts, the cursor carries on across them.
  const a3 = say("ai_3", 0.3, { snap: /charts/i });
  const chartStops = stopsIn(mark("chart.sent").t, mark("chart.done").t + 1);
  const custStops = stopsIn(mark("cust.sent").t, mark("cust.done").t + 1);
  const mChart = at(a3, /charts/i) - 0.12;
  const mCust = at(a3, /customer/i) - 0.12;
  const mCamp = at(a3, /campaigns/i) - 0.12;
  const wallAt = at(a3, /works/i) - 0.3;
  clip(cWrite, mChart, reviewStop.t - 0.2, reviewStop.t - 0.2 + (mChart - cWrite) * 1.0);
  clip(mChart, mCust, chartStops[1].t - 0.45, chartStops[2].t + 0.25);
  clip(mCust, mCamp, custStops[0].t + 0.15, custStops[1].t + 0.35);
  clip(mCamp, wallAt, reviewStop.t - 0.5, reviewStop.t - 0.5 + (wallAt - mCamp));
  const chartShelves = box("proof.chart");
  shots.push({
    kind: "app",
    start: r2(morph),
    end: r2(wallAt),
    clips: aiClips,
    cam: [
      key(morph, camBubble),
      key(cTyped - 0.1, frame({ x: 0, y: 120, w: 700, h: 400 }, { zoom: 1.7 }), 0.55),
      key(cNav - 0.05, frame({ x: 820, y: 560, w: 440, h: 240 }, { zoom: 2.0 }), 0.6),
      key(cChat + 0.05, FULL, 0.65),
      key(cTime + 0.2, frame({ x: 100, y: 60, w: 1150, h: 600 }, { zoom: 1.3 }), 0.7),
      key(mChart, frame(chartShelves, { zoom: 1.55, cy: 300 }), 0.01),
      key(mCust, frame({ x: 60, y: 60, w: 1200, h: 420 }, { zoom: 1.5 }), 0.01),
      key(mCamp, FULL, 0.01),
    ],
    enter: { t: r2(morph + 0.25), d: 0.6, from: { opacity: 0, scale: 1.08 } },
    ghost: true,
    park: [{ t0: morph, t1: cTyped + 0.4, at: ORIGIN }],
    chips: [
      { t0: at(a2, /\bdu|due|doo/i) - 0.12, t1: cWrite, x: 945, y: 92, text: "Du", color: "violet", size: 30, anchor: "right" },
      { t0: at(a2, /sie|zee|^z/i, 0) - 0.12, t1: cWrite, x: 975, y: 92, text: "Sie", color: "violet", size: 30, anchor: "left" },
      { t0: mChart, t1: mCust, x: 960, y: 92, text: "Charts", icon: "chart", color: "violet", size: 30 },
      { t0: mCust, t1: mCamp, x: 960, y: 92, text: "Customer lists", icon: "users", color: "violet", size: 30 },
      { t0: mCamp, t1: wallAt, x: 960, y: 92, text: "Campaigns", icon: "megaphone", color: "violet", size: 30 },
    ],
  });
  for (const t of [cNav - 0.35, mChart, mCust, mCamp]) sfx.push({ t: t - 0.06, kind: "whoosh", gain: 0.35 });
  for (const s of camp.concat(chartStops, custStops)) sfx.push({ t: null, take: s.t, kind: "tick", gain: 0.35 });

  // Four screens at once: everything, on screen.
  const g1 = a3.end + 0.35;
  shots.push({
    kind: "wall",
    start: r2(wallAt),
    end: r2(g1 + 0.2),
    out: r2(g1 - 0.5),
    tiles: [
      { label: "Campaigns", from: audStop.t - 0.6 },
      { label: "Charts", from: chartStops[0].t - 0.2 },
      { label: "Customer lists", from: custStops[0].t - 0.4 },
      { label: "Service summaries", from: mark("service.sent").t + 0.4 },
    ],
  });
  sfx.push({ t: wallAt - 0.1, kind: "whoosh", gain: 0.7 });

  // ================= 8. Guardrails: it can't send =================
  const gd1 = say("guard_1", 0.45, { snap: /can't|cant|can’t/i });
  const cant = at(gd1, /can/i);
  hits.push(cant);
  const btn = box("approve.button");
  const btnC = [btn.x + btn.w / 2, btn.y + btn.h / 2];
  const gd2 = say("guard_2", 0.4);
  const gStart = g1;
  const guardsAt = mark("approve.guards").t;
  const scrollBack = mark("approve.button").t - 0.9;
  const clickAt = take.clicks.find((c) => c.t > mark("approve.start").t).t;
  const gA = gd2.start - 0.2;
  const clara = at(gd2, /clara/i);
  const gB = clara - 0.75;
  const gC = gB + (clickAt + 0.7 - (clickAt - 0.75));
  const panel = box("approve.panel");
  shots.push({
    kind: "app",
    start: r2(gStart),
    end: r2(gd2.end + 0.45),
    clips: [
      { start: r2(gStart), end: r2(gA), from: r2(scrollBack + 0.9), to: r2(scrollBack + 0.9) },
      { start: r2(gA), end: r2(gB), from: r2(guardsAt + 0.3), to: r2(Math.min(scrollBack, guardsAt + 0.3 + (gB - gA))) },
      { start: r2(gB), end: r2(gC), from: r2(clickAt - 0.75), to: r2(clickAt + 0.7) },
      { start: r2(gC), end: r2(gd2.end + 0.45), from: r2(clickAt + 0.7), to: r2(clickAt + 0.7 + (gd2.end + 0.45 - gC) * 0.5) },
    ],
    cam: [
      key(gStart, frame(btn, { zoom: 1.6 })),
      key(gA, frame(box("approve.guards"), { zoom: 1.75 }), 0.6),
      key(gB, frame({ x: 820, y: 320, w: 440, h: 180 }, { zoom: 1.7 }), 0.55),
      key(at(gd2, /only/i) - 0.3, frame(panel, { zoom: 1.75 }), 0.7),
    ],
    enter: { t: r2(gStart), d: 0.45, from: { opacity: 0, scale: 1.05 } },
    dims: [{ t0: gStart + 0.4, t1: gA - 0.1, amount: 0.55 }],
    ghost: true,
    ghostScript: [
      { t: r2(gStart), at: ORIGIN },
      { t: r2(cant - 0.45), at: ORIGIN },
      { t: r2(cant - 0.05), at: [btnC[0] - 40, btnC[1] + 6] },
      { t: r2(cant + 0.3), at: [btnC[0] - 120, btnC[1] + 90] },
      { t: r2(gA - 0.1), at: [btnC[0] - 120, btnC[1] + 90] },
    ],
    human: true,
    humanOn: [[gB, gd2.end + 0.45]],
    callouts: [
      // The marks hold only each rule's title line; the ring also takes the line under it (12 px below the title).
      { t0: at(gd2, /^cons/i) - 0.1, t1: gB, box: { ...box("approve.consent"), h: 32 }, label: "Consent", side: "right", pad: 5, icon: "check" },
      { t0: at(gd2, /complaints/i) - 0.2, t1: gB, box: { ...box("approve.service"), h: 32 }, label: "Open complaints", side: "right", pad: 5, icon: "check" },
      { t0: at(gd2, /limits/i) - 0.2, t1: gB, box: { ...box("approve.limits"), h: 32 }, label: "Contact limits", side: "right", pad: 5, icon: "check" },
      // After the click the panel re-lays out: "You · Approved" sits 168 px above the old button, the button itself 38 px higher.
      { t0: clara + 0.1, t1: at(gd2, /only/i) - 0.3, box: { x: btn.x, y: btn.y - 168, w: btn.w, h: 54 }, label: "Clara approves", icon: "userCheck", side: "left", pad: 6 },
      { t0: at(gd2, /only/i) - 0.1, t1: gd2.end + 0.4, box: { x: btn.x, y: btn.y - 38, w: btn.w, h: btn.h }, label: "Only then it goes out", icon: "send", side: "left", pad: 6 },
    ],
  });
  shots.push({
    kind: "title",
    start: r2(gd1.start - 0.15),
    end: r2(gd1.end + 0.6),
    out: r2(gd1.end + 0.25),
    veil: 0,
    lock: { t: cant, y: 330 },
    lines: [
      {
        size: 132,
        y: 620,
        words: [
          { text: "But", t: at(gd1, /but/i) },
          { text: "it", t: at(gd1, /^it$/i) },
          { text: "can't", t: cant, cls: "sun", shake: true },
          { text: "send.", t: at(gd1, /send/i) },
        ],
      },
    ],
  });
  mood.push({ t: gd1.start, warm: 0, d: 0.6 });
  sfx.push({ t: gStart - 0.1, kind: "whoosh", gain: 0.5 }, { t: cant - 0.04, kind: "lock" }, { t: gB - 0.1, kind: "whoosh", gain: 0.35 });

  // ================= 9. Proof: every campaign keeps a control group =================
  const pr = say("proof", 0.5);
  const pStart = gd2.end + 0.45;
  const boardAt = mark("proof.board").t;
  const cardClick = take.clicks.find((c) => c.t > boardAt).t;
  const plot = box("proof.plot");
  const insight = box("proof.insight");
  const pA = pStart + (cardClick + 0.35 - boardAt);
  shots.push({
    kind: "app",
    start: r2(pStart),
    end: r2(pr.end + 0.5),
    clips: [
      { start: r2(pStart), end: r2(pA), from: r2(boardAt), to: r2(cardClick + 0.35) },
      { start: r2(pA), end: r2(pr.end + 0.5), from: r2(mark("proof.plot").t + 0.2), to: r2(Math.min(take.seconds - 0.1, mark("proof.plot").t + 0.2 + (pr.end + 0.5 - pA))) },
    ],
    cam: [key(pStart, FULL), key(pA, frame({ x: plot.x, y: plot.y - 60, w: plot.w, h: insight.y + insight.h - plot.y + 60 }, { zoom: 1.4 }), 0.6), key(at(pr, /prove/i) - 0.3, frame(insight, { zoom: 1.6, free: true, cy: insight.y }), 0.6)],
    enter: { t: r2(pStart), d: 0.45, from: { opacity: 0, scale: 0.95 } },
    exit: { t: r2(pr.end + 0.1), d: 0.4, to: { opacity: 0, scale: 0.9 } },
    human: true,
    callouts: [
      { t0: at(pr, /control/i) - 0.1, t1: at(pr, /prove/i) - 0.3, box: plot, label: "Uplift against the control group", side: "top", pad: 8 },
      { t0: at(pr, /prove/i) - 0.05, t1: pr.end + 0.45, box: insight, label: "Proven, or flagged as not proven", icon: "check", side: "top", pad: 6 },
    ],
  });
  mood.push({ t: pr.start, warm: 0.6, d: 1.5 });
  sfx.push({ t: pStart - 0.1, kind: "whoosh", gain: 0.45 });

  // ================= 10. Close =================
  const cl = say("close", 0.7, { snap: /^k?compass/i });
  const k2 = at(cl, /compass/i);
  hits.push(k2);
  const end = cl.end + 4.2;
  shots.push({
    kind: "close",
    start: r2(pr.end + 0.45),
    end: r2(end),
    k: { kompass: k2, rows: at(cl, /live/i), footer: cl.end + 0.8 },
    rows: [
      { t: at(cl, /live/i), icon: "arrowIn", html: "Live data in." },
      { t: at(cl, /next/i), icon: "arrow", html: 'The <span class="sun">next right step</span> out.' },
      { t: at(cl, /humans/i), icon: "userCheck", html: "Humans in control." },
    ],
    footer: "Kompass · built for MAINGAU Energie · all customer data in this video is synthetic",
  });
  mood.push({ t: cl.start, warm: 1, d: 1.5 });
  sfx.push({ t: pr.end + 0.1, kind: "whoosh", gain: 0.5 });

  // ---------- captions: every line that is not already written big on screen ----------
  const captions = [];
  for (const p of placed) {
    if (noCaption.has(p.id)) continue;
    const text = lines[p.id].text;
    const chunks = text.split(/(?<=[.?!:,;]["”]?)\s+/).map((s) => s.trim()).filter(Boolean);
    // Join short pieces up to ~58 characters.
    const merged = [];
    for (const c of chunks) {
      const lastC = merged[merged.length - 1];
      if (lastC && (lastC + " " + c).length <= 58) merged[merged.length - 1] = `${lastC} ${c}`;
      else merged.push(c);
    }
    const total = merged.reduce((n, c) => n + c.split(/\s+/).length, 0);
    let done = 0;
    for (const c of merged) {
      const n = c.split(/\s+/).length;
      const a = Math.floor((done / total) * p.words.length);
      const b = Math.max(a, Math.ceil(((done + n) / total) * p.words.length) - 1);
      captions.push({ start: r2(p.words[a].t - 0.05), end: r2(p.words[Math.min(b, p.words.length - 1)].end + 0.1), text: c });
      done += n;
    }
  }
  for (let i = 0; i < captions.length - 1; i++) captions[i].end = Math.min(captions[i].end, captions[i + 1].start - 0.02);

  // ---------- music: sections follow the story; hits land on the key words ----------
  const music = {
    bpm: BPM,
    sections: [
      { kind: "tension", start: 0, end: p3.start },
      { kind: "build", start: p3.start, end: drop1 },
      { kind: "drop", start: drop1, end: drop1 + 16 * BEAT },
      { kind: "groove", start: drop1 + 16 * BEAT, end: svc - BEAT },
      { kind: "stop", start: svc - BEAT, end: svc },
      { kind: "groove", start: svc, end: aiWord - 2 * BEAT * 2 },
      { kind: "build", start: aiWord - 2 * BEAT * 2, end: aiWord },
      { kind: "drop", start: aiWord, end: cant - BEAT },
      { kind: "stop", start: cant - BEAT, end: cant },
      { kind: "groove", start: cant, end: k2 },
      { kind: "outro", start: k2, end: end },
    ].map((s) => ({ ...s, start: r2(s.start), end: r2(s.end) })),
    hits: hits.map(r2).sort((a, b) => a - b),
  };

  const timeline = {
    fps: 30,
    w: W,
    h: H,
    duration: r2(end),
    tempo: TEMPO,
    take: { base: "../out/take/seq/", frames: take.frames, fps: take.fps, ghost: take.ghost, pointer: take.pointer, clicks: take.clicks },
    mood,
    shots: shots.map(fixShot),
    captions,
    vo: placed.map((p) => ({ id: p.id, start: p.start, end: p.end, words: p.words })),
    music,
    sfx: sfx
      .map((s) => (s.t == null && s.take != null ? mapTake(shots, s) : s))
      .filter((s) => s && s.t != null && s.t >= 0)
      .map((s) => ({ ...s, t: r2(s.t) })),
  };
  return timeline;
}

/** Absolute times everywhere; a ghost script becomes the cursor path of its shot. */
function fixShot(s) {
  if (s.kind !== "app") return s;
  s.clips = s.clips.map((c) => ({ ...c, end: Math.min(c.end, s.end + 1) }));
  if (s.ghostScript) {
    // A scripted cursor (it never comes from the take): a dense path the renderer reads like the take's.
    const pts = s.ghostScript;
    s.scripted = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      for (let t = a.t; t < b.t; t += 1 / 60) {
        const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        s.scripted.push({ t: r2(t), at: [r2(a.at[0] + (b.at[0] - a.at[0]) * e), r2(a.at[1] + (b.at[1] - a.at[1]) * e)] });
      }
    }
    delete s.ghostScript;
  }
  return s;
}

/** A sound tied to a moment of the take plays when an app shot shows that moment. */
function mapTake(shots, s) {
  for (const sh of shots) {
    if (sh.kind !== "app") continue;
    for (const c of sh.clips) {
      if (c.to === c.from) continue;
      if (s.take >= c.from && s.take <= c.to) {
        const t = c.start + ((s.take - c.from) / (c.to - c.from)) * (c.end - c.start);
        if (t >= sh.start && t < sh.end) return { ...s, t };
      }
    }
  }
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const tl = buildTimeline();
  mkdirSync(join(DEMO, "out"), { recursive: true });
  writeFileSync(join(DEMO, "out/timeline.json"), JSON.stringify(tl));
  const mmss = (t) => `${Math.floor(t / 60)}:${String((t % 60).toFixed(1)).padStart(4, "0")}`;
  console.log(`timeline: ${mmss(tl.duration)} (${tl.shots.length} shots, ${tl.captions.length} captions, ${tl.sfx.length} sounds)`);
  for (const v of tl.vo) console.log(`  ${mmss(v.start)}–${mmss(v.end)}  ${v.id}`);
}
