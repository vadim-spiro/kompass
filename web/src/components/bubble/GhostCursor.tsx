// The cursor Kompass moves across the screen while it acts, and the glow on what it changed.
import { animate, AnimatePresence, motion, useMotionValue } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EASE } from "../motion";

interface Glow {
  id: number;
  target: string;
  el: HTMLElement;
  label: string;
}

let origin = { x: 0, y: 0 };
let visible = false;
let glows: Glow[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const pos = { x: 0, y: 0 };
let mover: ((x: number, y: number) => Promise<void>) | null = null;
let jumper: ((x: number, y: number) => void) | null = null;
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const find = (target: string) => document.querySelector<HTMLElement>(`[data-ai="${CSS.escape(target)}"]`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const cursor = {
  /** Where the cursor starts (the bubble). */
  setOrigin(x: number, y: number) {
    origin = { x, y };
    if (!visible) Object.assign(pos, origin);
  },
  /** Glides to the element with data-ai=target. Resolves when it arrived. */
  async pointAt(target: string) {
    const el = find(target);
    if (!el) return;
    const r0 = el.getBoundingClientRect();
    if (r0.top < 60 || r0.bottom > window.innerHeight - 140) {
      el.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
      await wait(reduced() ? 30 : 380);
    }
    const r = el.getBoundingClientRect();
    if (!visible) {
      // It appears at the bubble, not wherever it was parked before the bubble moved or first rendered.
      jumper?.(pos.x, pos.y);
      visible = true;
      notify();
      await wait(20);
    }
    await mover?.(r.left + Math.min(r.width / 2, 48), r.top + Math.min(r.height / 2, 22));
    await wait(120);
  },
  /** Rings the element briefly with a "Kompass" tag. */
  glow(target: string, label = "Kompass") {
    const el = find(target);
    if (!el) return;
    const g: Glow = { id: ++seq, target, el, label };
    glows = [...glows, g];
    notify();
    setTimeout(() => {
      glows = glows.filter((x) => x.id !== g.id);
      notify();
    }, 1900);
  },
  /** Returns to the bubble and fades out. */
  async park() {
    if (!visible) return;
    await mover?.(origin.x, origin.y);
    visible = false;
    notify();
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function GhostCursorLayer() {
  const shown = useSyncExternalStore(subscribe, () => visible);
  const list = useSyncExternalStore(subscribe, () => glows);
  const x = useMotionValue(pos.x);
  const y = useMotionValue(pos.y);
  const [, force] = useState(0);

  useEffect(() => {
    mover = async (tx, ty) => {
      const d = Math.hypot(tx - pos.x, ty - pos.y);
      const duration = reduced() ? 0 : Math.min(0.75, 0.3 + d / 2200);
      pos.x = tx;
      pos.y = ty;
      await Promise.all([animate(x, tx, { duration, ease: EASE }), animate(y, ty, { duration, ease: EASE })]);
    };
    jumper = (px, py) => {
      x.set(px);
      y.set(py);
    };
    force((n) => n + 1);
    return () => {
      mover = null;
      jumper = null;
    };
  }, [x, y]);

  return (
    <div className="pointer-events-none fixed inset-0 z-[60]">
      <AnimatePresence>
        {list.map((g) => (
          <GlowRing key={g.id} g={g} />
        ))}
      </AnimatePresence>
      <AnimatePresence>
        {shown && (
          <motion.div data-ghost="cursor" className="absolute left-0 top-0" style={{ x, y }} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={{ duration: 0.2 }}>
            <svg width="26" height="26" viewBox="0 0 24 24" className="-translate-x-[3px] -translate-y-[2px] drop-shadow-[0_2px_6px_rgba(91,33,182,0.35)]" aria-hidden>
              <path d="M4 2.5l15 8.2-6.6 1.6L9.2 19z" fill="#6d43d1" stroke="white" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
            <span className="absolute left-5 top-5 whitespace-nowrap rounded-full bg-violet-600 px-2 py-0.5 text-[10.5px] font-semibold text-white shadow">Kompass</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The ring follows its element while the page scrolls or re-renders around it. */
function GlowRing({ g }: { g: Glow }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let el = g.el;
    let raf = 0;
    const tick = () => {
      if (!el.isConnected) el = find(g.target) ?? el;
      const r = el.getBoundingClientRect();
      const st = ref.current?.style;
      if (st) Object.assign(st, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [g]);
  return (
    <motion.div
      ref={ref}
      className="absolute rounded-xl"
      initial={{ opacity: 0, boxShadow: "0 0 0 0px rgba(109,67,209,0.0)" }}
      animate={{ opacity: 1, boxShadow: ["0 0 0 0px rgba(109,67,209,0.45)", "0 0 0 6px rgba(109,67,209,0.18)", "0 0 0 3px rgba(109,67,209,0.28)"] }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.6, ease: EASE }}
    >
      <div className="absolute inset-0 rounded-xl ring-2 ring-violet-600/70" />
      <motion.span
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className="absolute -top-2.5 right-2 flex items-center gap-1 rounded-full bg-violet-600 px-2 py-[1px] text-[10.5px] font-semibold text-white shadow-sm"
      >
        <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" aria-hidden>
          <path d="M8 1l1.8 4.6L14.5 7l-4.7 1.6L8 13.5 6.2 8.6 1.5 7l4.7-1.4z" fill="currentColor" />
        </svg>
        {g.label}
      </motion.span>
    </motion.div>
  );
}
