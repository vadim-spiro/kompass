// Draws one frame of the Kompass demo video as a pure function of the time t (seconds).
//
// render.mjs opens compose.html in headless Chrome, calls window.setup(timeline) once with the
// timeline from edit.mjs and then window.renderAt(t) before every screenshot. Nothing here runs on
// its own clock (no CSS transitions, no timers), so a frame always comes out the same.
//
// Layers, back to front: the navy background (canvas), the app window (frames of the raw take),
// the scenes (type and motion graphics), the cursors and callouts, the captions.
"use strict";

const W = 1920;
const H = 1080;
const CX = W / 2;
const CY = H / 2;
const LEAD = 0.1; // type starts this much before its word is spoken, so the fast part lands on the word
const FULL = { cx: 640, cy: 400, zoom: 1.2 }; // the whole app as a window on the navy background

// ---------- math ----------

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, k) => a + (b - a) * k;
const prog = (t, start, dur) => (dur <= 0 ? (t >= start ? 1 : 0) : clamp((t - start) / dur));

/** CSS-style cubic-bezier easing. */
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (u) => ((ax * u + bx) * u + cx) * u;
  const sy = (u) => ((ay * u + by) * u + cy) * u;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let u = x;
    for (let i = 0; i < 24; i++) {
      const v = sx(u);
      if (Math.abs(v - x) < 1e-5) break;
      if (v < x) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return sy(u);
  };
}
const ease = {
  out: bezier(0.16, 1, 0.3, 1), // type and things arriving
  inOut: bezier(0.65, 0, 0.35, 1), // camera moves
  in: bezier(0.3, 0, 0.8, 0.15), // things leaving
  std: bezier(0.2, 0, 0, 1),
  linear: (x) => clamp(x),
};

/** Step response of a damped spring from 0 to 1, t seconds after it was let go. */
function spring(t, k = 200, c = 22, m = 1) {
  if (t <= 0) return 0;
  const w0 = Math.sqrt(k / m);
  const z = c / (2 * Math.sqrt(k * m));
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}

/** Appears over `din` from `t0`, leaves over `dout` before `t1`: 0 → 1 → 0. */
function life(t, t0, t1, din = 0.35, dout = 0.3) {
  if (t < t0 || t >= t1) return 0;
  return Math.min(ease.out(prog(t, t0, din)), 1 - ease.in(prog(t, t1 - dout, dout)));
}

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- DOM ----------

const $ = (s) => document.querySelector(s);
function h(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
/** Opacity that also takes a hidden element out of painting. */
function show(e, o) {
  e.style.opacity = o;
  e.style.visibility = o <= 0.002 ? "hidden" : "visible";
}
function place(e, x, y, s = 1, extra = "") {
  e.style.transform = `translate(${x}px, ${y}px) scale(${s})${extra}`;
}

const ICON = {
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  sms: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  portal: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8z"/>',
  tag: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  arrowIn: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  userCheck: '<circle cx="9" cy="7" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="m16 11 2 2 4-4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 17V10M13 17V6M18 17v-4"/>',
  users: '<circle cx="9" cy="7" r="4"/><path d="M15 21a6 6 0 0 0-12 0"/><path d="M16 3.1a4 4 0 0 1 0 7.8M21 21a6 6 0 0 0-4-5.7"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4M12 17h.01"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  headset: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  sparkle: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" fill="currentColor"/>',
};
function icon(name, size, color = "currentColor", stroke = 2) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" style="flex:none;display:block">${ICON[name]}</svg>`;
}
const PERSON = '<svg viewBox="0 0 24 24" width="100%" height="100%"><circle cx="12" cy="7.4" r="4.3" fill="currentColor"/><path d="M3.4 22c.5-5 4.2-8.2 8.6-8.2s8.1 3.2 8.6 8.2z" fill="currentColor"/></svg>';
const NEEDLE = (size) => `<svg viewBox="0 0 32 32" width="${size}" height="${size}" style="display:block"><path d="M16 3l5.5 13L16 29l-5.5-13z" fill="#ffe500"/></svg>`;
const GHOST_SVG = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2.5l15 8.2-6.6 1.6L9.2 19z" fill="#6d43d1" stroke="white" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const HUMAN_SVG = '<svg width="25" height="25" viewBox="0 0 24 24" style="left:-5px;top:-2.4px"><path d="M5 2.4v16.4l4.2-4 2.8 6.3 2.7-1.2-2.8-6.2 5.9-.2z" fill="#14161c" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>';

// ---------- state ----------

let TL = null;
let pending = [];
const L = { back: $("#scenesBack"), win: $("#winWrap"), scenes: $("#scenes"), ov: $("#ov"), cap: $("#cap") };
const scenes = [];

function frameUrl(i) {
  const n = clamp(Math.round(i), 0, TL.take.frames - 1);
  return `${TL.take.base}${String(n).padStart(6, "0")}.jpg`;
}
function setImg(img, url) {
  if (img.dataset.src === url) return;
  img.dataset.src = url;
  img.src = url;
  pending.push(img.decode().catch(() => {}));
}

// ---------- background ----------

const bg = $("#bg").getContext("2d");
let noise = null;
function makeNoise() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d");
  const d = x.createImageData(256, 256);
  const r = rng(7);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = Math.floor(r() * 255);
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 255;
  }
  x.putImageData(d, 0, 0);
  return c;
}
function blob(x, y, r, color) {
  const g = bg.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  bg.fillStyle = g;
  bg.fillRect(x - r, y - r, 2 * r, 2 * r);
}
/** How warm the background is at t: the sun shows when the story turns to the solution. */
function warmth(t) {
  let v = 0;
  for (const m of TL.mood ?? []) v = lerp(v, m.warm, ease.inOut(prog(t, m.t, m.d ?? 1.2)));
  return v;
}
function drawBackground(t, frame) {
  const g = bg.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#081738");
  g.addColorStop(1, "#0c2156");
  bg.fillStyle = g;
  bg.fillRect(0, 0, W, H);
  blob(420 + 170 * Math.sin(t * 0.21), 250 + 90 * Math.cos(t * 0.17), 760, "rgba(109,67,209,0.30)");
  blob(1540 + 130 * Math.cos(t * 0.19), 830 + 80 * Math.sin(t * 0.23), 860, "rgba(22,80,176,0.45)");
  const warm = warmth(t);
  if (warm > 0.01) blob(1480 + 90 * Math.sin(t * 0.3), 200 + 40 * Math.cos(t * 0.27), 620, `rgba(255,229,0,${0.12 * warm})`);
  const v = bg.createRadialGradient(CX, CY, H * 0.3, CX, CY, H * 1.0);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.38)");
  bg.fillStyle = v;
  bg.fillRect(0, 0, W, H);
  // Grain keeps the gradients from banding in the encode.
  bg.globalAlpha = 0.05;
  bg.globalCompositeOperation = "overlay";
  const ox = (frame * 37) % 256;
  const oy = (frame * 91) % 256;
  for (let x = -ox; x < W; x += 256) for (let y = -oy; y < H; y += 256) bg.drawImage(noise, x, y);
  bg.globalAlpha = 1;
  bg.globalCompositeOperation = "source-over";
}

// ---------- the take: cursors ----------

