// Records the raw take of the Kompass demo: the app on screen, nothing else.
//
// It drives the running app in headless Chrome. The app renders at 1280 × 800, scaled 2× into a
// 2560 × 1600 page, so the edit can zoom in up to 2× and stay sharp. Frames come over the DevTools
// screencast. The take holds no captions and no cursor: the edit (video/render.mjs) adds the camera,
// the type, both cursors and the sound. For that, the take also logs where things are:
// - marks: named moments, with the box of an element in app pixels;
// - the human pointer's moves and clicks;
// - the path of Kompass's own cursor, which is hidden in the frames and drawn again by the edit.
//
// The app is opened with ?demo=1, so the assistant plays the fixed scripts in server/src/demo.ts instead
// of waiting for the language model. Everything else is the real app on the real data. Waits for data
// are cut, so they never reach the take.
//
// Needs: the app running (npm run dev), Google Chrome and ffmpeg.
// Run from the kompass folder: npm --prefix demo run record
// Options: --no-reset        keep the workspace as it is (by default it is reset first)
//          --only=a,b        record only these scenes (a test take in out/take-test)
// Output:  demo/out/take/take.json and demo/out/take/seq/%06d.jpg (30 fps)
import { spawnSync } from "node:child_process";
import { copyFileSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const SCALE = 2;
const APP_W = 1280;
const APP_H = 800;
const WEB = (process.env.KOMPASS_WEB ?? "http://localhost:5173").replace(/\/$/, "");
const API = `${WEB}/api`;
const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith("--only="))?.slice(7).split(",");
const TAKE = join(HERE, "out", only ? "take-test" : "take");
const RAW = join(TAKE, "raw");
const SEQ = join(TAKE, "seq");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[take ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function api(path, init) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// ---------- Frame capture ----------

/** Collects screencast frames with their times. While cut, frames are dropped and the clock stands still. */
class Recorder {
  frames = [];
  cuts = [];
  constructor(cdp) {
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (f) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
      if (this.cutFrom != null || this.t0 == null) return;
      const file = join(RAW, `${String(this.frames.length).padStart(6, "0")}.jpg`);
      writeFileSync(file, Buffer.from(f.data, "base64"));
      this.frames.push({ file, t: this.video(f.metadata.timestamp) });
    });
  }
  async start() {
    rmSync(TAKE, { recursive: true, force: true, maxRetries: 5 });
    mkdirSync(RAW, { recursive: true });
    this.t0 = Date.now() / 1000;
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, everyNthFrame: 1 });
  }
  /** Seconds of take at a wall-clock time (seconds since the epoch): the time spent in cuts does not count. */
  video(epoch) {
    let t = epoch - this.t0;
    for (const c of this.cuts) if (epoch > c.from) t -= Math.min(epoch, c.to) - c.from;
    if (this.cutFrom != null && epoch > this.cutFrom) t -= epoch - this.cutFrom;
    return Math.max(0, t);
  }
  now() {
    return this.video(Date.now() / 1000);
  }
  /** Runs fn off camera: a wait for data never makes it into the take. */
  async cut(fn) {
    this.cutFrom = Date.now() / 1000;
    try {
      return await fn();
    } finally {
      this.cuts.push({ from: this.cutFrom, to: Date.now() / 1000 });
      this.cutFrom = null;
    }
  }
  async stop() {
    this.end = this.now();
    await this.cdp.send("Page.stopScreencast").catch(() => {});
  }
  /** Lays the frames out at a constant 30 fps (each video frame is the latest capture at its time), as hard links. */
  resample() {
    rmSync(SEQ, { recursive: true, force: true, maxRetries: 5 });
    mkdirSync(SEQ, { recursive: true });
    const total = Math.max(1, Math.round(this.end * FPS));
    for (let k = 0, j = 0; k < total; k++) {
      while (j + 1 < this.frames.length && this.frames[j + 1].t <= k / FPS) j++;
      const to = join(SEQ, `${String(k).padStart(6, "0")}.jpg`);
      try {
        linkSync(this.frames[j].file, to);
      } catch {
        copyFileSync(this.frames[j].file, to);
      }
    }
    rmSync(RAW, { recursive: true, force: true, maxRetries: 5 });
    return total;
  }
}

