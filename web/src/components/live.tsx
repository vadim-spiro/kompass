// Pieces of the live stream shown on several pages: a logged decision, one event, its flags.
import clsx from "clsx";
import { AlertTriangle, ArrowRight, Ban, ChevronDown, ChevronRight, Clock, Copy, Globe, Headset, Mail, MessageCircle, Phone, Shuffle, WifiOff, Zap, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { DeskItem, LiveAction, LiveDecision, LiveEvent, LiveFlag } from "../../../shared/types";
import { actionTypeLabel, fmtDelta } from "../lib/format";
import { Badge } from "./ui";

export const DESK_CHANNEL: Record<DeskItem["channel"], { icon: LucideIcon; label: string }> = {
  phone: { icon: Phone, label: "Phone" },
  chat: { icon: MessageCircle, label: "Chat" },
  email: { icon: Mail, label: "Email" },
  portal: { icon: Globe, label: "Portal form" },
  proactive: { icon: Headset, label: "Reach out" },
};

const FLAG: Record<LiveFlag, { label: (e: LiveEvent) => string; tint: "neutral" | "warn" | "violet" | "bad"; icon: LucideIcon; hint: string }> = {
  duplicate: { label: () => "Duplicate, dropped", tint: "neutral", icon: Copy, hint: "The same event id arrived twice; Kompass counts it once." },
  late: { label: (e) => `${lag(e.lagMin)} late`, tint: "warn", icon: Clock, hint: "Arrived long after it happened (batch or roaming delay). Kompass puts it in its place and decides again." },
  out_of_order: { label: () => "Out of order", tint: "violet", icon: Shuffle, hint: "Happened before an event Kompass already received. Facts are applied by when they happened." },
  device_offline: { label: () => "Device offline", tint: "bad", icon: WifiOff, hint: "The HEMS gateway is offline: its numbers are missing, not zero." },
};

export const lag = (min: number) => (min >= 120 ? `${Math.round(min / 60)} h` : `${min} min`);
export const hm = (at: string) => at.slice(11, 16);
const sameMinute = (a: string, b: string) => a.slice(0, 16) === b.slice(0, 16);
/** "10:14", or "02.10. 02:14" when it is not the replayed day. */
export const when = (at: string, day = "2026-10-01") => (at.startsWith(day) ? hm(at) : `${at.slice(8, 10)}.${at.slice(5, 7)}. ${hm(at)}`);

export function FlagBadges({ e }: { e: LiveEvent }) {
  return (
    <>
      {e.flags.map((f) => {
        const F = FLAG[f];
        return (
          <Badge key={f} tint={F.tint} title={F.hint}>
            <F.icon size={11} />
            {F.label(e)}
          </Badge>
        );
      })}
    </>
  );
}

export function EventRow({ e, name, compact }: { e: LiveEvent; name?: string; compact?: boolean }) {
  const dup = e.flags.includes("duplicate");
  return (
    <li className={clsx("flex gap-3 py-2", dup && "opacity-55")}>
      <div className="w-[52px] shrink-0 pt-0.5 text-right">
        <div className="num text-[12px] font-medium text-ink-800">{when(e.ingestedAt)}</div>
        {!sameMinute(e.ingestedAt, e.occurredAt) && <div className="num text-[10.5px] text-ink-400" title="When it happened">{when(e.occurredAt)}</div>}
      </div>
      <span className={clsx("mt-[7px] h-2 w-2 shrink-0 rounded-full", e.signal && !dup ? "bg-violet-600" : "bg-ink-200")} title={e.signal ? "Signal: Kompass decides again" : "Activity: updates what Kompass knows"} />
      <div className="min-w-0 flex-1">
        <div className={clsx("text-[12.5px] leading-snug", dup ? "text-ink-500 line-through decoration-ink-300" : "text-ink-800")}>
          {!compact && e.customerId && (
            <>
              <Link to={`/service/customers/${e.customerId}`} className="font-medium text-ink-900 hover:underline">
                {name ?? e.customerId}
              </Link>{" "}
              ·{" "}
            </>
          )}
          {e.label}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-500">
          <span>{SOURCE_LABEL[e.source] ?? e.source}</span>
          <FlagBadges e={e} />
        </div>
      </div>
    </li>
  );
}

export const SOURCE_LABEL: Record<string, string> = {
  portal: "Portal & app",
  autostrom_backend: "Autostrom",
  roaming_hub: "Roaming hub",
  hems_cloud: "HEMS cloud",
  newsletter_tool: "Newsletter tool",
  ticketing: "Ticket system",
  shop: "Shop",
  telephony: "Telephony",
  consent_mgmt: "Consent platform",
  billing_erp: "Billing ERP",
  telco_backend: "Telco backend",
  crm: "CRM",
};

export function ActionPill({ a, muted }: { a: LiveAction | null; muted?: boolean }) {
  if (!a) return <span className="rounded-md border border-dashed border-ink-200 px-2 py-1 text-[12px] text-ink-400">nothing worth offering</span>;
  return (
    <span className={clsx("inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[12px]", muted ? "border-ink-200 bg-ink-50 text-ink-500" : "border-navy-100 bg-navy-50/60 text-ink-900")}>
      <span className="truncate font-medium">{a.type === "service" ? "Service first" : a.product}</span>
      {a.type !== "service" && <span className={clsx("num shrink-0", a.dclvEur >= 0 ? "text-good-600" : "text-bad-600")}>{fmtDelta(a.dclvEur)}</span>}
    </span>
  );
}

/** One logged decision: what arrived, what Kompass concluded, the rules behind it. */
export function DecisionCard({ d, fresh, showCustomer = true, customerHref }: { d: LiveDecision; fresh?: boolean; showCustomer?: boolean; customerHref?: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const schedule = d.eventType === "schedule";
  const changed = d.before?.offerId !== d.after?.offerId;
  const href = customerHref ?? ((id: string) => `/customers/${id}`);
  return (
    <li className={clsx("rounded-xl border bg-white px-4 py-3 transition-colors", fresh ? "border-violet-600/40 ring-2 ring-violet-600/10" : "border-ink-200")}>
      <div className="flex items-start gap-3">
        <div className="w-[52px] shrink-0 pt-0.5 text-right">
          <div className="num text-[12.5px] font-semibold text-ink-900">{when(d.at)}</div>
          {!sameMinute(d.at, d.occurredAt) && (
            <div className="num text-[10.5px] text-warn-600" title="When it happened">
              {when(d.occurredAt)}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] text-ink-600">
            {showCustomer && !schedule && (
              <>
                <Link to={href(d.customerId)} className="font-semibold text-ink-900 hover:underline">
                  {d.customerName}
                </Link>{" "}
                <span className="text-ink-400">{d.customerId}</span> ·{" "}
              </>
            )}
            {d.eventLabel}
          </div>
          <div className="mt-1 flex items-start gap-1.5 text-[13.5px] font-medium leading-snug text-ink-950">
            <Zap size={14} className="mt-[3px] shrink-0 text-violet-600" />
            <span>{d.headline}</span>
          </div>
          {!schedule && (changed || d.after) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {changed && (
                <>
                  <ActionPill a={d.before} muted />
                  <ArrowRight size={13} className="text-ink-400" />
                </>
              )}
              <ActionPill a={d.after} />
              {d.after && d.after.type !== "service" && <span className="text-[11.5px] text-ink-500">{actionTypeLabel[d.after.type] ?? d.after.type}</span>}
            </div>
          )}
          {(d.cancelled.length > 0 || d.created.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {d.cancelled.length > 0 && (
                <Badge tint="bad">
                  <Ban size={11} /> {d.cancelled.length} queued message{d.cancelled.length > 1 ? "s" : ""} stopped
                </Badge>
              )}
              {d.created.length > 0 && (
                <Link to={`/?review=${d.created[0]}`} title="Open the draft for review">
                  <Badge tint="violet">
                    {d.created.length} draft{d.created.length > 1 ? "s" : ""} for approval
                  </Badge>
                </Link>
              )}
            </div>
          )}
          {(d.rules.length > 0 || d.blocked.length > 0) && (
            <button onClick={() => setOpen((v) => !v)} className="mt-2 flex items-center gap-1 text-[12px] font-medium text-ink-500 hover:text-ink-800">
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              Why: {d.rules.length} rule{d.rules.length === 1 ? "" : "s"}
              {d.blocked.length ? ` · ${d.blocked.length} offer${d.blocked.length === 1 ? "" : "s"} held back` : ""}
            </button>
          )}
          {open && (
            <div className="mt-2 space-y-2 rounded-lg bg-ink-50 px-3 py-2.5">
              <ul className="space-y-1">
                {d.rules.map((r, i) => (
                  <li key={i} className="text-[12px] leading-snug">
                    <span className="font-semibold text-ink-800">{r.rule}:</span> <span className="text-ink-600">{r.effect}</span>
                  </li>
                ))}
              </ul>
              {d.blocked.length > 0 && (
                <div>
                  <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Held back</div>
                  <ul className="space-y-0.5">
                    {d.blocked.map((b, i) => (
                      <li key={i} className="flex gap-1.5 text-[12px] text-ink-600">
                        <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn-600" />
                        <span>
                          <span className="font-medium text-ink-800">{b.product}</span>: {b.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
