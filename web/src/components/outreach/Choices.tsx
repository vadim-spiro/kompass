// Step 1 choices: what to offer and when to send, as large option cards.
import clsx from "clsx";
import { CalendarClock, Clock, Gift, LifeBuoy, Sparkles, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { BestTimes, Campaign, CampaignTiming, TimeSlot, Vocabulary } from "../../../../shared/types";
import { fmtInt } from "../../lib/format";
import { AnimatePresence, EASE, motion } from "../motion";
import { Input, Skeleton } from "../ui";
import { joinWhen, plural, splitWhen } from "./copy";

function OptionCard({ icon: Icon, title, text, on, onClick, disabled }: { icon: LucideIcon; title: string; text: string; on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex items-start gap-2.5 rounded-xl border p-3 text-left transition-[border-color,background-color,box-shadow] disabled:cursor-default",
        on ? "border-navy-700 bg-navy-50 shadow-[0_0_0_1px_var(--color-navy-700)]" : "border-ink-200 bg-white hover:border-ink-300 hover:bg-ink-50/60",
      )}
    >
      <span className={clsx("mt-px grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors", on ? "bg-navy-900 text-white" : "bg-ink-100 text-ink-500")}>
        <Icon size={15} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium text-ink-900">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-ink-500">{text}</span>
      </span>
    </button>
  );
}

