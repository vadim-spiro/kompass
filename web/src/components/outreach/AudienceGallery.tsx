// Step 1 of the guided outreach: ready-made audiences as cards, grouped like the insights service's
// own pages (biggest risk, pains, guarantee calendar, savings, best offer).
import clsx from "clsx";
import { CalendarClock, Check, Gift, MessageCircleWarning, PiggyBank, TrendingDown, type LucideIcon } from "lucide-react";
import { useState } from "react";
import type { AudienceCard, AudienceGroup } from "../../../../shared/types";
import { fmtEur, fmtInt } from "../../lib/format";
import { AnimatePresence, EASE, motion, spring } from "../motion";
import { Skeleton } from "../ui";

export const GROUPS: { key: AudienceGroup; label: string; hint: string; icon: LucideIcon }[] = [
  { key: "risk", label: "Biggest risk", hint: "Segments and churn signals, by value at risk", icon: TrendingDown },
  { key: "pains", label: "Pains", hint: "What customers called or wrote about", icon: MessageCircleWarning },
  { key: "guarantee", label: "Guarantee ending", hint: "Whose price guarantee runs out, month by month", icon: CalendarClock },
  { key: "savings", label: "Can save money", hint: "Honest savings, from the customer's own data first", icon: PiggyBank },
  { key: "offers", label: "Best offer", hint: "Customers whose best next step is this offer", icon: Gift },
];
const FIRST = 9;

export function AudienceGallery({
  cards,
  group,
  onGroup,
  selected,
  onPick,
  disabled,
}: {
  cards: AudienceCard[] | null;
  group: AudienceGroup;
  onGroup: (g: AudienceGroup) => void;
  selected?: string;
  onPick: (c: AudienceCard) => void;
  disabled?: boolean;
}) {
  const [all, setAll] = useState(false);
  const inGroup = (cards ?? []).filter((c) => c.group === group);
  // The chosen card stays visible even when it is beyond the first nine.
  const shown = all ? inGroup : inGroup.filter((c, i) => i < FIRST || c.id === selected);
  const max = Math.max(1, ...inGroup.map((c) => c.metric.eur));
  const meta = GROUPS.find((g) => g.key === group)!;

  return (
    <div>
      <div data-ai="audience-tabs" className="flex flex-wrap gap-1.5">
        {GROUPS.map((g) => {
          const n = (cards ?? []).filter((c) => c.group === g.key).length;
          const on = g.key === group;
          return (
            <button
              key={g.key}
              onClick={() => {
                onGroup(g.key);
                setAll(false);
              }}
              className={clsx("relative flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors", on ? "text-white" : "text-ink-600 hover:bg-ink-100")}
            >
              {on && <motion.span layoutId="audience-tab" className="absolute inset-0 rounded-full bg-navy-900" transition={spring} />}
              <g.icon size={14} className="relative" />
              <span className="relative">{g.label}</span>
              {cards && <span className={clsx("num relative text-[11.5px]", on ? "text-white/60" : "text-ink-400")}>{n}</span>}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[12px] text-ink-500">{meta.hint}</p>

      {!cards ? (
        <div className="mt-3 grid grid-cols-3 gap-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[132px] rounded-xl" />
          ))}
        </div>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={group}
            className="mt-3 grid grid-cols-3 gap-3"
            initial="hidden"
            animate="show"
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.035 } } }}
          >
            {shown.map((c) => (
              <AudienceCardView key={c.id} card={c} max={max} selected={c.id === selected} disabled={disabled} onPick={() => onPick(c)} />
            ))}
          </motion.div>
        </AnimatePresence>
      )}
      {cards && inGroup.length > shown.length && (
        <button onClick={() => setAll(true)} className="mt-2.5 text-[12.5px] font-medium text-navy-700 hover:underline">
          Show all {inGroup.length}
        </button>
      )}
    </div>
  );
}

function AudienceCardView({ card, max, selected, disabled, onPick }: { card: AudienceCard; max: number; selected: boolean; disabled?: boolean; onPick: () => void }) {
  const reach = card.reachable != null && card.customers ? card.reachable / card.customers : null;
  return (
    <motion.button
      data-ai={`audience-card:${card.id}`}
      disabled={disabled}
      onClick={onPick}
      variants={{ hidden: { opacity: 0, y: 10, scale: 0.98 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.32, ease: EASE } } }}
      whileHover={disabled ? undefined : { y: -2 }}
      whileTap={disabled ? undefined : { scale: 0.985 }}
      className={clsx(
        "relative flex min-h-[132px] flex-col rounded-xl border bg-white p-3.5 text-left transition-[border-color,box-shadow] disabled:cursor-default",
        selected ? "border-navy-700 shadow-[0_0_0_1px_var(--color-navy-700),0_8px_24px_-12px_rgba(10,42,102,0.45)]" : "border-ink-200 hover:border-ink-300 hover:shadow-sm",
      )}
    >
      <AnimatePresence>
        {selected && (
          <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={spring} className="absolute right-2.5 top-2.5 grid h-5 w-5 place-items-center rounded-full bg-navy-900 text-white">
            <Check size={12} strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
      <div className="pr-6 text-[13.5px] font-semibold leading-snug text-ink-950">{card.title}</div>
      <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-500">{card.description}</div>
      <div className="mt-auto pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] text-ink-500">
            <b className="num text-[15px] font-semibold text-ink-950">{fmtInt(card.customers)}</b> {card.customers === 1 ? "customer" : "customers"}
          </span>
          <span className="num text-[12px] text-ink-600" title={card.metric.label}>
            {fmtEur(card.metric.eur)} <span className="text-ink-400">{card.metric.label.replace("value at risk", "at risk")}</span>
          </span>
        </div>
        <div className="mt-1.5 h-1 rounded-full bg-ink-100">
          <motion.div
            className={clsx("h-1 rounded-full", card.group === "savings" ? "bg-good-600" : card.group === "offers" ? "bg-violet-600" : "bg-navy-700")}
            initial={{ width: 0 }}
            animate={{ width: `${Math.max(3, (card.metric.eur / max) * 100)}%` }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.1 }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-ink-400">
          <span>{reach != null ? `${Math.round(reach * 100)} % reachable` : card.churnAvg != null ? `churn ${Math.round(card.churnAvg * 100)} %` : ""}</span>
          {card.basis === "assumption" && <span>estimate</span>}
          {card.offerMode === "service" && <span className="text-good-600">service first</span>}
        </div>
      </div>
    </motion.button>
  );
}