// ---------- What the take logs ----------

const take = { fps: FPS, scale: SCALE, app: { w: APP_W, h: APP_H }, scenes: [], marks: {}, pointer: [], clicks: [], ghost: [] };
let page, frame, app, rec;
let ptr = { x: APP_W * 0.6, y: APP_H * 0.45 };

/** The box of an element in app pixels. */
async function boxOf(locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
}

/** A named moment, with the box of an element (or of its nearest card) when given. */
async function mark(name, locator, opts = {}) {
  const m = { t: Math.round(rec.now() * 1000) / 1000 };
  if (locator) {
    m.box = opts.card ? await locator.evaluate((el) => {
      const c = el.closest("section, article, li, [role=dialog], .rounded-xl, .rounded-2xl, .rounded-lg") ?? el;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }) : await boxOf(locator);
  }
  take.marks[name] = m;
  return m;
}

/** Moves the pointer to the middle of an element: the real mouse for hover states, and a logged path for the edit. */
async function point(locator, ms = 600) {
  await locator.scrollIntoViewIfNeeded({ timeout: 15_000 }).catch(() => {});
  const b = await boxOf(locator);
  const to = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  take.pointer.push({ t: rec.now(), ms, from: ptr, to });
  const steps = Math.max(2, Math.round(ms / 25));
  await page.mouse.move(to.x * SCALE, to.y * SCALE, { steps });
  ptr = to;
  await sleep(ms);
  return to;
}

async function leaveRail() {
  const to = { x: APP_W * 0.58, y: APP_H * 0.32 };
  take.pointer.push({ t: rec.now(), ms: 420, from: ptr, to });
  await page.mouse.move(to.x * SCALE, to.y * SCALE, { steps: 8 });
  ptr = to;
  await sleep(450);
}

async function click(locator, opts = {}) {
  await locator.waitFor({ state: "visible", timeout: opts.timeout ?? 20_000 });
  const at = await point(locator, opts.ms);
  take.clicks.push({ t: rec.now(), ...at });
  await locator.click({ timeout: 10_000 });
  await sleep(opts.after ?? 350);
}

async function typeInto(locator, text, delay = 24) {
  await click(locator);
  await locator.pressSequentially(text, { delay });
  await sleep(200);
}

async function scrollTo(locator) {
  await locator.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await sleep(900);
}

/** Hides Kompass's cursor in the frames and logs its path; the edit draws it again. */
async function watchGhost() {
  await frame.evaluate(() => {
    if (window.__ghost) return;
    const st = document.createElement("style");
    st.textContent = '[data-ghost="cursor"]{opacity:0!important}';
    document.head.appendChild(st);
    window.__ghost = [];
    let last = "";
    const loop = () => {
      const el = document.querySelector('[data-ghost="cursor"]');
      let at = null;
      if (el) {
        const r = el.getBoundingClientRect();
        at = [Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10];
      }
      const k = at ? at.join(",") : "-";
      if (k !== last) {
        window.__ghost.push([Date.now() / 1000, at]);
        last = k;
      }
      requestAnimationFrame(loop);
    };
    loop();
  });
}
async function collectGhost() {
  const got = await frame.evaluate(() => window.__ghost?.splice(0) ?? []).catch(() => []);
  for (const [epoch, at] of got) take.ghost.push({ t: Math.round(rec.video(epoch) * 1000) / 1000, at });
}