export function OfferChoice({ c, vocab, disabled, onChange }: { c: Pick<Campaign, "offerMode" | "offerIds">; vocab: Vocabulary | null; disabled?: boolean; onChange: (p: Pick<Campaign, "offerMode" | "offerIds">) => void }) {
  const offers = (vocab?.offers ?? []).filter((o) => !o.disabled && o.action_type !== "service");
  return (
    <div data-ai="offer-mode">
      <div className="grid grid-cols-3 gap-2">
        <OptionCard icon={Sparkles} title="Best offer per customer" text="The engine picks the offer with the highest expected CLV gain. Recommended." on={c.offerMode === "engine"} disabled={disabled} onClick={() => onChange({ offerMode: "engine", offerIds: c.offerIds })} />
        <OptionCard
          icon={Gift}
          title="A specific offer"
          text="Only this offer, only to customers who are eligible for it."
          on={c.offerMode === "pinned"}
          disabled={disabled}
          onClick={() => onChange({ offerMode: "pinned", offerIds: c.offerIds.length ? c.offerIds : offers[0] ? [offers[0].offer_id] : [] })}
        />
        <OptionCard icon={LifeBuoy} title="Service only" text="No sales. Solve the issue, refund or inform first." on={c.offerMode === "service"} disabled={disabled} onClick={() => onChange({ offerMode: "service", offerIds: c.offerIds })} />
      </div>
      <AnimatePresence initial={false}>
        {c.offerMode === "pinned" && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: EASE }} className="overflow-hidden">
            <div className="flex flex-wrap gap-1 pt-2.5">
              {offers.map((o) => {
                const on = c.offerIds.includes(o.offer_id);
                return (
                  <button
                    key={o.offer_id}
                    disabled={disabled}
                    onClick={() => onChange({ offerMode: "pinned", offerIds: on ? c.offerIds.filter((x) => x !== o.offer_id) : [...c.offerIds, o.offer_id] })}
                    className={clsx("rounded-md border px-2 py-0.5 text-[12.5px] transition-colors", on ? "border-navy-700 bg-navy-900 text-white" : "border-ink-200 bg-white text-ink-700 hover:bg-ink-50")}
                  >
                    {o.product_name}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Next working day at 09:00, as a datetime-local value. */
export function defaultSendAt() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T09:00`;
}

/** Date and time as plain German text (28.10.2026 and 09:00) in any browser language: two inputs instead of the native picker. */
function WhenField({ value, disabled, onChange }: { value: string; disabled?: boolean; onChange: (iso: string) => void }) {
  const [text, setText] = useState(() => splitWhen(value));
  // Follow the value when it changes from outside (the assistant sets a time), but not while a half-typed one is in the boxes.
  useEffect(() => {
    setText((prev) => (joinWhen(prev.date, prev.time) === value ? prev : splitWhen(value)));
  }, [value]);
  const iso = joinWhen(text.date, text.time);
  const set = (next: { date: string; time: string }) => {
    setText(next);
    const v = joinWhen(next.date, next.time);
    if (v) onChange(v);
  };
  return (
    <div
      onBlur={(e) => {
        // Leaving both boxes with something that is not a date and time puts the last good one back.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !iso) setText(splitWhen(value));
      }}
    >
      <div className="flex items-center gap-2">
        <Input value={text.date} disabled={disabled} maxLength={10} placeholder="dd.mm.yyyy" aria-label="Send date" aria-invalid={!iso} onChange={(e) => set({ ...text, date: e.target.value })} className={clsx("w-32", !iso && "border-bad-600/50")} />
        at
        <Input value={text.time} disabled={disabled} maxLength={5} placeholder="hh:mm" aria-label="Send time" aria-invalid={!iso} onChange={(e) => set({ ...text, time: e.target.value })} className={clsx("w-20", !iso && "border-bad-600/50")} />
      </div>
      {!iso && <p className="mt-1 text-[11.5px] text-bad-600">Write the date like 28.10.2026 and the time like 09:00.</p>}
      {iso && new Date(iso).getTime() < Date.now() && <p className="mt-1 text-[11.5px] text-warn-600">This time has already passed.</p>}
    </div>
  );
}

export function TimingChoice({ timing, best, disabled, onChange }: { timing: CampaignTiming; best: BestTimes | null | "loading"; disabled?: boolean; onChange: (t: CampaignTiming) => void }) {
  return (
    <div data-ai="timing">
      <div className="grid grid-cols-3 gap-2">
        <OptionCard icon={Zap} title="As soon as possible" text="Right after you press Send." on={timing.mode === "asap"} disabled={disabled} onClick={() => onChange({ mode: "asap" })} />
        <OptionCard icon={CalendarClock} title="Fixed date and time" text="Everyone at the same moment." on={timing.mode === "fixed"} disabled={disabled} onClick={() => onChange({ mode: "fixed", at: timing.at ?? defaultSendAt() })} />
        <OptionCard icon={Clock} title="Each customer's best time" text="When they are usually active: offers opened, charging, calls." on={timing.mode === "best"} disabled={disabled} onClick={() => onChange({ mode: "best" })} />
      </div>
      <AnimatePresence initial={false} mode="wait">
        {timing.mode === "fixed" && (
          <motion.div key="fixed" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: EASE }} className="overflow-hidden">
            <div className="flex items-start gap-2 pt-2.5 text-[12.5px] text-ink-600">
              <span className="pt-1.5">Send on</span>
              <WhenField value={timing.at ?? defaultSendAt()} disabled={disabled} onChange={(at) => onChange({ mode: "fixed", at })} />
            </div>
          </motion.div>
        )}
        {timing.mode === "best" && (
          <motion.div key="best" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: EASE }} className="overflow-hidden">
            <div className="pt-3">{best === "loading" || !best ? <Skeleton className="h-[150px] rounded-xl" /> : <BestTimeChart best={best} />}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const SLOT_COLOR: Record<TimeSlot, string> = { morning: "bg-sun-400", midday: "bg-navy-700/30", afternoon: "bg-navy-700/60", evening: "bg-navy-900" };
const slotOfHour = (h: number): TimeSlot => (h < 11 ? "morning" : h < 15 ? "midday" : h < 18 ? "afternoon" : "evening");

export function BestTimeChart({ best }: { best: BestTimes }) {
  const hours = best.hours.slice(6, 24);
  const max = Math.max(1, ...hours);
  return (
    <div className="rounded-xl border border-ink-200 bg-white p-4">
      <div className="text-[13px] font-medium text-ink-900">{best.headline}</div>
      <div className="mt-0.5 text-[11.5px] text-ink-500">
        Personal time for {fmtInt(best.withSignals)} of {plural(best.customers, "contact")} from their own activity; the rest get the most common time for their channel.
      </div>
      <div className="mt-3 flex h-16 items-end gap-[3px]">
        {hours.map((v, i) => (
          <div key={i} className="flex h-full flex-1 flex-col justify-end" title={`${i + 6}–${i + 7} h`}>
            <motion.div className={clsx("w-full rounded-t-[3px]", SLOT_COLOR[slotOfHour(i + 6)])} initial={{ height: 0 }} animate={{ height: `${Math.max(4, (v / max) * 100)}%` }} transition={{ duration: 0.5, ease: EASE, delay: i * 0.015 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-ink-400">
        <span>6 h</span>
        <span>12 h</span>
        <span>18 h</span>
        <span>24 h</span>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {best.slots.map((s) => (
          <div key={s.key} className="rounded-lg bg-ink-50 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-[11.5px] text-ink-500">
              <span className={clsx("h-2 w-2 rounded-full", SLOT_COLOR[s.key])} />
              {s.label} · {s.sendAt}
            </div>
            <div className="num mt-0.5 text-[15px] font-semibold text-ink-950">{fmtInt(s.customers)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