function lastAt(list, t) {
  let lo = 0;
  let hi = list.length - 1;
  let i = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (list[m].t <= t) {
      i = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return i;
}
/** Kompass's cursor in the take at take time tt: [x, y] in app px, or null while it is hidden. */
function ghostAt(tt) {
  const G = TL.take.ghost;
  const i = lastAt(G, tt);
  if (i < 0 || !G[i].at) return null;
  const a = G[i];
  const b = G[i + 1];
  if (b && b.at && b.t - a.t < 0.12) {
    const k = (tt - a.t) / (b.t - a.t);
    return [lerp(a.at[0], b.at[0], k), lerp(a.at[1], b.at[1], k)];
  }
  return a.at;
}
/** The human pointer at take time tt, eased along each logged move. */
function humanAt(tt) {
  const P = TL.take.pointer;
  const i = lastAt(P, tt);
  if (i < 0) return P.length ? [P[0].from.x, P[0].from.y] : null;
  const m = P[i];
  const d = m.ms / 1000;
  if (tt < m.t + d) {
    const k = ease.inOut((tt - m.t) / d);
    return [lerp(m.from.x, m.to.x, k), lerp(m.from.y, m.to.y, k)];
  }
  return [m.to.x, m.to.y];
}

const GH = { el: h("div", "cursor ghost", L.ov, `${GHOST_SVG}<span class="pill">Kompass</span>`), used: false };
const HU = { el: h("div", "cursor human", L.ov, HUMAN_SVG), used: false };
function placeCursor(c, x, y, s, o = 1) {
  c.used = true;
  c.el.style.display = "";
  place(c.el, x, y, s);
  show(c.el, o);
}
const ripples = [];
let rippleN = 0;
function ripple(x, y, age, scale, human) {
  if (age < 0 || age > 0.5) return;
  const r = ripples[rippleN] ?? (ripples[rippleN] = h("div", "ripple", L.ov));
  rippleN++;
  r.className = `ripple${human ? " human" : ""}`;
  r.style.display = "";
  const k = ease.out(age / 0.5);
  place(r, x, y, scale * (0.4 + 1.3 * k));
  show(r, 0.9 * (1 - k));
}

// ---------- the app window ----------

const WIN = { root: h("div", "win", L.win), used: false };
WIN.img = h("img", "", WIN.root);

/** Interpolated camera keys: each key moves from where the camera was when it started. */
function prepCam(keys) {
  if (!keys?.length) return [{ t: 0, d: 0, ...FULL, from: FULL }];
  keys.sort((a, b) => a.t - b.t);
  keys[0].from = { cx: keys[0].cx, cy: keys[0].cy, zoom: keys[0].zoom };
  for (let j = 1; j < keys.length; j++) keys[j].from = camKey(keys[j - 1], keys[j].t);
  return keys;
}
function camKey(k, t) {
  const p = ease[k.ease ?? "inOut"](prog(t, k.t, k.d ?? 0.6));
  return { cx: lerp(k.from.cx, k.cx, p), cy: lerp(k.from.cy, k.cy, p), zoom: Math.exp(lerp(Math.log(k.from.zoom), Math.log(k.zoom), p)) };
}
function camAt(keys, t) {
  let j = 0;
  for (let i = 0; i < keys.length; i++) if (keys[i].t <= t) j = i;
  return camKey(keys[j], t);
}

/** fx: opacity, scale (around the screen centre), dy, rotX (degrees), dim (0..1). */
function drawWindow(frame, cam, fx) {
  WIN.used = true;
  WIN.root.style.display = "";
  setImg(WIN.img, frameUrl(frame));
  const z = cam.zoom;
  const x = CX - cam.cx * z;
  const y = CY - cam.cy * z;
  const s = fx.scale ?? 1;
  const pre = s !== 1 || fx.dy || fx.rotX ? `translate(${CX}px, ${CY + (fx.dy ?? 0)}px) rotateX(${fx.rotX ?? 0}deg) scale(${s}) translate(${-CX}px, ${-CY}px) ` : "";
  WIN.root.style.transform = `${pre}translate(${x}px, ${y}px) scale(${z})`;
  WIN.root.style.borderRadius = `${clamp(14 / z, 6, 16)}px`;
  show(WIN.root, fx.opacity ?? 1);
  WIN.root.style.filter = fx.dim ? `brightness(${1 - fx.dim})` : "";
}
function mapper(cam, fx) {
  const s = fx.scale ?? 1;
  const dy = fx.dy ?? 0;
  return (x, y) => [CX + (x - cam.cx) * cam.zoom * s, CY + dy + (y - cam.cy) * cam.zoom * s];
}
function fxAt(sh, t) {
  const fx = { opacity: 1, scale: 1, dy: 0, rotX: 0, dim: 0 };
  const mix = (from, p) => {
    for (const k of Object.keys(from)) fx[k] = lerp(from[k], fx[k], p);
  };
  if (sh.enter) mix(sh.enter.from, ease[sh.enter.ease ?? "out"](prog(t, sh.enter.t ?? sh.start, sh.enter.d)));
  if (sh.exit) mix(sh.exit.to, 1 - ease[sh.exit.ease ?? "in"](prog(t, sh.exit.t, sh.exit.d)));
  for (const d of sh.dims ?? []) fx.dim = Math.max(fx.dim, d.amount * life(t, d.t0, d.t1, 0.3, 0.3));
  return fx;
}

// ---------- callouts and chips ----------

function makeCallout(parent, c) {
  const ring = c.ring === false ? null : h("div", "ring", parent);
  const tag = c.label ? h("div", `tag ${c.color ?? ""}`, parent, `${c.icon ? icon(c.icon, 26, "currentColor", 2.4) : ""}<span>${esc(c.label)}</span>`) : null;
  let tw = 0;
  let th = 0;
  return {
    draw(t, map, z) {
      const v = life(t, c.t0, c.t1, 0.35, 0.3);
      if (v <= 0) {
        if (ring) show(ring, 0);
        if (tag) show(tag, 0);
        return;
      }
      const pad = (c.pad ?? 8) * z;
      const [x0, y0] = map(c.box.x, c.box.y);
      const [x1, y1] = map(c.box.x + c.box.w, c.box.y + c.box.h);
      const grow = (1 - ease.out(prog(t, c.t0, 0.45))) * 14;
      if (ring) {
        ring.style.width = `${x1 - x0 + 2 * (pad + grow)}px`;
        ring.style.height = `${y1 - y0 + 2 * (pad + grow)}px`;
        ring.style.borderRadius = `${10 + 4 * z}px`;
        place(ring, x0 - pad - grow, y0 - pad - grow);
        show(ring, v);
      }
      if (tag) {
        if (!tw) {
          tw = tag.offsetWidth;
          th = tag.offsetHeight;
        }
        const slide = (1 - ease.out(prog(t, c.t0 + 0.08, 0.4))) * 16;
        const gap = 16 + pad;
        let x;
        let y;
        const side = c.side ?? "top";
        if (side === "top") [x, y] = [(x0 + x1) / 2 - tw / 2 + (c.dx ?? 0), y0 - gap - th + slide];
        else if (side === "bottom") [x, y] = [(x0 + x1) / 2 - tw / 2 + (c.dx ?? 0), y1 + gap - slide];
        else if (side === "left") [x, y] = [x0 - gap - tw + slide, (y0 + y1) / 2 - th / 2 + (c.dy ?? 0)];
        else [x, y] = [x1 + gap - slide, (y0 + y1) / 2 - th / 2 + (c.dy ?? 0)];
        place(tag, clamp(x, 24, W - 24 - tw), clamp(y, 24, H - 24 - th));
        show(tag, v);
      }
    },
  };
}
function makeChip(parent, c) {
  const el = h("div", `tag ${c.color ?? "navy"}`, parent, `${c.icon ? icon(c.icon, 26, "currentColor", 2.4) : ""}<span>${esc(c.text)}</span>`);
  if (c.size) el.style.fontSize = `${c.size}px`;
  let w = 0;
  let hh = 0;
  return {
    draw(t) {
      const v = life(t, c.t0, c.t1, 0.4, 0.3);
      if (v <= 0) return show(el, 0);
      if (!w) {
        w = el.offsetWidth;
        hh = el.offsetHeight;
      }
      const slide = (1 - ease.out(prog(t, c.t0, 0.5))) * (c.from === "right" ? 40 : c.from === "left" ? -40 : 0);
      const rise = (1 - ease.out(prog(t, c.t0, 0.5))) * (c.from ? 0 : 18);
      const ax = c.anchor === "right" ? w : c.anchor === "left" ? 0 : w / 2;
      place(el, c.x - ax + slide, c.y - hh / 2 + rise);
      show(el, v);
    },
  };
}

// ---------- kinetic type ----------

/** Value of stepped keys [[t, v], ...]: each step eases from the value before it. */
function stepAt(steps, t, d = 0.4) {
  if (!steps?.length) return 1;
  let v = steps[0][1];
  for (let i = 1; i < steps.length; i++) v = lerp(v, steps[i][1], ease.out(prog(t, steps[i][0], d)));
  return v;
}

/** A line of words that arrive one by one and keep the line centred. A word may enter big and shrink. */
function makeLine(parent, words, o) {
  const size = o.size;
  const els = words.map((w) => {
    const e = h("div", `kw ${w.cls ?? ""}`, parent);
    e.style.fontSize = `${size}px`;
    if (o.weight) e.style.fontWeight = o.weight;
    e.textContent = w.text;
    show(e, 0);
    return e;
  });
  const widths = els.map((e) => e.getBoundingClientRect().width);
  const gap = size * (o.gap ?? 0.27);
  return {
    els,
    widths,
    size,
    /** Per word: x of its left edge, scale s, entrance p. */
    layout(t) {
      const st = words.map((w) => ({ p: ease.out(prog(t, w.t - LEAD, w.dur ?? 0.45)), s: stepAt(w.scale, t), k: ease.std(prog(t, w.t - LEAD, o.reflow ?? 0.42)) }));
      if (!o.reflow) st.forEach((s) => (s.k = 1));
      let total = 0;
      st.forEach((s, i) => (total += (widths[i] * s.s + (i ? gap : 0)) * s.k));
      let cur = (o.x ?? CX) - total / 2;
      st.forEach((s, i) => {
        if (i) cur += gap * s.k;
        s.x = cur;
        cur += widths[i] * s.s * s.k;
      });
      return st;
    },
    draw(t, extra = {}) {
      const st = this.layout(t);
      st.forEach((s, i) => {
        const e = els[i];
        const rise = (1 - s.p) * size * 0.32;
        place(e, s.x, o.y - 0.855 * size + rise + (extra.dy ?? 0), s.s);
        show(e, s.p * (extra.opacity ?? 1));
      });
      return st;
    },
  };
}

// ---------- scenes ----------

const SCENE = {};

/** The app window: clips of the take, a camera, both cursors, callouts and chips. */
SCENE.app = (sh) => {
  const root = h("div", "layer", L.scenes);
  sh.cam = prepCam(sh.cam);
  const calls = (sh.callouts ?? []).map((c) => makeCallout(root, c));
  const chips = (sh.chips ?? []).map((c) => makeChip(root, c));
  // Where Kompass's cursor stops: a small ripple shows that it acts there.
  const stops = [];
  const G = TL.take.ghost;
  for (let i = 1; i < G.length - 1; i++) {
    const a = G[i];
    const b = G[i + 1];
    if (a.at && G[i - 1].at && a.t - G[i - 1].t < 0.06 && (!b.at || b.t - a.t > 0.25)) stops.push({ t: a.t, at: a.at });
  }
  const clipAt = (t) => {
    let c = sh.clips[0];
    for (const k of sh.clips) if (k.start <= t) c = k;
    return c;
  };
  const tt = (c, t) => c.from + (clamp(t, c.start, c.end) - c.start) * ((c.to - c.from) / Math.max(1e-6, c.end - c.start));
  // A scripted cursor (edit.mjs) moves on the shot's own clock and fades out after its last point.
  const S = sh.scripted;
  const scriptedAt = (t) => {
    if (!S?.length || t < S[0].t || t > S[S.length - 1].t) return null;
    const i = lastAt(S, t);
    const a = S[i];
    const b = S[i + 1];
    return b ? [lerp(a.at[0], b.at[0], (t - a.t) / (b.t - a.t)), lerp(a.at[1], b.at[1], (t - a.t) / (b.t - a.t))] : a.at;
  };
  return {
    root,
    draw(t) {
      const c = clipAt(t);
      const take = tt(c, t);
      const cam = camAt(sh.cam, t);
      const fx = fxAt(sh, t);
      drawWindow(take * TL.take.fps, cam, fx);
      const map = mapper(cam, fx);
      const z = cam.zoom * (fx.scale ?? 1);
      const flat = Math.abs(fx.rotX ?? 0) < 0.5;
      // Kompass's cursor.
      if (sh.ghost && flat) {
        let at = S ? scriptedAt(t) : ghostAt(take);
        let vis = at ? (S ? 1 - prog(t, S[S.length - 1].t - 0.25, 0.25) : 1) : 0;
        for (const p of sh.park ?? []) if (t >= p.t0 && t < p.t1 && !at) [at, vis] = [p.at, 1];
        if (at) {
          let [x, y] = map(at[0], at[1]);
          // Across a cut the cursor glides on from where it was instead of jumping.
          const ci = sh.clips.indexOf(c);
          if (ci > 0 && t - c.start < 0.3 && sh.glide !== false) {
            const prev = sh.clips[ci - 1];
            const pa = ghostAt(tt(prev, c.start - 1e-3));
            if (pa) {
              const [px, py] = map(pa[0], pa[1]);
              const k = ease.out((t - c.start) / 0.3);
              x = lerp(px, x, k);
              y = lerp(py, y, k);
            }
          }
          if (sh.entry && t < sh.entry.t1) {
            const k = ease.inOut(prog(t, sh.entry.t0, sh.entry.t1 - sh.entry.t0));
            x = lerp(sh.entry.from[0], x, k);
            y = lerp(sh.entry.from[1], y, k);
          }
          placeCursor(GH, x, y, z * (sh.ghostScale ?? 1.15), vis * (fx.opacity ?? 1));
          for (const s of stops) ripple(...map(s.at[0], s.at[1]), take - s.t, z, false);
        }
      }
      // The human pointer, while it is the human's turn.
      if (sh.human && flat) {
        const on = (sh.humanOn ?? [[sh.start, sh.end]]).some(([a, b]) => t >= a && t < b);
        const at = on ? humanAt(take) : null;
        if (at) {
          const [x, y] = map(at[0], at[1]);
          placeCursor(HU, x, y, z * 1.1, fx.opacity ?? 1);
          for (const k of TL.take.clicks) ripple(...map(k.x, k.y), take - k.t, z, true);
        }
      }
      calls.forEach((k) => k.draw(t, map, z));
      chips.forEach((k) => k.draw(t));
    },
  };
};

/** 17:22, Jan's charging fails twice; the next morning an upsell email. Wrong message, wrong moment. */
SCENE.hook = (sh) => {
  const k = sh.k;
  const root = h("div", "layer", L.scenes);
  const A = h("div", "abs", root);
  const dayA = h("div", "abs label", A, "Thursday");
  const clockA = h("div", "abs num", A, "17:22");
  Object.assign(clockA.style, { font: "700 210px/1 var(--font)", letterSpacing: "-0.04em" });
  const notif = (time, title, body) =>
    h("div", "abs glass notif", A, `<div class="ic">${icon("bolt", 34, "#ffe500", 2.2)}</div><div><div class="tt">${title}</div><div class="bd">${body}</div></div><div class="tm">${time}</div>`);
  const card1 = notif("17:22", "Charging failed", "Your session could not be started.");
  const card2 = notif("17:24", "Charging failed again", "Please try another charge point.");
  const B = h("div", "abs", root);
  const dayB = h("div", "abs label", B, `<span style="display:inline-flex;gap:12px;align-items:center">${icon("sun", 30, "#ffe500")}Next morning</span>`);
  const clockB = h("div", "abs num", B, "08:00");
  Object.assign(clockB.style, { font: "700 150px/1 var(--font)", letterSpacing: "-0.04em" });
  const subj = (sh.subject ?? []).map((w) => `<span>${esc(w.text)}</span>`).join(" ");
  const mail = h("div", "abs mail", B, `<div class="from"><div class="av">M</div>MAINGAU Newsletter<div class="time">08:00</div></div><div class="subj">${subj}</div><div class="bar" style="width:92%"></div><div class="bar" style="width:70%"></div>`);
  const subjEls = [...mail.querySelectorAll(".subj span")];
  const strike1 = h("div", "abs strike", B);
  const strike2 = h("div", "abs strike", B);
  const line = makeLine(root, sh.wrong, { size: 104, y: 975, gap: 0.26 });
  const center = (e, w) => (e.style.width = `${w}px`) && (e.style.textAlign = "center") && (e.style.left = `${-w / 2}px`);
  center(dayA, 800);
  center(clockA, 800);
  center(dayB, 700);
  center(clockB, 700);
  [card1, card2].forEach((c) => (c.style.left = "-320px"));
  mail.style.left = "-330px";
  return {
    root,
    draw(t) {
      const out = 1 - ease.in(prog(t, k.out, 0.45));
      const morning = ease.inOut(prog(t, k.morning, 0.7));
      // Evening group: centred, then it steps aside for the next morning.
      const inA = ease.out(prog(t, k.clock, 0.6));
      place(A, lerp(CX, 560, morning), lerp(CY, CY - 20, morning) + (1 - inA) * 30, lerp(1, 0.8, morning) * (0.97 + 0.03 * out));
      show(A, inA * out * lerp(1, 0.72, ease.out(prog(t, k.wrong2, 0.4))));
      place(dayA, 0, -330);
      place(clockA, 0, -295);
      show(dayA, ease.out(prog(t, k.clock + 0.1, 0.5)));
      const c1 = ease.out(prog(t, k.card1, 0.5));
      const c2 = ease.out(prog(t, k.again, 0.45));
      const shake = t > k.again ? Math.sin((t - k.again) * 55) * 16 * Math.exp(-(t - k.again) * 7) : 0;
      place(card1, 0, -45 + (1 - c1) * 40 + c2 * 150, 1 - 0.05 * c2);
      show(card1, c1 * (1 - 0.35 * c2));
      place(card2, shake, -45 + (1 - c2) * 40);
      show(card2, c2);
      // Morning group.
      const inB = ease.out(prog(t, k.morning + 0.15, 0.7));
      place(B, 1370 + (1 - inB) * 160, CY - 20, 0.97 + 0.03 * out);
      show(B, inB * out);
      place(dayB, 0, -330);
      place(clockB, 0, -290);
      const pm = ease.out(prog(t, k.email, 0.6));
      place(mail, 0, -70 + (1 - pm) * 50, 0.94 + 0.06 * pm);
      show(mail, pm * lerp(1, 0.55, ease.out(prog(t, k.wrong1 + 0.2, 0.4))));
      mail.style.boxShadow = `0 30px 80px rgba(0,0,0,.45), 0 0 ${60 * life(t, k.email + 0.2, k.wrong1, 0.3, 0.4)}px rgba(255,229,0,.45)`;
      subjEls.forEach((e, i) => (e.style.backgroundSize = `${100 * ease.out(prog(t, (sh.subject[i]?.t ?? 99) - 0.05, 0.3))}% 100%`));
      // Strikes: wrong message, wrong moment.
      Object.assign(strike1.style, { width: "720px", left: "-360px" });
      place(strike1, 0, 70, 1, ` rotate(-9deg) scaleX(${ease.out(prog(t, k.wrong1, 0.35))})`);
      show(strike1, prog(t, k.wrong1, 0.05));
      Object.assign(strike2.style, { width: "460px", left: "-230px" });
      place(strike2, 0, -215, 1, ` rotate(-9deg) scaleX(${ease.out(prog(t, k.wrong2, 0.35))})`);
      show(strike2, prog(t, k.wrong2, 0.05));
      line.draw(t, { opacity: out });
    },
  };
};

/** MAINGAU knows its customers; 647 signals; still one newsletter for all; 0,6 %; then the next right step. */
SCENE.problem = (sh) => {
  const k = sh.k;
  const root = h("div", "layer", L.scenes);
  const cv = h("canvas", "full", root);
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  // 1. One customer and what MAINGAU knows about them.
  const avatar = h("div", "abs", root, `<div style="width:230px;height:230px;border-radius:50%;background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 2px rgba(255,255,255,.22);display:grid;place-items:center;color:#fff"><div style="width:120px;height:120px">${PERSON}</div></div>`);
  const knows = h("div", "abs", root, "MAINGAU knows a lot.");
  Object.assign(knows.style, { font: "700 64px/1 var(--font)", letterSpacing: "-0.02em", width: "1200px", left: "-600px", textAlign: "center" });
  const chipDefs = [
    ["Contracts", "doc", -470, -150],
    ["Charging", "bolt", 470, -150],
    ["Tickets", "ticket", -470, 170],
    ["Consents", "shield", 470, 170],
  ];
  const chips = chipDefs.map(([label, ic]) => h("div", "abs glass chip", root, `${icon(ic, 40, "#ffe500", 2.2)}${label}`));
  const chipW = chips.map((c) => c.getBoundingClientRect().width);
  // 2. 647 signals.
  const counter = h("div", "abs num", root, "0");
  Object.assign(counter.style, { font: "800 270px/1 var(--font)", letterSpacing: "-0.05em", width: "1000px", left: "-500px", textAlign: "center" });
  const sigLabel = h("div", "abs", root, "signals on a single day");
  Object.assign(sigLabel.style, { font: "600 50px/1 var(--font)", color: "rgba(255,255,255,.7)", width: "1000px", left: "-500px", textAlign: "center" });
  const r = rng(11);
  const parts = Array.from({ length: 150 }, () => ({ a: r() * Math.PI * 2, d: r() * 0.75, s: 3 + r() * 6, c: r() < 0.2 ? "#ffe500" : r() < 0.35 ? "#a98bff" : "#ffffff" }));
  // 3. One newsletter for everyone.
  const COLS = 14;
  const ROWS = 5;
  const people = [];
  for (let row = 0; row < ROWS; row++)
    for (let col = 0; col < COLS; col++) {
      const e = h("div", "abs", root, `<div style="width:54px;height:54px;color:#fff">${PERSON}</div>`);
      const badge = h("div", "abs", e);
      const env = h("div", "abs", root, icon("mail", 30, "#ffffff", 2));
      people.push({ e, badge, env, x: CX + (col - (COLS - 1) / 2) * 96, y: 600 + (row - (ROWS - 1) / 2) * 96, d: Math.hypot(col - (COLS - 1) / 2, row - (ROWS - 1) / 2), rnd: r() });
    }
  const bigEnv = h("div", "abs", root, `<div style="width:120px;height:120px;border-radius:30px;background:#fff;display:grid;place-items:center">${icon("mail", 70, "#0c2257", 2)}</div>`);
  const same = h("div", "abs", root, "Same text. Everyone.");
  Object.assign(same.style, { font: "800 76px/1 var(--font)", letterSpacing: "-0.025em", width: "1400px", left: "-700px", textAlign: "center" });
  const pct = h("div", "abs num sun", root, "0.0 %");
  Object.assign(pct.style, { font: "800 250px/1 var(--font)", letterSpacing: "-0.05em", width: "1200px", left: "-600px", textAlign: "center" });
  const conv = h("div", "abs", root, "convert");
  Object.assign(conv.style, { font: "700 64px/1 var(--font)", width: "1000px", left: "-500px", textAlign: "center" });
  const worked = h("div", "abs", root, 'What worked<span class="sun">?</span>');
  Object.assign(worked.style, { font: "800 130px/1 var(--font)", letterSpacing: "-0.035em", width: "1400px", left: "-700px", textAlign: "center" });
  const qMark = worked.querySelector("span");
  qMark.style.display = "inline-block";
  const noCtl = h("div", "abs", root, "No control group. No proof.");
  Object.assign(noCtl.style, { font: "600 46px/1 var(--font)", color: "rgba(255,255,255,.62)", width: "1200px", left: "-600px", textAlign: "center" });
  // 4. The next right step for every customer.
  const head = makeLine(root, sh.nrs, { size: 96, y: 250, gap: 0.26 });
  const under = h("div", "abs", root);
  Object.assign(under.style, { height: "10px", borderRadius: "5px", background: "#ffe500", transformOrigin: "0 50%", boxShadow: "0 0 24px rgba(255,229,0,.5)" });
  const KINDS = [
    ["tag", "#ffffff", "#0c2257"],
    ["wrench", "#ffe500", "#0c2257"],
    ["info", "#1650b0", "#ffffff"],
    ["clock", "rgba(255,255,255,.22)", "#ffffff"],
  ];
  people.forEach((p, i) => {
    const kind = p.rnd < 0.42 ? 0 : p.rnd < 0.66 ? 1 : p.rnd < 0.84 ? 2 : 3;
    p.kind = kind;
    p.badge.innerHTML = `<div style="width:32px;height:32px;border-radius:50%;background:${KINDS[kind][1]};display:grid;place-items:center;box-shadow:0 0 0 3px #0b1d4a">${icon(KINDS[kind][0], 19, KINDS[kind][2], 2.4)}</div>`;
    place(p.badge, 30, 28);
    p.time = ["09:00", "12:30", "18:00", "19:30", "07:45"][i % 5];
    p.ch = ["mail", "sms", "portal", "phone"][i % 4];
    p.tl = h("div", "abs", root, p.time);
    Object.assign(p.tl.style, { font: "700 18px/1 var(--font)", color: "#ffe500" });
    p.cl = h("div", "abs", root, `<div style="display:flex;align-items:center;gap:3px;color:#fff">${icon(p.ch, 18, "#fff", 2)}${icon("check", 16, "#ffe500", 3)}</div>`);
  });
  const hide = [avatar, knows, ...chips, counter, sigLabel, bigEnv, same, pct, conv, worked, noCtl, under];
  return {
    root,
    draw(t) {
      hide.forEach((e) => show(e, 0));
      for (const p of people) [p.e, p.env, p.tl, p.cl].forEach((e) => show(e, 0));
      head.els.forEach((e) => show(e, 0));
      ctx.clearRect(0, 0, W, H);
      const end = 1 - ease.in(prog(t, k.out, 0.4));
      // Phase 1: the customer.
      const collapse = ease.in(prog(t, k.n647 - 0.15, 0.35));
      if (t < k.n647 + 0.3) {
        const a = ease.out(prog(t, k.knows - 0.2, 0.5));
        place(avatar, CX - 115, 560 - 115 + (1 - a) * 30, (0.9 + 0.1 * a) * (1 - collapse));
        show(avatar, a * (1 - collapse));
        place(knows, CX, 200 + (1 - a) * 20);
        show(knows, a * (1 - collapse));
        chipDefs.forEach(([, , dx, dy], i) => {
          const p = spring(t - (k.chips[i] - LEAD), 220, 18);
          const x = CX + dx * (1 - collapse) - chipW[i] / 2;
          const y = 560 + dy * (1 - collapse) - 44;
          place(chips[i], x, y, Math.max(0, p) * (1 - collapse));
          show(chips[i], clamp(p * 2) * (1 - collapse));
          chips[i].style.transformOrigin = "50% 50%";
        });
      }
      // Phase 2: 647 signals flow in.
      if (t >= k.n647 - 0.2 && t < k.newsletter + 0.6) {
        const away = ease.in(prog(t, k.newsletter - 0.25, 0.45));
        const n = Math.round(647 * ease.out(prog(t, k.n647, 1.2)));
        counter.textContent = String(n);
        const ci = ease.out(prog(t, k.n647 - LEAD, 0.4));
        place(counter, CX, 540 - 175 + (1 - ci) * 30 - away * 120, 0.94 + 0.06 * ci);
        show(counter, ci * (1 - away));
        place(sigLabel, CX, 640 - away * 120 + (1 - ease.out(prog(t, k.signals - LEAD, 0.4))) * 20);
        show(sigLabel, ease.out(prog(t, k.signals - LEAD, 0.4)) * (1 - away));
        for (const p of parts) {
          const q = prog(t, k.n647 - 0.1 + p.d, 0.6);
          if (q <= 0 || q >= 1) continue;
          const rr = 1150 * (1 - ease.in(q));
          ctx.globalAlpha = 0.85 * (1 - q * 0.6);
          ctx.fillStyle = p.c;
          ctx.beginPath();
          ctx.arc(CX + Math.cos(p.a) * rr, 470 + Math.sin(p.a) * rr * 0.62, p.s, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      // Phase 3-5: the grid of customers, one newsletter, 0,6 %, what worked?
      const gridIn = (p) => ease.out(prog(t, k.newsletter + 0.1 + p.d * 0.06, 0.45));
      const dimmed = ease.out(prog(t, k.pct - 0.1, 0.4)) * (1 - ease.out(prog(t, k.whatif - 0.2, 0.5)));
      const vision = ease.out(prog(t, k.whatif - 0.2, 0.5));
      if (t >= k.newsletter - 0.1) {
        const e0 = ease.out(prog(t, k.newsletter - LEAD, 0.45));
        const e1 = 1 - ease.in(prog(t, k.everyone + 0.55, 0.3));
        place(bigEnv, CX - 60, 175 + (1 - e0) * 30, 0.9 + 0.1 * e0);
        show(bigEnv, e0 * e1);
        for (const p of people) {
          const a = gridIn(p);
          const lit = t > k.convert && p === people[37] ? 1 : 0;
          place(p.e, p.x - 27, p.y - 27 + (1 - a) * 24 - vision * 40);
          show(p.e, a * lerp(1, 0.18 + 0.82 * lit, dimmed) * end);
          p.e.firstChild.style.color = lit && dimmed > 0.5 ? "#ffe500" : "#fff";
          // The same envelope lands on everyone.
          const f = prog(t, k.everyone - 0.05 + p.d * 0.05, 0.45);
          const gone = ease.in(prog(t, k.whatif - 0.3, 0.3));
          if (f > 0) {
            const ef = ease.inOut(f);
            place(p.env, lerp(CX - 15, p.x + 4, ef), lerp(235, p.y - 66, ef), lerp(0.6, 0.85, ef));
            show(p.env, Math.min(1, f * 3) * lerp(1, 0.2, dimmed) * (1 - gone) * end);
          } else show(p.env, 0);
          // The vision: everyone gets their own step, at their own time, on their own channel.
          const b = spring(t - (k.every - 0.1 + p.d * 0.07), 260, 20);
          show(p.badge, clamp(b * 2) * vision);
          p.badge.style.transform = `translate(30px, 28px) scale(${Math.max(0, b)})`;
          const tm = ease.out(prog(t, k.moment - LEAD + p.d * 0.03, 0.4));
          place(p.tl, p.x - 26, p.y - 27 - 40 - 28 + (1 - tm) * 8);
          show(p.tl, (p.d % 2 < 1 ? tm : 0) * vision * end);
          const ch = ease.out(prog(t, k.channel - LEAD + p.d * 0.03, 0.4));
          place(p.cl, p.x - 22, p.y + 34 - 40 + (1 - ch) * 8);
          show(p.cl, (p.d % 2 >= 1 ? ch : 0) * vision * end);
        }
        const sm = life(t, k.same - LEAD, k.pct - 0.1, 0.45, 0.3);
        place(same, CX, 860 + (1 - sm) * 20);
        show(same, sm);
        const pc = life(t, k.pct - LEAD, k.whatif - 0.2, 0.45, 0.3);
        const up = ease.inOut(prog(t, k.nobody - 0.1, 0.5));
        pct.textContent = `${(0.6 * ease.out(prog(t, k.pct, 0.9))).toFixed(1)} %`;
        place(pct, CX, lerp(400, 200, up) - 125, lerp(1, 0.55, up));
        pct.style.transformOrigin = "50% 50%";
        show(pct, pc);
        const cv2 = life(t, k.convert - LEAD, k.whatif - 0.2, 0.4, 0.3);
        place(conv, CX, lerp(640, 330, up) + (1 - cv2) * 16, lerp(1, 0.7, up));
        show(conv, cv2);
        const wk = life(t, k.what - LEAD, k.whatif - 0.2, 0.45, 0.3);
        place(worked, CX, 520 + (1 - wk) * 24);
        show(worked, wk);
        const q = spring(t - (k.worked - LEAD), 240, 12);
        qMark.style.transform = `translateY(${(1 - q) * -60}px) scale(${0.6 + 0.4 * q})`;
        const nc = life(t, k.worked + 0.25, k.whatif - 0.2, 0.4, 0.3);
        place(noCtl, CX, 700 + (1 - nc) * 16);
        show(noCtl, nc);
      }
      // The headline of the vision.
      if (t >= k.whatif - 0.3) {
        const st = head.draw(t, { opacity: end });
        const i0 = sh.underFrom ?? 1;
        const x0 = st[i0].x;
        const x1 = st[st.length - 1].x + head.widths[st.length - 1];
        const u = ease.out(prog(t, k.step + 0.05, 0.45));
        Object.assign(under.style, { width: `${x1 - x0}px` });
        place(under, x0, 270, 1, ` scaleX(${u})`);
        show(under, (u > 0 ? 1 : 0) * end);
      }
    },
  };
};

/** "Meet Kompass": the mark, the name, the sentence, the app rising into view. */
SCENE.reveal = (sh) => {
  const k = sh.k;
  const root = h("div", "layer", L.scenes);
  const flash = h("div", "abs", root);
  Object.assign(flash.style, { width: "1400px", height: "1400px", left: "-700px", top: "-700px", borderRadius: "50%", background: "radial-gradient(circle, rgba(255,229,0,.55), rgba(109,67,209,.25) 35%, rgba(0,0,0,0) 65%)" });
  const logo = h("div", "abs", root);
  const mark = h("div", "abs mark", logo, NEEDLE(120));
  Object.assign(mark.style, { width: "210px", height: "210px" });
  const word = h("div", "abs wordmark", logo, "Kompass");
  const ww = word.getBoundingClientRect().width;
  const total = 210 + 44 + ww;
  const l1 = makeLine(root, sh.line1, { size: 62, y: 222, gap: 0.27 });
  const l2 = makeLine(root, sh.line2, { size: 62, y: 222, gap: 0.27 });
  return {
    root,
    draw(t) {
      const out = 1 - ease.in(prog(t, k.out, 0.4));
      const f = prog(t, k.kompass - 0.12, 0.8);
      place(flash, CX, 470, 0.4 + 1.2 * ease.out(f));
      show(flash, f > 0 ? 0.9 * (1 - f) : 0);
      const pop = spring(t - (k.kompass - 0.15), 190, 15);
      const up = ease.inOut(prog(t, k.turns - 0.35, 0.75));
      const s = lerp(1, 0.42, up);
      const lx = CX - (total * s) / 2;
      place(logo, lx, lerp(470 - 105, 46, up), s);
      logo.style.transformOrigin = "0 0";
      show(logo, clamp(pop * 3) * out);
      place(mark, 0, 0, 0.5 + 0.5 * Math.max(0, pop));
      mark.style.transformOrigin = "50% 50%";
      const wi = ease.out(prog(t, k.kompass - 0.05, 0.55));
      place(word, 254 + (1 - wi) * 40, 30);
      show(word, wi);
      const sw = ease.inOut(prog(t, k.human - 0.25, 0.4));
      l1.draw(t, { opacity: (1 - sw) * out, dy: -sw * 20 });
      l2.draw(t, { opacity: out });
    },
  };
};

/** The event stream: every event flows from the insights service into Kompass as it happens; then the replay re-ranks customers. */
SCENE.night = (sh) => {
  const k = sh.k;
  const root = h("div", "layer", L.scenes);
  const top = h("div", "abs", root, `<div style="display:flex;align-items:center;gap:26px">${icon("bolt", 92, "#ffe500", 1.8)}<div><div class="num" style="font:700 120px/1 var(--font);letter-spacing:-.04em">Live</div><div class="label" style="margin-top:12px">Every event, as it happens</div></div></div>`);
  const tw = top.getBoundingClientRect().width;
  const dbNode = h("div", "abs node", root, `<div class="big glass" style="border-radius:50%">${icon("db", 78, "#fff", 1.8)}</div><div class="t1">Insights service</div><div class="t2">12 datasets · 750 customers</div>`);
  const kNode = h("div", "abs node", root, `<div class="big mark" style="border-radius:36px">${NEEDLE(84)}</div><div class="t1">Kompass</div><div class="t2">every customer re-ranked</div>`);
  const svg = h("div", "abs", root, '<svg width="560" height="20" style="display:block"><path d="M10 10H550" stroke="rgba(255,255,255,.35)" stroke-width="4" stroke-dasharray="4 14" stroke-linecap="round" fill="none"/></svg>');
  const names = ["contracts", "charging", "tickets", "consents", "offers"];
  const packets = names.map((n) => h("div", "packet", root, n));
  const done = h("div", "abs tag", root, `${icon("check", 26, "#071431", 3)}<span>Re-evaluated as events happen</span>`);
  const dbW = 360;
  const kW = 360;
  [dbNode, kNode].forEach((n) => (n.style.width = `${dbW}px`));
  return {
    root,
    draw(t) {
      const out = 1 - ease.in(prog(t, k.out, 0.45));
      const a = ease.out(prog(t, k.night - LEAD, 0.5));
      place(top, CX - tw / 2, 140 + (1 - a) * 24);
      show(top, a * out);
      const b = ease.out(prog(t, k.reads - 0.2, 0.5));
      place(dbNode, 480 - dbW / 2, 470 + (1 - b) * 30);
      show(dbNode, b * out);
      const c = ease.out(prog(t, k.reads + 0.25, 0.5));
      place(kNode, 1440 - kW / 2, 470 + (1 - c) * 30);
      show(kNode, c * out);
      place(svg, 680, 535);
      show(svg, c * out);
      packets.forEach((p, i) => {
        const since = t - k.reads - i * 0.42;
        const q = since < 0 ? -1 : (since % (0.42 * names.length)) / 1.1;
        place(p, lerp(690, 1110, clamp(q)), 548 - 20 + Math.sin(clamp(q) * Math.PI) * -26);
        show(p, q >= 0 && q <= 1 ? Math.min(1, Math.sin(q * Math.PI) * 2.5) * out : 0);
      });
      const d = ease.out(prog(t, k.service + 0.15, 0.45));
      place(done, CX - 210, 850 + (1 - d) * 20);
      show(done, d * out);
    },
  };
};

/** "Remember Jan?": the failed charge from the opening comes back for a moment. */
SCENE.callback = (sh) => {
  const k = sh.k;
  const root = h("div", "layer", L.scenes);
  const q = h("div", "abs", root, 'Remember <span class="sun">Jan</span>?');
  Object.assign(q.style, { font: "800 120px/1 var(--font)", letterSpacing: "-0.035em", width: "1400px", left: "-700px", textAlign: "center" });
  const card = h("div", "abs glass notif", root, `<div class="ic">${icon("bolt", 34, "#ffe500", 2.2)}</div><div><div class="tt">Charging failed again</div><div class="bd">Please try another charge point.</div></div><div class="tm">17:24</div>`);
  card.style.left = "-320px";
  return {
    root,
    draw(t) {
      const out = 1 - ease.in(prog(t, k.out, 0.35));
      const a = ease.out(prog(t, k.label - LEAD, 0.45));
      place(q, CX, 330 + (1 - a) * 24);
      show(q, a * out);
      const c = ease.out(prog(t, k.t0, 0.5));
      const since = t - k.t0 - 0.35;
      const shake = since > 0 ? Math.sin(since * 55) * 12 * Math.exp(-since * 7) : 0;
      place(card, CX + shake, 560 + (1 - c) * 40, 0.96 + 0.04 * c);
      show(card, c * out);
    },
  };
};

/** Big statement in words, e.g. "Service / comes before / sales." or "But it can't send." */
SCENE.title = (sh) => {
  const root = h("div", "layer", L.scenes);
  const veil = h("div", "layer", root);
  veil.style.background = "rgba(7,20,49,0.78)";
  const lines = sh.lines.map((ln) => ({ ln, line: makeLine(root, ln.words, { size: ln.size, y: ln.y, gap: ln.gap ?? 0.26, weight: ln.weight }) }));
  const lock = sh.lock ? h("div", "abs", root, `<div style="width:150px;height:150px;border-radius:40px;background:#ffe500;display:grid;place-items:center;box-shadow:0 20px 60px rgba(0,0,0,.4)">${icon("lock", 84, "#071431", 2.4)}</div>`) : null;
  return {
    root,
    draw(t) {
      const out = 1 - ease.in(prog(t, sh.out, 0.35));
      show(veil, sh.veil ? sh.veil * ease.out(prog(t, sh.start, 0.3)) * out : 0);
      for (const { ln, line } of lines) {
        const st = line.draw(t, { opacity: out });
        ln.words.forEach((w, i) => {
          const e = line.els[i];
          if (w.slam) {
            const p = spring(t - (w.t - LEAD), 260, 16);
            e.style.transform += ` scale(${lerp(1.5, 1, clamp(p, 0, 1.2))})`;
            e.style.transformOrigin = "50% 60%";
            show(e, clamp(p * 4) * out);
          }
          if (w.shake && t > w.t) e.style.transform += ` translateX(${Math.sin((t - w.t) * 60) * 14 * Math.exp(-(t - w.t) * 8)}px)`;
          void st;
        });
      }
      if (lock) {
        const p = spring(t - (sh.lock.t - LEAD), 260, 14);
        place(lock, CX - 75, sh.lock.y - 75, Math.max(0, p));
        lock.style.transformOrigin = "50% 50%";
        show(lock, clamp(p * 3) * out);
      }
    },
  };
};

/** "And you can use AI to do everything." AI arrives big with the bubble's glow, shrinks as the words come,
 *  then turns into Kompass's cursor, which flies into the app. */
SCENE.ai = (sh) => {
  const k = sh.k;
  const root = h("div", "layer", L.scenes);
  const glowLine = makeLine(root, sh.words.map((w) => ({ ...w, cls: w.ai ? "grad" : "", text: w.ai ? w.text : "" })), { size: sh.size, y: sh.y, gap: 0.27, reflow: 0.42 });
  const line = makeLine(root, sh.words, { size: sh.size, y: sh.y, gap: 0.27, reflow: 0.42 });
  const ai = sh.words.findIndex((w) => w.ai);
  const ev = sh.words.findIndex((w) => w.hero);
  const glow = glowLine.els[ai];
  glow.style.filter = "blur(26px)";
  glow.style.opacity = 0.9;
  glowLine.els.forEach((e, i) => i !== ai && (e.style.display = "none"));
  const shine = h("div", "kw", root, sh.words[ev].text);
  Object.assign(shine.style, { fontSize: `${sh.size}px`, color: "transparent", backgroundImage: "linear-gradient(100deg, transparent 35%, rgba(255,255,255,.95) 50%, transparent 65%)", backgroundSize: "250% 100%", WebkitBackgroundClip: "text", backgroundClip: "text" });
  const under = h("div", "abs", root, '<svg width="600" height="60" viewBox="0 0 600 60" preserveAspectRatio="none" style="display:block;overflow:visible"><path d="M8 40 C 160 12, 420 12, 592 34" stroke="#ffe500" stroke-width="12" stroke-linecap="round" fill="none" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg>');
  const underPath = under.querySelector("path");
  const rays = Array.from({ length: 12 }, () => {
    const e = h("div", "abs", root);
    Object.assign(e.style, { width: "54px", height: "8px", borderRadius: "4px", background: "#ffe500", transformOrigin: "0 50%" });
    return e;
  });
  const ring = h("div", "abs", root);
  Object.assign(ring.style, { width: "200px", height: "200px", marginLeft: "-100px", marginTop: "-100px", borderRadius: "50%", border: "6px solid transparent", background: "var(--ring) border-box", backgroundSize: "300% 100%", webkitMask: "linear-gradient(#000 0 0) padding-box, linear-gradient(#000 0 0)", webkitMaskComposite: "xor" });
  const cur = h("div", "cursor ghost", root, `${GHOST_SVG}<span class="pill">Kompass</span>`);
  return {
    root,
    draw(t) {
      const morph = prog(t, k.morph, 0.45);
      const fade = 1 - ease.out(prog(t, k.morph, 0.25));
      const st = line.draw(t, {});
      // The other words leave when AI becomes the cursor.
      line.els.forEach((e, i) => {
        if (i === ai) return;
        show(e, parseFloat(e.style.opacity) * fade);
        if (morph > 0) e.style.transform += ` translateY(${-14 * ease.in(morph)}px)`;
      });
      // AI: the bubble's moving gradient and a glow behind it.
      const pos = `${(t * 45) % 300}% 0`;
      line.els[ai].classList.add("grad");
      line.els[ai].style.backgroundPosition = pos;
      const gst = glowLine.layout(t);
      void gst;
      const s = st[ai];
      const aiShrink = 1 - ease.inOut(prog(t, k.morph + 0.1, 0.35));
      const cx = s.x + (line.widths[ai] * s.s) / 2;
      const cy = sh.y - 0.42 * sh.size * s.s;
      if (morph > 0) {
        line.els[ai].style.transformOrigin = "50% 60%";
        line.els[ai].style.transform += ` scale(${lerp(1, 1.18, Math.sin(Math.PI * clamp(morph * 1.6)))})`;
        show(line.els[ai], s.p * aiShrink);
      }
      place(glow, s.x, sh.y - 0.855 * sh.size + (1 - s.p) * sh.size * 0.32, s.s);
      glow.style.backgroundPosition = pos;
      show(glow, 0.85 * s.p * aiShrink * (0.75 + 0.25 * Math.sin(t * 5)));
      // "everything": sun, a spring punch, a shine, an underline and a burst.
      const e = line.els[ev];
      const se = st[ev];
      e.classList.add("sun");
      e.style.textShadow = "0 0 40px rgba(255,229,0,.45)";
      const punch = spring(t - (sh.words[ev].t - LEAD), 230, 13);
      e.style.transformOrigin = "50% 60%";
      e.style.transform += ` scale(${lerp(1.55, 1, clamp(punch, 0, 1.3))})`;
      place(shine, se.x, sh.y - 0.855 * sh.size, se.s);
      shine.style.backgroundPosition = `${lerp(160, -60, ease.inOut(prog(t, sh.words[ev].t + 0.1, 0.7)))}% 0`;
      show(shine, parseFloat(e.style.opacity) * (t > sh.words[ev].t ? 1 : 0) * fade);
      const ew = line.widths[ev];
      Object.assign(under.style, { width: `${ew}px` });
      under.firstChild.setAttribute("width", ew);
      place(under, se.x, sh.y + 12);
      underPath.style.strokeDashoffset = 1 - ease.out(prog(t, sh.words[ev].t + 0.05, 0.4));
      show(under, (t > sh.words[ev].t ? 1 : 0) * fade);
      const ex = se.x + ew / 2;
      const ey = sh.y - 0.38 * sh.size;
      rays.forEach((r, i) => {
        const q = prog(t, sh.words[ev].t, 0.55);
        const ang = (i / rays.length) * Math.PI * 2;
        const rad = lerp(ew * 0.42, ew * 0.72, ease.out(q));
        place(r, ex + Math.cos(ang) * rad, ey + Math.sin(ang) * rad * 0.55, 1, ` rotate(${ang}rad) scaleX(${1 - q})`);
        show(r, q > 0 && q < 1 ? 1 - q : 0);
      });
      // AI turns into the cursor, which flies to where the app needs it.
      const rp = prog(t, k.morph + 0.12, 0.55);
      place(ring, cx, cy, 0.2 + 1.6 * ease.out(rp));
      ring.style.backgroundPosition = pos;
      show(ring, rp > 0 && rp < 1 ? 1 - rp : 0);
      const appear = spring(t - (k.morph + 0.12), 220, 16);
      const fly = ease.inOut(prog(t, k.fly, k.land - k.fly));
      if (t >= k.morph + 0.1 && t < k.land + 0.05) {
        const mx = lerp(cx, sh.landAt[0], fly);
        const my = lerp(cy, sh.landAt[1], fly) - Math.sin(Math.PI * fly) * 140;
        const sc = lerp(4.2 * clamp(appear, 0, 1.2), sh.landScale, fly);
        place(cur, mx - 4 * sc, my - 4 * sc, sc);
        show(cur, 1);
      } else show(cur, 0);
    },
  };
};

/** Kompass. Live data in. The next right step out. Humans in control. Then the end card. */
SCENE.close = (sh) => {
  const k = sh.k;
  const root = h("div", "layer", L.scenes);
  const logo = h("div", "abs", root);
  const mark = h("div", "abs mark", logo, NEEDLE(84));
  Object.assign(mark.style, { width: "150px", height: "150px" });
  const word = h("div", "abs wordmark", logo, "Kompass");
  word.style.fontSize = "112px";
  const ww = word.getBoundingClientRect().width;
  const total = 150 + 34 + ww;
  const rows = sh.rows.map((r) => {
    const e = h("div", "abs", root, `<div style="display:flex;align-items:center;gap:26px">${icon(r.icon, 58, r.color ?? "#ffe500", 2.2)}<div style="font:750 66px/1 var(--font);letter-spacing:-.02em">${r.html}</div></div>`);
    return { r, e, w: e.getBoundingClientRect().width };
  });
  const foot = h("div", "abs", root, sh.footer);
  Object.assign(foot.style, { font: "500 26px/1.5 var(--font)", color: "rgba(255,255,255,.6)", width: "1600px", left: "-800px", textAlign: "center" });
  return {
    root,
    draw(t) {
      const pop = spring(t - (k.kompass - LEAD), 200, 16);
      const lift = ease.inOut(prog(t, k.rows - 0.3, 0.6));
      place(logo, CX - total / 2, lerp(440, 190, lift) - 75);
      show(logo, clamp(pop * 3));
      place(mark, 0, 0, 0.5 + 0.5 * Math.max(0, pop));
      mark.style.transformOrigin = "50% 50%";
      place(word, 184 + (1 - ease.out(prog(t, k.kompass, 0.5))) * 30, 22);
      show(word, ease.out(prog(t, k.kompass, 0.5)));
      const left = Math.min(...rows.map((x) => CX - x.w / 2));
      rows.forEach(({ r, e }, i) => {
        const p = ease.out(prog(t, r.t - LEAD, 0.5));
        place(e, left + (1 - p) * 40, 430 + i * 118);
        show(e, p);
      });
      const f = ease.out(prog(t, k.footer, 0.6));
      place(foot, CX, 900 + (1 - f) * 16);
      show(foot, f);
    },
  };
};

/** "It works right on screen": four screens at once, each with Kompass at work. */
SCENE.wall = (sh) => {
  const root = h("div", "layer", L.scenes);
  const Z = 0.6;
  const tiles = sh.tiles.map((tl, i) => {
    const w = h("div", "win", root);
    const img = h("img", "", w);
    const cur = h("div", "cursor ghost", root, `${GHOST_SVG}<span class="pill">Kompass</span>`);
    const lab = h("div", "tile-label", root, esc(tl.label));
    const col = i % 2;
    const row = Math.floor(i / 2);
    return { tl, w, img, cur, lab, x: 172 + col * (1280 * Z + 40), y: 40 + row * (800 * Z + 40) };
  });
  return {
    root,
    draw(t) {
      const out = 1 - ease.in(prog(t, sh.out, 0.4));
      tiles.forEach((T, i) => {
        const a = ease.out(prog(t, sh.start + (T.tl.delay ?? i * 0.08), 0.5));
        const take = T.tl.from + (t - sh.start) * (T.tl.rate ?? 1);
        setImg(T.img, frameUrl(take * TL.take.fps));
        const s = Z * (0.92 + 0.08 * a);
        const ox = T.x + (1280 * Z * (1 - 0.92 - 0.08 * a)) / 2;
        const oy = T.y + (800 * Z * (1 - 0.92 - 0.08 * a)) / 2;
        place(T.w, ox, oy, s);
        T.w.style.borderRadius = "18px";
        show(T.w, a * out);
        const g = ghostAt(take);
        if (g) {
          place(T.cur, ox + g[0] * s, oy + g[1] * s, s * 1.5);
          show(T.cur, a * out);
        } else show(T.cur, 0);
        place(T.lab, ox + 18, oy + 18);
        show(T.lab, a * out);
      });
    },
  };
};

// ---------- captions ----------

const CAP = h("span", "", L.cap);
function drawCaptions(t) {
  const c = (TL.captions ?? []).find((x) => t >= x.start - 0.05 && t < x.end + 0.12);
  if (!c) return show(CAP, 0);
  if (CAP.textContent !== c.text) CAP.textContent = c.text;
  const o = Math.min(prog(t, c.start - 0.05, 0.15), 1 - prog(t, c.end, 0.12));
  CAP.style.transform = `translateY(${(1 - ease.out(prog(t, c.start - 0.05, 0.25))) * 10}px)`;
  show(CAP, o);
}

// ---------- entry points ----------

window.setup = (timeline) => {
  TL = timeline;
  noise = makeNoise();
  for (const sh of TL.shots) {
    const make = SCENE[sh.kind];
    if (!make) throw new Error(`unknown shot kind ${sh.kind}`);
    const sc = make(sh);
    sc.shot = sh;
    sc.root.style.display = "none";
    scenes.push(sc);
  }
  return { shots: scenes.length };
};

window.renderAt = async (t) => {
  pending = [];
  rippleN = 0;
  WIN.used = GH.used = HU.used = false;
  drawBackground(t, Math.round(t * TL.fps));
  for (const sc of scenes) {
    const s = sc.shot;
    const on = t >= s.start && t < s.end;
    sc.root.style.display = on ? "" : "none";
    if (on) sc.draw(t);
  }
  if (!WIN.used) WIN.root.style.display = "none";
  if (!GH.used) GH.el.style.display = "none";
  if (!HU.used) HU.el.style.display = "none";
  for (let i = rippleN; i < ripples.length; i++) ripples[i].style.display = "none";
  drawCaptions(t);
  await Promise.all(pending);
  return true;
};