async function untilClock(at, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await api("/live")).clock >= at) return;
    await sleep(120);
  }
  throw new Error(`the replay did not reach ${at}`);
}
/** Waits until the assistant's turn is over (the Stop button is gone). */
async function assistantDone(timeoutMs = 120_000) {
  await app.locator('button[aria-label="Stop"]').waitFor({ state: "detached", timeout: timeoutMs });
  await sleep(500);
}
// The bubble's placeholder changes with the page, its label does not.
const bubbleInput = () => app.getByRole("textbox", { name: "Ask Kompass" });
async function closeAnswer() {
  const close = app.getByRole("button", { name: "Close (Esc)" });
  if (await close.isVisible().catch(() => false)) await click(close, { ms: 400 });
}
/** A new task gets a new conversation (off camera): the side panel keeps the past ones. */
async function newConversation() {
  await rec.cut(async () => {
    await app.getByRole("button", { name: "Open the side panel" }).click();
    await sleep(500);
    await app.getByRole("button", { name: "New conversation" }).click();
    await sleep(300);
    await app.getByRole("button", { name: "Close the side panel" }).click();
    await sleep(600);
  });
}
/** Asks the assistant and logs the moments the edit needs. */
async function ask(prefix, text) {
  await mark(`${prefix}.bubble`, bubbleInput(), { card: true });
  await typeInto(bubbleInput(), text);
  await mark(`${prefix}.typed`);
  await page.keyboard.press("Enter");
  await mark(`${prefix}.sent`);
}

// ---------- Scenes, in the order the app's state needs (the edit puts them in story order) ----------

async function sceneLive() {
  await rec.cut(async () => {
    await api("/live/advance", { method: "POST", body: JSON.stringify({ to: "2026-10-01 06:00:00" }) });
    await app.getByRole("link", { name: /Live stream/ }).first().click();
    await app.getByRole("button", { name: /^(Play|Pause)$/ }).waitFor({ timeout: 20_000 });
    await sleep(1200);
  });
  await mark("live.start");
  await click(app.getByRole("button", { name: "1 h/s", exact: true }), { ms: 450 });
  if (await app.getByRole("button", { name: "Play", exact: true }).isVisible().catch(() => false)) await click(app.getByRole("button", { name: "Play", exact: true }), { ms: 400 });
  await mark("live.playing");
  await untilClock("2026-10-01 11:00", 30_000);
  await click(app.getByRole("button", { name: "Pause", exact: true }), { ms: 300 });
  await mark("live.end");
  await sleep(800);
  // The rest of the day off camera: Jan's failed charge and his call (17:22) reach the service desk.
  // The page only follows the clock while it plays, so it is loaded again after the jump.
  await collectGhost();
  await rec.cut(async () => {
    await api("/live/advance", { method: "POST", body: JSON.stringify({ to: "2026-10-01 18:31:00" }) });
    await frame.goto(`${WEB}/?demo=1`);
    await app.getByText("Revenue at risk", { exact: false }).first().waitFor({ timeout: 60_000 });
    await watchGhost();
    await sleep(1200);
  });
}

async function sceneHome() {
  await rec.cut(async () => {
    await app.getByRole("link", { name: "Home" }).first().click();
    await app.getByText(/Waiting for your approval/i).first().waitFor({ timeout: 20_000 });
    await sleep(1500);
  });
  await leaveRail();
  await mark("home.start");
  await mark("home.kpis", app.getByText("Revenue at risk", { exact: false }).first(), { card: true });
  await sleep(1800);
  const row = app.locator("li").filter({ hasText: "Offer:" }).first();
  await mark("home.list", app.getByText(/Waiting for your approval/i).first(), { card: true });
  await point(row.locator("span[title]").first());
  await mark("home.row", row);
  await sleep(1600);
  await point(row.getByText(/[+−]\d+,\d\d\s*€/).first());
  await sleep(900);
  await click(row.getByRole("button", { name: "Review and edit" }));
  await app.getByText("Why this draft").first().waitFor({ timeout: 15_000 });
  await sleep(500);
  await mark("home.review", app.getByText("Why this draft").first(), { card: true });
  await sleep(3200);
  await page.keyboard.press("Escape");
  await sleep(600);
  if (await app.getByText("Why this draft").first().isVisible().catch(() => false)) await click(app.getByRole("button", { name: /^Close/ }).first(), { ms: 400 });
  await mark("home.end");
}

