// Renders the Kompass demo video: the timeline (edit.mjs), every frame drawn in headless Chrome
// (compose.html), the sound (mix.mjs), then one H.264 file, demo/out/kompass-demo.mp4.
//
//   node demo/video/render.mjs                    the whole video
//   node demo/video/render.mjs --stills=12,47.5   single frames to demo/out/stills/, plus a contact sheet
//   node demo/video/render.mjs --from=40 --to=60  a part of it, to demo/out/part.mp4
//   --fps=10      fewer frames for a quick look      --workers=6   pages rendering in parallel
//   --no-audio    picture only                      --keep        reuse frames already rendered
//   --scale=2     4K (3840×2160) to demo/out/kompass-demo-4k.mp4: the page is drawn at twice the pixels
//
// Needs the raw take (npm run record), the voiceover (npm run vo) and Chrome. The music is made
// from the timeline on the first run and kept in demo/assets/music/.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { buildTimeline } from "./edit.mjs";
import { mix } from "./mix.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, "..");
const OUT = join(DEMO, "out");
const ORIGIN = "http://kompass.video";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml" };

// --key=value or --key value (so `npm run stills -- 12,47.5` works); a bare --flag is true.
const args = {};
for (let i = 2, argv = process.argv; i < argv.length; i++) {
  const [k, v] = argv[i].replace(/^--/, "").split("=");
  args[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
}
const log = (...a) => console.log(`[render ${new Date().toISOString().slice(11, 19)}]`, ...a);
// Pixels per layout pixel. The layout stays 1920×1080, so 2 gives sharp 4K text; the take (2560×1600) is upscaled a little.
const SCALE = Number(args.scale ?? 1);
const FRAMES = join(OUT, SCALE > 1 ? `frames-${SCALE}x` : "frames");

function run(cmd, argv, opt = {}) {
  const r = spawnSync(cmd, argv, { stdio: opt.quiet ? "pipe" : "inherit", maxBuffer: 1 << 26, ...opt });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status}): ${r.stderr?.toString().slice(-800) ?? ""}`);
  return r;
}

/** Opens a page that serves demo/ from a fake origin and has the timeline set up. */
async function openPage(browser, timeline) {
  const ctx = await browser.newContext({ viewport: { width: timeline.w, height: timeline.h }, deviceScaleFactor: SCALE });
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const path = join(DEMO, decodeURIComponent(new URL(route.request().url()).pathname));
    if (!path.startsWith(DEMO) || !existsSync(path)) return route.fulfill({ status: 404, body: "not found" });
    await route.fulfill({ status: 200, contentType: TYPES[extname(path)] ?? "application/octet-stream", body: readFileSync(path) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${ORIGIN}/video/compose.html`);
  await page.evaluate((tl) => window.setup(tl), timeline);
  const cdp = await ctx.newCDPSession(page);
  return { page, cdp, errors, w: timeline.w, h: timeline.h };
}

async function shoot(p, t, file) {
  await p.page.evaluate((x) => window.renderAt(x), t);
  // The clip's scale is what sets the capture size in headless Chrome (deviceScaleFactor alone does not); text is drawn at that size.
  const clip = { x: 0, y: 0, width: p.w, height: p.h, scale: SCALE };
  const { data } = await p.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 93, optimizeForSpeed: true, ...(SCALE > 1 && { clip }) });
  writeFileSync(file, Buffer.from(data, "base64"));
}

