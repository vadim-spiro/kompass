// The sound of the Kompass demo video: the voiceover lines where edit.mjs placed them, the beat from
// music.py ducked under the voice, short sound effects on the cuts, then loudness to −16 LUFS
// (true peak −1.5 dBTP), the level for web video. Writes demo/out/mix/kompass-mix.wav.
//
// Kept between runs (so a new render does not wait for them):
//   demo/assets/vo/*.wav            the voiceover, from tts.py (npm run vo)
//   demo/assets/music/beat.m4a      the beat, made again only when the arrangement changes
//   demo/out/mix/vo/*.wav           the voiceover at the edit's tempo, with its EQ
//
// Run on its own: node demo/video/mix.mjs   (render.mjs calls it)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, "..");
const MIX = join(DEMO, "out/mix");
const MUSIC = join(DEMO, "assets/music");
const PY = process.env.KOMPASS_PY || join(homedir(), "Library/Application Support/claude-maxxing-voice/tts-env/bin/python");
const SR = 48000;

// Levels, in dB. The voice leads; the beat sits under it and dips further while someone speaks.
const MUSIC_UNDER_VO = 1; // the beat in the gaps, below the voice's loudness (was 5; louder on request, 27.10.)
const DUCK = 9; // how much further the beat dips under speech: 10 dB under the voice in total, still clear
const DUCK_HIT = 4; // the dip on a hit, so the impact on a key word still lands
const SFX_UNDER_VO = 9;

const log = (...a) => console.log(`[mix ${new Date().toISOString().slice(11, 19)}]`, ...a);
const db = (x) => Math.pow(10, x / 20);

