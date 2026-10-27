// What Kompass is doing right now: one line per step, ticking off as it goes.
import { Check, Loader2, MousePointer2, Square, XCircle } from "lucide-react";
import type { ChatToolCall } from "../../../../shared/types";
import { forwardRef } from "react";
import { AnimatePresence, EASE, motion } from "../motion";

export type LiveCall = ChatToolCall & { running: boolean };

/** Forwards its ref: AnimatePresence in popLayout mode measures the card while it leaves. */
export const ActivityCard = forwardRef<HTMLDivElement, { request: string; calls: LiveCall[]; onStop: () => void; inline?: boolean }>(function ActivityCard({ request, calls, onStop, inline }, ref) {
  const thinking = !calls.some((c) => c.running);
  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={{ duration: 0.28, ease: EASE }}
      className={
        inline
          ? "overflow-hidden rounded-xl border border-violet-600/15 bg-violet-50/40"
          : "pointer-events-auto w-[min(440px,calc(100vw-100px))] overflow-hidden rounded-2xl border border-white/60 bg-white/90 shadow-[0_12px_40px_-12px_rgba(30,20,80,0.35)] backdrop-blur-xl"
      }
    >
      <div className="flex items-center gap-2 border-b border-ink-100/80 px-3.5 py-2">
        <span className="relative grid h-5 w-5 place-items-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-violet-600/25" />
          <span className="h-2 w-2 rounded-full bg-violet-600" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-600">{request}</span>
        <button onClick={onStop} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-ink-500 hover:bg-ink-100 hover:text-ink-900">
          <Square size={9} fill="currentColor" /> Stop
        </button>
      </div>
      <ul className="max-h-[220px] space-y-0.5 overflow-y-auto px-3.5 py-2 scroll-thin">
        <AnimatePresence initial={false}>
          {calls.map((c) => (
            <motion.li
              key={c.id}
              layout
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.22, ease: EASE }}
              className="flex items-start gap-2 py-0.5 text-[12.5px]"
            >
              <span className="mt-[3px] shrink-0">
                {c.running ? <Loader2 size={13} className="animate-spin text-violet-600" /> : c.ok ? <Check size={13} className="text-good-600" /> : <XCircle size={13} className="text-bad-600" />}
              </span>
              <span className="min-w-0">
                <span className={c.running ? "font-medium text-ink-900" : "text-ink-700"}>
                  {c.label ?? c.name}
                  {c.ui && <MousePointer2 size={11} className="mb-0.5 ml-1 inline text-violet-600" />}
                </span>
                {!c.running && c.summary && <span className="text-ink-400"> · {c.summary}</span>}
              </span>
            </motion.li>
          ))}
        </AnimatePresence>
        {thinking && (
          <li className="flex items-center gap-2 py-0.5 text-[12.5px] text-ink-500">
            <span className="flex gap-0.5">
              {[0, 1, 2].map((i) => (
                <motion.span key={i} className="h-1.5 w-1.5 rounded-full bg-violet-600/70" animate={{ opacity: [0.25, 1, 0.25] }} transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }} />
              ))}
            </span>
            {calls.length ? "Deciding the next step" : "Reading the screen"}
          </li>
        )}
      </ul>
    </motion.div>
  );
});
