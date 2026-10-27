// The live side panel of the guided outreach: who gets a message, who is held out, who is excluded
// and why, split by channel and tone, with sample customers. Numbers count to every new plan.
import clsx from "clsx";
import { Users } from "lucide-react";
import type { CampaignFull, NamedPlanRow } from "../../api/client";
import { fmtDelta, fmtInt, plainWhy } from "../../lib/format";
import { AnimatedNumber, AnimatePresence, EASE, motion } from "../motion";
import { Badge, Skeleton, Spinner } from "../ui";
import { channelName, skipList } from "./copy";

type Plan = NonNullable<CampaignFull["plan"]>;

/** What a customer's channel is called for the drafts: email and newsletter share one text, service contacts are calls. */
const draftChannel = (key: string) => (key === "newsletter" ? "email" : key === "service_contact" ? "outbound_call" : key);

/** Contacts per draft channel (newsletter counted with email, service contacts with calls), biggest first. */
export function channelGroups(plan: Plan | undefined) {
  const m = new Map<string, number>();
  for (const ch of plan?.summary.by_channel ?? []) m.set(draftChannel(ch.key), (m.get(draftChannel(ch.key)) ?? 0) + ch.contacts);
  return [...m.entries()].map(([key, contacts]) => ({ key, contacts })).sort((a, b) => b.contacts - a.contacts);
}

/** Contacts per plan channel as the channel switches know them: newsletter apart from email, service calls on their own. */
export function channelCounts(plan: Plan | undefined) {
  const m = new Map<string, number>();
  for (const ch of plan?.summary.by_channel ?? []) m.set(ch.key, (m.get(ch.key) ?? 0) + ch.contacts);
  return m;
}

function Bar({ label, value, total, tint = "bg-navy-700" }: { label: string; value: number; total: number; tint?: string }) {
  return (
    <div className="text-[12.5px]">
      <div className="flex justify-between gap-2">
        <span className="truncate text-ink-700">{label}</span>
        <AnimatedNumber value={value} className="shrink-0 text-ink-500" />
      </div>
      <div className="mt-0.5 h-1.5 rounded-full bg-ink-100">
        <motion.div className={clsx("h-1.5 rounded-full", tint)} initial={false} animate={{ width: `${total ? Math.max(2, (value / total) * 100) : 0}%` }} transition={{ duration: 0.6, ease: EASE }} />
      </div>
    </div>
  );
}