async function sceneService() {
  await click(app.getByTitle("Service mode"));
  await mark("service.switch");
  await leaveRail();
  await app.getByRole("button", { name: /Jan Neumann/ }).first().waitFor({ timeout: 20_000 });
  await mark("service.desk", app.getByRole("button", { name: /Jan Neumann.*Autostrom charging/ }).first());
  await sleep(1300);
  await click(app.getByRole("button", { name: /Jan Neumann.*Autostrom charging/ }).first());
  await app.getByText("What to do now").first().waitFor({ timeout: 20_000 });
  await sleep(400);
  const fix = app.getByText("Solve the service issue first").first();
  await mark("service.fix", fix, { card: true });
  await point(fix);
  await sleep(2600);
  await scrollTo(app.getByText("Don't offer").first());
  // The whole "Don't offer" block: every offer held back, with the reason.
  const held = app.getByText("Don't offer").first().locator("xpath=..");
  await mark("service.dontoffer", held);
  await point(app.locator("li").filter({ hasText: /cool-off|exclusion|upset/ }).first());
  await sleep(2200);
  await ask("service", "Summarise this customer for me before I call back");
  await assistantDone();
  await mark("service.answer", app.getByRole("button", { name: "Close (Esc)" }), { card: true });
  await sleep(3000);
  await collectGhost();
}

async function sceneCampaign() {
  await closeAnswer();
  await click(app.getByTitle("Marketing mode"));
  await leaveRail();
  await app.getByText(/Waiting for your approval/i).first().waitFor({ timeout: 20_000 });
  await newConversation();
  await mark("ai.nav", app.getByRole("link", { name: "Campaigns" }).first());
  await ask("ai", "Offer a home wallbox to EV drivers without one, by email and portal pop-up, at each customer's best time");
  await app.getByText("Choosing the audience").first().waitFor({ timeout: 60_000 });
  await mark("ai.audience", app.getByText("Choosing the audience").first(), { card: true });
  await app.getByText("Writing the message").first().waitFor({ timeout: 120_000 });
  await mark("ai.writing");
  await app.getByRole("button", { name: /Request approval|Send to|Schedule for/ }).first().waitFor({ timeout: 120_000 });
  await mark("ai.review");
  await assistantDone();
  await mark("ai.done", app.getByRole("button", { name: "Close (Esc)" }), { card: true });
  await sleep(3200);
  await collectGhost();
}

async function sceneApprove() {
  await closeAnswer();
  await sleep(600);
  // A control group that is too small has a one-click fix; it is clicked off camera, so every guardrail is green on camera.
  await rec.cut(async () => {
    const fix = app.getByRole("button", { name: /Hold out 20/ });
    if (await fix.isVisible().catch(() => false)) {
      await fix.click();
      await sleep(1500);
    }
  });
  // The guardrails first: every check for every customer, before anyone can approve.
  const guards = app.getByText("Guardrails", { exact: true }).first();
  await scrollTo(guards);
  await mark("approve.guards", guards, { card: true });
  for (const [k, re] of [["consent", /^Only channels each customer consented to/], ["service", /^Service before sales$/], ["limits", /^Contact limits/]]) await mark(`approve.${k}`, app.getByText(re).first());
  await sleep(3800);
  const btn = app.getByRole("button", { name: /Request approval|Send to|Schedule for/ }).first();
  await scrollTo(btn);
  await mark("approve.button", btn);
  await mark("approve.start");
  await sleep(1400);
  await click(btn);
  await app.getByText(/Waiting for second approval|approved/i).first().waitFor({ timeout: 20_000 }).catch(() => {});
  await sleep(400);
  await mark("approve.done");
  await mark("approve.panel", app.getByText(/Waiting for [A-Z]\w+ [A-Z]/).first(), { card: true }).catch(() => {});
  await sleep(2600);
}

async function sceneChartAI() {
  await newConversation();
  await ask("chart", "Build a chart: which channel beats its control group, split by Du and Sie");
  await assistantDone();
  await mark("chart.done", app.getByRole("button", { name: "Close (Esc)" }), { card: true });
  await sleep(2800);
  await collectGhost();
}

async function sceneCustomersAI() {
  await closeAnswer();
  await newConversation();
  await ask("cust", "Show customers with an open problem, biggest value at risk first");
  await assistantDone();
  await mark("cust.done", app.getByRole("button", { name: "Close (Esc)" }), { card: true });
  await sleep(2600);
  await collectGhost();
}