function ff(args, opt = {}) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], { maxBuffer: 1 << 30, ...opt });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString().slice(-1200)}`);
  return r;
}
/** Any audio file as 48 kHz float samples (interleaved when stereo). */
function readPcm(file, channels, filter) {
  const r = ff(["-i", file, ...(filter ? ["-af", filter] : []), "-ac", String(channels), "-ar", String(SR), "-f", "f32le", "-"]);
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
/** Integrated loudness and the rest of the first loudnorm pass. */
function measure(file, raw) {
  const input = raw ? ["-f", "f32le", "-ar", String(SR), "-ac", "2", "-i", file] : ["-i", file];
  const r = ff([...input, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]);
  const err = r.stderr.toString();
  return JSON.parse(err.slice(err.lastIndexOf("{"), err.lastIndexOf("}") + 1));
}

// ---------- the beat ----------

function beat(timeline) {
  mkdirSync(MUSIC, { recursive: true });
  const arrangement = {
    bpm: timeline.music.bpm,
    total_seconds: timeline.duration,
    sections: timeline.music.sections.map((x) => ({ start: x.start, kind: x.kind })),
    hits: timeline.music.hits,
  };
  const json = JSON.stringify(arrangement, null, 2);
  const file = join(MUSIC, "beat.m4a");
  const kept = join(MUSIC, "arrangement.json");
  if (existsSync(file) && existsSync(kept) && readFileSync(kept, "utf8") === json) return file;
  log("the edit changed: making the beat again (music.py)");
  writeFileSync(join(MIX, "arrangement.json"), json);
  const wav = join(MIX, "beat.wav");
  const r = spawnSync(PY, ["-I", join(HERE, "music.py"), join(MIX, "arrangement.json"), wav], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`music.py failed (set KOMPASS_PY to a python with numpy and scipy)`);
  ff(["-y", "-loglevel", "error", "-i", wav, "-c:a", "aac", "-b:a", "256k", file]);
  writeFileSync(kept, json);
  return file;
}

// ---------- sound effects, made here (a few milliseconds each) ----------

function sfxSample(kind, d = 1) {
  const r = (() => {
    let s = 12345;
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  })();
  const len = Math.round(SR * { whoosh: 0.6, pop: 0.12, thud: 0.45, riser: d, lock: 0.32, tick: 0.025 }[kind]);
  const out = new Float32Array(len);
  // A resonant band-pass that can sweep, for the noise sounds.
  let b1 = 0;
  let b2 = 0;
  const band = (x, f, q) => {
    const w = 2 * Math.sin((Math.PI * Math.min(f, SR / 6)) / SR);
    b2 += w * b1;
    const hp = x - b2 - b1 / q;
    b1 += w * hp;
    return b1;
  };
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const k = i / len;
    let v = 0;
    if (kind === "whoosh") {
      const env = Math.sin(Math.PI * Math.pow(k, 0.7)) ** 2;
      v = band(r(), 300 + 2600 * Math.sin(Math.PI * k), 1.6) * env * 1.6;
    } else if (kind === "pop") {
      const f = 900 * Math.exp(-t * 28) + 260;
      v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 38) + r() * Math.exp(-t * 900) * 0.3;
    } else if (kind === "thud") {
      const f = 48 + 70 * Math.exp(-t * 18);
      v = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9) * 1.2 + band(r(), 180, 1) * Math.exp(-t * 40) * 0.8;
    } else if (kind === "riser") {
      const env = Math.pow(k, 2.2) * (k > 0.97 ? (1 - k) / 0.03 : 1);
      v = (band(r(), 400 + 5200 * k * k, 2.5) * 1.2 + Math.sin(2 * Math.PI * (220 + 660 * k * k) * t) * 0.18) * env;
    } else if (kind === "lock") {
      const c1 = band(r(), 3200, 6) * Math.exp(-t * 160);
      const t2 = t - 0.085;
      const c2 = t2 > 0 ? band(r(), 2200, 6) * Math.exp(-t2 * 120) : 0;
      const body = Math.sin(2 * Math.PI * (110 + 60 * Math.exp(-t * 30)) * t) * Math.exp(-t * 14);
      v = c1 * 1.4 + c2 * 1.6 + body * 0.9;
    } else if (kind === "tick") {
      v = band(r(), 4200, 3) * Math.exp(-t * 400) * 1.5;
    }
    out[i] = v;
  }
  // Every effect peaks at 1, so SFX_UNDER_VO means the same for all of them.
  let peak = 1e-9;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < len; i++) out[i] /= peak;
  return out;
}

// ---------- the mix ----------

export async function mix(timeline) {
  const t0 = Date.now();
  mkdirSync(join(MIX, "vo"), { recursive: true });
  const n = Math.ceil(timeline.duration * SR);

  // Voice: each line at the edit's tempo, high-passed, a little less mud, a little more presence.
  const vo = new Float32Array(n);
  const voFilter = `atempo=${timeline.tempo},highpass=f=90,equalizer=f=250:t=q:w=1:g=-2,equalizer=f=3500:t=q:w=1:g=2.5,acompressor=threshold=0.1:ratio=2.5:attack=5:release=120`;
  for (const p of timeline.vo) {
    const src = join(DEMO, "assets/vo", `${p.id}.wav`);
    const dst = join(MIX, "vo", `${p.id}.wav`);
    const stamp = `${statSync(src).mtimeMs}|${voFilter}`;
    const stampFile = `${dst}.stamp`;
    if (!existsSync(dst) || !existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) {
      ff(["-y", "-loglevel", "error", "-i", src, "-af", voFilter, "-ac", "1", "-ar", String(SR), dst]);
      writeFileSync(stampFile, stamp);
    }
    const x = readPcm(dst, 1);
    const at = Math.round(p.start * SR);
    for (let i = 0; i < x.length && at + i < n; i++) vo[at + i] += x[i];
  }
  writeFileSync(join(MIX, "vo.raw"), Buffer.from(stereo(vo).buffer));
  const voLufs = Number(measure(join(MIX, "vo.raw"), true).input_i);

  // Beat: EQ'd out of the voice's way, then the duck.
  const beatFile = beat(timeline);
  const music = readPcm(beatFile, 2, "highpass=f=50,equalizer=f=2500:t=q:w=1:g=-3");
  writeFileSync(join(MIX, "music.raw"), Buffer.from(music.buffer, music.byteOffset, music.byteLength));
  const musicLufs = Number(measure(join(MIX, "music.raw"), true).input_i);
  const musicGain = db(voLufs - MUSIC_UNDER_VO - musicLufs);
  const duck = duckCurve(timeline, n);

  // Sound effects at the times edit.mjs gave them.
  const fx = new Float32Array(n);
  const cache = {};
  for (const e of timeline.sfx) {
    const key = `${e.kind}:${e.d ?? 1}`;
    const x = (cache[key] ??= sfxSample(e.kind, e.d ?? 1));
    const at = Math.round(e.t * SR);
    const g = e.gain ?? 1;
    for (let i = 0; i < x.length && at + i < n; i++) fx[at + i] += x[i] * g;
  }
  const fxGain = db(voLufs + 14 - SFX_UNDER_VO); // speech peaks sit ~14 dB over its loudness

  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const m = musicGain * duck[i];
    const v = vo[i];
    const f = fx[i] * fxGain;
    out[2 * i] = v + f + (music[2 * i] ?? 0) * m;
    out[2 * i + 1] = v + f + (music[2 * i + 1] ?? 0) * m;
  }
  const premix = join(MIX, "premix.raw");
  writeFileSync(premix, Buffer.from(out.buffer));

  // Loudness: two passes, linear, so the mix keeps its dynamics.
  const m1 = measure(premix, true);
  const file = join(MIX, "kompass-mix.wav");
  const norm = `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m1.input_i}:measured_TP=${m1.input_tp}:measured_LRA=${m1.input_lra}:measured_thresh=${m1.input_thresh}:offset=${m1.target_offset}:linear=true,aresample=${SR}`;
  ff(["-y", "-loglevel", "error", "-f", "f32le", "-ar", String(SR), "-ac", "2", "-i", premix, "-af", norm, "-c:a", "pcm_s24le", file]);
  const check = measure(file);
  const peak = (a, g = 1) => 20 * Math.log10(a.reduce((m, x) => Math.max(m, Math.abs(x)), 1e-9) * g);
  log(`voice ${voLufs.toFixed(1)} LUFS, beat ${musicLufs.toFixed(1)} → ${(voLufs - MUSIC_UNDER_VO).toFixed(1)} LUFS (dips ${DUCK} dB under speech)`);
  log(`peaks before loudness: voice ${peak(vo).toFixed(1)} dBFS, effects ${peak(fx, fxGain).toFixed(1)} dBFS (${timeline.sfx.length} sounds)`);
  log(`mix: ${Number(check.input_i).toFixed(1)} LUFS, true peak ${Number(check.input_tp).toFixed(1)} dBTP → ${file} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return file;
}