export function AudiencePanel({ plan, planning, label, onOpenCustomer, footer }: { plan?: Plan; planning: boolean; label?: string; onOpenCustomer?: (id: string) => void; footer?: React.ReactNode }) {
  if (!plan)
    return planning ? (
      <div className="space-y-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    ) : (
      <div className="flex flex-col items-center px-4 py-10 text-center">
        <span className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-ink-100 text-ink-500">
          <Users size={18} />
        </span>
        <div className="text-[13.5px] font-medium text-ink-900">Pick an audience</div>
        <div className="mt-1 text-[12.5px] text-ink-500">You will see right here who gets a message, who is held out to measure the effect, and who is left out and why.</div>
      </div>
    );
  const s = plan.summary;
  // Newsletter stays apart from email here, like the switches in "Which channels may we use?".
  const counts = channelCounts(plan);
  const byChannel = new Map<string, number>();
  for (const [key, n] of counts) {
    const k = key === "service_contact" ? "outbound_call" : key;
    byChannel.set(k, (byChannel.get(k) ?? 0) + n);
  }
  const channels = [...byChannel].map(([key, contacts]) => ({ key, contacts })).sort((a, b) => b.contacts - a.contacts);
  const serviceCalls = counts.get("service_contact") ?? 0;
  const reasons = skipList(s, 7);
  const sie = s.by_tone.find((t) => t.key.toLowerCase() === "sie")?.contacts ?? 0;
  const du = s.by_tone.find((t) => t.key.toLowerCase() === "du")?.contacts ?? 0;
  const sample = plan.rows.filter((r) => r.status === "contact").slice(0, 5);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-400">Your audience</div>
        <AnimatePresence>
          {planning && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-1.5 text-[12px] text-ink-500">
              <Spinner /> Updating
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      {label && <div className="-mt-3 text-[13px] font-medium text-ink-800">{label}</div>}

      <div className={clsx("rounded-xl bg-navy-950 p-4 text-white transition-opacity", planning && "opacity-80")}>
        <div className="flex items-end justify-between gap-3">
          <div>
            <AnimatedNumber value={s.contacts} className="text-[34px] font-semibold leading-none tracking-tight" />
            <div className="mt-1 text-[12px] text-white/60">{s.contacts === 1 ? "gets a message" : "get a message"}</div>
          </div>
          <div className="text-right">
            <AnimatedNumber value={s.expected_dclv_eur} format={(n) => fmtDelta(Math.round(n))} className="text-[17px] font-semibold text-sun-400" />
            <div className="mt-0.5 text-[11.5px] text-white/60">expected CLV gain</div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/10 pt-3 text-[12px]">
          <div>
            <AnimatedNumber value={s.audience} className="text-[14px] font-semibold" />
            <div className="text-white/55">in audience</div>
          </div>
          <div>
            <AnimatedNumber value={s.control} className="text-[14px] font-semibold" />
            <div className="text-white/55">control group</div>
          </div>
          <div>
            <AnimatedNumber value={s.skipped} className="text-[14px] font-semibold" />
            <div className="text-white/55">left out</div>
          </div>
        </div>
      </div>
      <p className="-mt-2 text-[11.5px] leading-snug text-ink-500">The control group gets nothing, so we can measure what the campaign really changed.</p>

      {channels.length > 0 && (
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-ink-600">By channel</div>
          <div className="space-y-1.5">
            {channels.map((ch) => (
              <Bar key={ch.key} label={channelName(ch.key)} value={ch.contacts} total={s.contacts} />
            ))}
          </div>
          {serviceCalls > 0 && (
            <p className="mt-1.5 text-[11.5px] text-ink-500">
              Of the calls, {fmtInt(serviceCalls)} {serviceCalls === 1 ? "is a service call" : "are service calls"} about an open problem.
            </p>
          )}
        </div>
      )}
      {sie + du > 0 && (
        <div>
          <div className="mb-1.5 flex justify-between text-[12px] font-medium text-ink-600">
            <span>Sie {fmtInt(sie)}</span>
            <span>Du {fmtInt(du)}</span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-ink-100">
            <motion.div className="h-full bg-navy-700" initial={false} animate={{ width: `${(sie / (sie + du)) * 100}%` }} transition={{ duration: 0.6, ease: EASE }} />
            <motion.div className="h-full bg-violet-600" initial={false} animate={{ width: `${(du / (sie + du)) * 100}%` }} transition={{ duration: 0.6, ease: EASE }} />
          </div>
        </div>
      )}

      {reasons.length > 0 && (
        <div>
          <div className="mb-1.5 flex justify-between gap-2 text-[12px] font-medium text-ink-600">
            <span>Left out, and why</span>
            <span className="num text-ink-500">{fmtInt(s.skipped)} in total</span>
          </div>
          <ul className="space-y-1 text-[12.5px]">
            {reasons.map(([r, n]) => (
              <li key={r} className="flex justify-between gap-2">
                <span className="text-ink-700">{r}</span>
                <AnimatedNumber value={n} className="shrink-0 text-ink-500" />
              </li>
            ))}
          </ul>
        </div>
      )}

      {sample.length > 0 && (
        <div>
          <div className="mb-1.5 flex justify-between gap-2 text-[12px] font-medium text-ink-600">
            <span>For example</span>
            <span className="num text-ink-500">
              {fmtInt(sample.length)} of {fmtInt(s.contacts)}
            </span>
          </div>
          <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200">
            <AnimatePresence initial={false}>
              {sample.map((r: NamedPlanRow) => (
                <motion.li
                  key={r.customer_id}
                  layout
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25, ease: EASE }}
                  onClick={() => onOpenCustomer?.(r.customer_id)}
                  className={clsx("px-3 py-2", onOpenCustomer && "cursor-pointer hover:bg-ink-50")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12.5px] font-medium text-ink-900">{r.name}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {r.action?.channel && <span className="text-[11.5px] text-ink-500">{channelName(r.action.channel)}</span>}
                      {r.tonality && <Badge tint={r.tonality === "du" ? "violet" : "navy"}>{r.tonality === "du" ? "Du" : "Sie"}</Badge>}
                    </span>
                  </div>
                  {r.action && (
                    <div className="mt-0.5 line-clamp-1 text-[11.5px] text-ink-500" title={plainWhy(r.action.reason)}>
                      <span className="text-ink-700">{r.action.product_name}</span> · {plainWhy(r.action.reason)}
                    </div>
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>
      )}
      {footer}
    </div>
  );
}