async function sceneProof() {
  await closeAnswer();
  await click(app.getByRole("link", { name: "Analytics" }).first());
  await leaveRail();
  const card = app.getByText("Which channel beats its control group?").first();
  await card.waitFor({ timeout: 30_000 });
  await sleep(600);
  await mark("proof.board");
  await click(card);
  await app.locator(".recharts-wrapper").first().waitFor({ timeout: 20_000 });
  await sleep(900);
  await mark("proof.chart", app.locator("[data-ai='chart-shelves']").first());
  await mark("proof.plot", app.locator(".recharts-wrapper").first());
  await mark("proof.insight", app.locator(".border-t.border-ink-100.px-4.py-3").first()).catch(() => {});
  await sleep(4600);
  await mark("proof.end");
}

// ---------- Run ----------

async function main() {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) throw new Error("ffmpeg is not installed");
  const status = await api("/status").catch(() => null);
  if (!status) throw new Error(`The app is not running at ${WEB}. Start it with npm run dev.`);
  if (!status.insights?.ok) throw new Error("The workspace server cannot reach the insights service.");
  if (!args.has("--no-reset")) {
    log("resetting the workspace");
    await api("/workspace/reset", { method: "POST" });
  }
  await Promise.allSettled([api("/outreach/audiences"), api("/customers/MG-100009/360"), api("/analytics/charts"), api("/vocabulary"), api("/settings")]);

  const browser = await chromium.launch({ channel: "chrome", headless: true, executablePath: process.env.CHROME_PATH || undefined });
  try {
    const ctx = await browser.newContext({ viewport: { width: APP_W * SCALE, height: APP_H * SCALE }, deviceScaleFactor: 1 });
    page = await ctx.newPage();
    page.on("pageerror", (e) => log("page error:", e.message));
    const stage = `<!doctype html><html><body style="margin:0;overflow:hidden;background:#f4f5f7"><iframe id="app" title="Kompass" src="/?demo=1" style="display:block;border:0;width:${APP_W}px;height:${APP_H}px;transform:scale(${SCALE});transform-origin:0 0"></iframe></body></html>`;
    await page.route(`${WEB}/__take`, (r) => r.fulfill({ contentType: "text/html", body: stage }));
    await page.goto(`${WEB}/__take`);
    app = page.frameLocator("#app");
    await app.getByText("Revenue at risk", { exact: false }).first().waitFor({ timeout: 60_000 });
    frame = page.frames().find((f) => f.parentFrame() && f.url().includes("demo=1"));
    if (!frame) throw new Error("the app frame did not load");
    await watchGhost();
    await sleep(1200);

    rec = new Recorder(await ctx.newCDPSession(page));
    await rec.start();
    const scenes = [
      ["live", sceneLive],
      ["home", sceneHome],
      ["service", sceneService],
      ["campaign", sceneCampaign],
      ["approve", sceneApprove],
      ["chart", sceneChartAI],
      ["customers", sceneCustomersAI],
      ["proof", sceneProof],
    ].filter(([name]) => !only || only.includes(name));
    for (const [name, run] of scenes) {
      const t0 = rec.now();
      log(`scene ${name}`);
      take.scenes.push({ name, t: Math.round(t0 * 1000) / 1000 });
      try {
        await run();
      } catch (e) {
        await page.screenshot({ path: join(TAKE, `failed-${name}.png`) }).catch(() => {});
        throw new Error(`scene "${name}" failed: ${e.message}`);
      }
      await collectGhost();
      log(`scene ${name}: ${(rec.now() - t0).toFixed(1)} s (take at ${rec.now().toFixed(1)} s)`);
    }
    await rec.stop();
  } finally {
    await browser.close();
  }
  const frames = rec.resample();
  take.seconds = Math.round(rec.end * 1000) / 1000;
  take.frames = frames;
  writeFileSync(join(TAKE, "take.json"), JSON.stringify(take, null, 1));
  log(`done: ${frames} frames, ${take.seconds.toFixed(1)} s, ${Object.keys(take.marks).length} marks, ${take.ghost.length} cursor points → ${TAKE}`);
}

main().catch((e) => {
  console.error(`[take] ${e.message}`);
  process.exit(1);
});