async function main() {
  const t0 = Date.now();
  const timeline = buildTimeline();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "timeline.json"), JSON.stringify(timeline));
  const fps = Number(args.fps ?? timeline.fps);
  const from = Number(args.from ?? 0);
  const to = Math.min(Number(args.to ?? timeline.duration), timeline.duration);
  log(`timeline ${timeline.duration}s, ${timeline.shots.length} shots`);

  const browser = await chromium.launch({ channel: "chrome", headless: true, executablePath: process.env.CHROME_PATH || undefined });
  try {
    if (args.stills) {
      const dir = join(OUT, "stills");
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      mkdirSync(dir, { recursive: true });
      const times = String(args.stills).split(",").map(Number);
      const p = await openPage(browser, timeline);
      const files = [];
      for (const t of times) {
        const f = join(dir, `t${t.toFixed(2).padStart(7, "0")}.jpg`);
        await shoot(p, t, f);
        files.push(f);
      }
      if (p.errors.length) log("page errors:", p.errors.slice(0, 5));
      // Contact sheets of twelve, four across, to look at many frames at once.
      for (let g = 0; g * 12 < files.length && files.length > 1; g++) {
        const group = files.slice(g * 12, g * 12 + 12);
        const cols = 4;
        const rows = Math.ceil(group.length / cols);
        const n = cols * rows;
        const inputs = group.flatMap((f) => ["-i", f]);
        for (let i = group.length; i < n; i++) inputs.push("-f", "lavfi", "-i", "color=c=black:s=1920x1080");
        const scaled = Array.from({ length: n }, (_, i) => `[${i}:v]scale=640:360[s${i}]`).join(";");
        const layout = Array.from({ length: n }, (_, i) => `${(i % cols) * 640}_${Math.floor(i / cols) * 360}`).join("|");
        const stack = `${Array.from({ length: n }, (_, i) => `[s${i}]`).join("")}xstack=inputs=${n}:layout=${layout}`;
        run("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", `${scaled};${stack}`, "-frames:v", "1", join(dir, `sheet${g + 1}.jpg`)]);
      }
      log(`${files.length} stills in ${dir}`);
      return;
    }

    // Frames.
    const dir = FRAMES;
    const first = Math.round(from * fps);
    const last = Math.ceil(to * fps) - 1;
    if (!args.keep) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    mkdirSync(dir, { recursive: true });
    const todo = [];
    for (let i = first; i <= last; i++) {
      const f = join(dir, `${String(i - first).padStart(6, "0")}.jpg`);
      if (!(args.keep && existsSync(f) && statSync(f).size > 0)) todo.push({ i, f });
    }
    const workers = Math.max(1, Math.min(Number(args.workers ?? Math.min(6, cpus().length - 2)), todo.length || 1));
    const per = Math.ceil(todo.length / workers);
    let done = 0;
    let lastLog = Date.now();
    const errors = [];
    await Promise.all(
      Array.from({ length: workers }, async (_, w) => {
        const mine = todo.slice(w * per, (w + 1) * per);
        if (!mine.length) return;
        const p = await openPage(browser, timeline);
        for (const { i, f } of mine) {
          await shoot(p, i / fps, f);
          done++;
          if (Date.now() - lastLog > 10000) {
            lastLog = Date.now();
            log(`${done}/${todo.length} frames`);
          }
        }
        errors.push(...p.errors);
      }),
    );
    if (errors.length) log("page errors:", [...new Set(errors)].slice(0, 5));
    log(`${todo.length} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } finally {
    await browser.close();
  }

  // Sound, then the file.
  const part = args.from != null || args.to != null || args.fps != null;
  const height = timeline.h * SCALE;
  const file = join(OUT, part ? "part.mp4" : SCALE > 1 ? `kompass-demo-${height === 2160 ? "4k" : `${height}p`}.mp4` : "kompass-demo.mp4");
  const audio = args["no-audio"] ? null : await mix(timeline);
  const enc = ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(FRAMES, "%06d.jpg")];
  if (audio) enc.push("-ss", String(from), "-t", String(to - from), "-i", audio);
  enc.push("-map", "0:v");
  if (audio) enc.push("-map", "1:a", "-c:a", "aac", "-b:a", "192k");
  enc.push("-c:v", "libx264", "-preset", SCALE > 1 ? "medium" : "slow", "-crf", String(args.crf ?? 22), "-pix_fmt", "yuv420p", "-r", String(fps), "-movflags", "+faststart", "-shortest", file);
  run("ffmpeg", enc);
  const mb = statSync(file).size / 1e6;
  log(`${file} (${mb.toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (mb > 49 && SCALE === 1) log("over 49 MB: GitHub warns above 50 MB. Render again with a higher --crf (e.g. --crf=24 --keep).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