function stereo(mono) {
  const s = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) s[2 * i] = s[2 * i + 1] = mono[i];
  return s;
}

/** The beat's gain over time: down while a line plays (fast attack, slow release), less so on a hit. */
function duckCurve(timeline, n) {
  const target = new Float32Array(n).fill(1);
  const set = (a, b, g) => {
    for (let i = Math.max(0, Math.round(a * SR)); i < Math.min(n, Math.round(b * SR)); i++) target[i] = Math.min(target[i], g);
  };
  for (const p of timeline.vo) set(p.start - 0.06, p.end + 0.12, db(-DUCK));
  for (const h of timeline.music.hits) {
    for (let i = Math.max(0, Math.round((h - 0.05) * SR)); i < Math.min(n, Math.round((h + 0.5) * SR)); i++) target[i] = Math.max(target[i], db(-DUCK_HIT));
  }
  const att = 1 - Math.exp(-1 / (0.015 * SR));
  const rel = 1 - Math.exp(-1 / (0.5 * SR));
  const g = new Float32Array(n);
  let y = target[0];
  for (let i = 0; i < n; i++) {
    y += (target[i] - y) * (target[i] < y ? att : rel);
    g[i] = y;
  }
  return g;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const tl = JSON.parse(readFileSync(join(DEMO, "out/timeline.json"), "utf8"));
  mix(tl).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
