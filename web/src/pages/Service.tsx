// Service mode: the desk an agent works from. Calls, chats, tickets and the cases Kompass wants
// someone to reach out about arrive from the live stream; picking one opens the customer as the
// agent needs them: who they are, why they are here, what to do now and what not to offer.
import clsx from "clsx";
import { ArrowLeft, Ban, Check, CheckCircle2, ChevronDown, ChevronRight, Frown, Headset, Mail, MessageSquare, MonitorSmartphone, Phone, Play, ShieldAlert, ThumbsDown, UserCheck, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Customer360, DeskItem, FeedbackAction, LiveAction, LiveCustomer } from "../../../shared/types";
import { api } from "../api/client";
import { DecisionCard, DESK_CHANNEL, EventRow, when } from "../components/live";
import { AnimatePresence, motion } from "../components/motion";
import { ActionTypeBadge, Badge, Button, Card, Empty, ErrorNote, PageBar, Segmented, Skeleton, ToneBadge } from "../components/ui";
import { beforeDay, clockLabel, useLive } from "../lib/live";
import { chLabel, fmtDelta, fmtEur, fmtPct, humanize, plainWhy } from "../lib/format";
import { useScreen } from "../lib/screen";
import { emitDataChanged } from "../lib/useAsync";
import { CustomersPage } from "./Customers";

type QueueFilter = "waiting" | "done";

export function ServiceDeskPage() {
  const live = useLive();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<QueueFilter>("waiting");
  const desk = live.state?.desk ?? [];
  const items = useMemo(
    () =>
      desk
        .filter((d) => d.status === filter)
        .sort((a, b) => (a.priority === b.priority ? (a.mood === b.mood ? b.at.localeCompare(a.at) : a.mood === "upset" ? -1 : 1) : a.priority === "high" ? -1 : 1)),
    [desk, filter],
  );
  const selectedId = params.get("item");
  const selected = desk.find((d) => d.id === selectedId) ?? items[0];
  const waiting = desk.filter((d) => d.status === "waiting").length;

  useScreen("service", {
    view: "service",
    title: selected ? `Service desk · ${selected.customerName}` : "Service desk",
    data: { waiting, selected: selected ? { customer: selected.customerId, channel: selected.channel, topic: selected.topic, mood: selected.mood } : null },
  });

  return (
    <>
      <PageBar
        title="Service desk"
        subtitle={
          live.state && !beforeDay(live.state)
            ? `${waiting} waiting · ${clockLabel(live.state.clock)} · calls, chats, tickets and cases Kompass wants someone to reach out about`
            : "Calls, chats, tickets and cases Kompass wants someone to reach out about, as the day's events arrive"
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[340px] shrink-0 flex-col border-r border-ink-200/80 bg-white/60">
          <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-2.5">
            <Segmented
              value={filter}
              options={[
                { value: "waiting", label: `Waiting · ${waiting}` },
                { value: "done", label: `Done · ${desk.length - waiting}` },
              ]}
              onChange={setFilter}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
            {live.state && beforeDay(live.state) ? (
              <div className="p-5">
                <Empty icon={Headset} title="The desk is quiet" hint="It fills as the 01.10. events arrive: calls with their transcripts, tickets, cancellations, failed charging." />
                <div className="mt-4 flex justify-center">
                  <Button variant="primary" icon={Play} onClick={live.play}>
                    Play the live stream
                  </Button>
                </div>
              </div>
            ) : items.length === 0 ? (
              <p className="p-6 text-center text-[13px] text-ink-400">{filter === "waiting" ? "Nobody waiting right now." : "Nothing closed yet."}</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                <AnimatePresence initial={false}>
                  {items.map((d) => (
                    <motion.li key={d.id} layout initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.22 }}>
                      <QueueRow d={d} active={d.id === selected?.id} onClick={() => setParams({ item: d.id }, { replace: true })} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto page-scroll scroll-thin">
          {selected ? <AgentView key={selected.customerId} customerId={selected.customerId} item={selected} /> : <div className="p-10 text-center text-[13px] text-ink-400">Pick someone from the queue.</div>}
        </div>
      </div>
    </>
  );
}

function QueueRow({ d, active, onClick }: { d: DeskItem; active: boolean; onClick: () => void }) {
  const ch = DESK_CHANNEL[d.channel];
  return (
    <button onClick={onClick} className={clsx("flex w-full gap-3 px-4 py-3 text-left transition-colors", active ? "bg-navy-50/70" : "hover:bg-ink-50")}>
      <span className={clsx("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full", d.mood === "upset" ? "bg-bad-50 text-bad-600" : d.channel === "proactive" ? "bg-violet-50 text-violet-600" : "bg-navy-50 text-navy-800")} title={ch.label}>
        <ch.icon size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13.5px] font-semibold text-ink-900">{d.customerName}</span>
          {d.priority === "high" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-bad-600" title="High priority" />}
          <span className="num ml-auto shrink-0 text-[11.5px] text-ink-500">{when(d.at)}</span>
        </span>
        <span className="block truncate text-[12.5px] text-ink-700">{d.topic}</span>
        <span className="mt-1 flex flex-wrap gap-1">
          <Badge tint="neutral">{ch.label}</Badge>
          {d.mood === "upset" && (
            <Badge tint="bad">
              <Frown size={11} /> Upset
            </Badge>
          )}
          {d.status === "done" && d.outcome && <Badge tint="good">{d.outcome}</Badge>}
        </span>
      </span>
    </button>
  );
}

/** A customer as the agent needs them. With a desk item it starts from why they are here. */
export function AgentView({ customerId, item }: { customerId: string; item?: DeskItem }) {
  const live = useLive();
  const [c360, setC360] = useState<Customer360 | null>(null);
  const [lc, setLc] = useState<LiveCustomer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.customer360(customerId), api.liveCustomer(customerId)]).then(
      ([a, b]) => {
        setC360(a);
        setLc(b);
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
  }, [customerId]);
  useEffect(load, [load]);
  // A new decision for this customer (from the stream or an agent's feedback) refreshes the view.
  const freshForMe = live.fresh.some((d) => d.customerId === customerId);
  useEffect(() => {
    if (freshForMe) load();
  }, [freshForMe, load]);

  const feedback = async (a: LiveAction, action: FeedbackAction) => {
    try {
      await api.liveFeedback({ customerId, offerId: a.offerId, product: a.product, action, deskItemId: item?.id });
      setNote(FEEDBACK_NOTE[action](a.type === "service" ? "the service step" : a.product));
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !c360) return <ErrorNote error={error} className="m-6" />;
  if (!c360 || !lc) return <div className="space-y-4 p-6"><Skeleton className="h-28" /><Skeleton className="h-48" /><Skeleton className="h-40" /></div>;

  const s = c360.profile.summary;
  const policy = c360.profile.contact_policy;
  const tone = (policy.salutation === "Du" ? "du" : "sie") as "du" | "sie";
  const openCases = c360.problems.filter((p) => p.severity !== "low").length;
  const withdrawn = lc.facts?.withdrawn ?? [];
  const consentChannels = ["email", "newsletter", "sms", "outbound_call", "portal_popup"];

  return (
    <div className="mx-auto max-w-[980px] space-y-4 px-6 py-5">
      <ErrorNote error={error} />
      {/* Who */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[20px] font-semibold tracking-tight text-ink-950">{c360.identity.name}</h2>
              <ToneBadge tone={tone} source={policy.tone_observed ? "detected" : "default"} />
              <span className="text-[12px] text-ink-500">{policy.tone_observed ? `writes to us in the ${tone === "du" ? "Du" : "Sie"} form` : "no messages from them yet"}</span>
            </div>
            <div className="mt-0.5 text-[12.5px] text-ink-500">
              {s.customer_id} · {c360.identity.city}
              {s.tenure_years != null ? ` · customer for ${Math.round(s.tenure_years)} ${Math.round(s.tenure_years) === 1 ? "year" : "years"}` : ""} · synthetic name
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {s.products.map((p) => (
                <Badge key={p} tint="navy">
                  {p}
                </Badge>
              ))}
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-5 text-right">
            <Mini label="Customer value" value={s.clv_eur != null ? fmtEur(s.clv_eur) : "–"} />
            <Mini label="Churn risk" value={s.churn_prob_12m != null ? fmtPct(s.churn_prob_12m) : "–"} tone={(s.churn_prob_12m ?? 0) >= 0.3 ? "bad" : undefined} />
            <Mini label="Open cases" value={String(openCases)} tone={openCases ? "warn" : undefined} />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ink-100 pt-3 text-[12px]">
          <span className="text-ink-500">May contact by</span>
          {consentChannels.map((ch) => {
            const ok = lc.allowedChannels.includes(ch);
            return (
              <span key={ch} className={clsx("inline-flex items-center gap-1", ok ? "text-ink-800" : "text-ink-400 line-through")} title={ok ? "Consent given" : "No consent"}>
                <ChannelIcon channel={ch} />
                {chLabel(ch)}
              </span>
            );
          })}
          {withdrawn.length > 0 && <Badge tint="bad">Withdrew {withdrawn.map((w) => humanize(w).toLowerCase()).join(", ")} today</Badge>}
          {lc.salesBlockers.map((b) => (
            <Badge key={b} tint="bad">
              <ShieldAlert size={11} /> No sales: {b}
            </Badge>
          ))}
        </div>
      </Card>

      {/* Why they are here */}
      {item && (
        <WhyHere
          item={item}
          onDone={() => {
            // "Solved" can lift a block: reload the desk, this customer and the approvals.
            live.reload();
            load();
            emitDataChanged();
          }}
        />
      )}

      {note && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 rounded-lg bg-good-50 px-3 py-2 text-[13px] text-good-600">
          <CheckCircle2 size={15} /> {note}
        </motion.div>
      )}

      {/* What to do now */}
      <Card>
        <div className="border-b border-ink-100 px-5 py-3">
          <h3 className="text-[15px] font-semibold text-ink-900">What to do now</h3>
          <p className="mt-0.5 text-[12.5px] text-ink-500">Ranked by expected value for the customer relationship, with today's events applied. Tell Kompass how it went: it learns from it.</p>
        </div>
        {lc.actions.length === 0 ? (
          <p className="px-5 py-5 text-[13px] text-ink-500">Nothing worth offering. Help with what they came for and leave it there.</p>
        ) : (
          <ol className="divide-y divide-ink-100">
            {lc.actions.slice(0, 4).map((a, i) => (
              <ActionRow key={a.offerId} a={a} rank={i + 1} onFeedback={(act) => feedback(a, act)} />
            ))}
          </ol>
        )}
        {lc.blocked.length > 0 && (
          <div className="border-t border-ink-100 bg-ink-50/60 px-5 py-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-500">
              <Ban size={12} /> Don't offer
            </div>
            <ul className="grid gap-x-6 gap-y-1 @container sm:grid-cols-2">
              {lc.blocked.slice(0, 8).map((b, i) => (
                <li key={i} className="text-[12.5px] text-ink-600">
                  <span className="font-medium text-ink-800">{b.product}</span>: {b.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="border-b border-ink-100 px-5 py-3">
            <h3 className="text-[14px] font-semibold text-ink-900">Today, as it arrived</h3>
          </div>
          {lc.events.length === 0 ? (
            <p className="px-5 py-5 text-[13px] text-ink-400">Nothing from this customer today{live.state && beforeDay(live.state) ? " yet: the stream has not started" : ""}.</p>
          ) : (
            <ul className="max-h-[320px] divide-y divide-ink-100 overflow-y-auto px-4 scroll-thin">
              {[...lc.events].reverse().map((e) => (
                <EventRow key={e.id} e={e} compact />
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <div className="border-b border-ink-100 px-5 py-3">
            <h3 className="text-[14px] font-semibold text-ink-900">Contracts and open problems</h3>
          </div>
          <ul className="divide-y divide-ink-100 px-5">
            {c360.problems.slice(0, 4).map((p) => (
              <li key={p.key} className="py-2 text-[12.5px]">
                <span className={clsx("font-medium", p.severity === "high" ? "text-bad-600" : "text-ink-900")}>{p.label}</span>
                <span className="text-ink-500"> · {p.detail}</span>
              </li>
            ))}
            {c360.contracts.map((k) => (
              <li key={k.id} className="py-2 text-[12.5px]">
                <span className="font-medium text-ink-900">{k.title}</span>
                <span className="text-ink-500">
                  {" "}
                  · {k.detail}
                  {k.guaranteeUntil ? ` · price guarantee until ${k.guaranteeUntil.split("-").reverse().join(".")}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {lc.decisions.length > 0 && (
        <div className="space-y-2">
          <h3 className="px-1 text-[12px] font-semibold uppercase tracking-wide text-ink-500">Kompass decided today</h3>
          <ul className="space-y-2">
            {lc.decisions.slice(0, 6).map((d) => (
              <DecisionCard key={d.id} d={d} showCustomer={false} />
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end pb-24">
        <Link to={`/customers/${customerId}`} className="text-[12.5px] font-medium text-ink-500 hover:text-ink-800">
          Open the marketing view of this customer →
        </Link>
      </div>
    </div>
  );
}

const FEEDBACK_NOTE: Record<FeedbackAction, (what: string) => string> = {
  mentioned: (w) => `Noted: you mentioned ${w}. Kompass counts it as one more conversation about it.`,
  not_relevant: (w) => `Noted: ${w} will not be suggested for this customer again.`,
  upset: () => "Noted: no sales content for this customer for 30 days. Queued offers were stopped.",
  has_it: (w) => `Noted: the customer already has ${w}. Kompass drops it.`,
};

function ActionRow({ a, rank, onFeedback }: { a: LiveAction; rank: number; onFeedback: (f: FeedbackAction) => void }) {
  const service = a.type === "service";
  const buttons: { action: FeedbackAction; label: string; icon: LucideIcon }[] = service
    ? [{ action: "mentioned", label: "Done", icon: Check }]
    : [
        { action: "mentioned", label: "Mentioned it", icon: Check },
        { action: "not_relevant", label: "Not relevant", icon: ThumbsDown },
        { action: "has_it", label: "Already has it", icon: UserCheck },
        { action: "upset", label: "Customer upset", icon: Frown },
      ];
  return (
    <li className={clsx("px-5 py-3.5", rank === 1 && "bg-navy-50/30")}>
      <div className="flex items-start gap-3">
        <span className={clsx("num mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold", rank === 1 ? "bg-navy-900 text-white" : "bg-ink-100 text-ink-600")}>{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold text-ink-950">{service ? "Solve the service issue first" : a.product}</span>
            <ActionTypeBadge type={a.type} />
            {!service && (
              <>
                <span className={clsx("num text-[12.5px] font-semibold", a.dclvEur >= 0 ? "text-good-600" : "text-bad-600")}>{fmtDelta(a.dclvEur)} CLV</span>
                <span className="text-[12px] text-ink-500">{Math.round(a.pAccept * 100)} % likely to accept</span>
              </>
            )}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-700">{plainWhy(a.reason)}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {buttons.map((b) => (
              <button
                key={b.action}
                onClick={() => onFeedback(b.action)}
                className={clsx(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium transition-colors",
                  b.action === "upset" ? "border-bad-600/20 text-bad-600 hover:bg-bad-50" : "border-ink-200 text-ink-700 hover:bg-ink-50",
                )}
              >
                <b.icon size={12} /> {b.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </li>
  );
}

function WhyHere({ item, onDone }: { item: DeskItem; onDone: () => void }) {
  const ch = DESK_CHANNEL[item.channel];
  const [showTranscript, setShowTranscript] = useState(item.channel === "phone");
  const [outcome, setOutcome] = useState("Solved");
  const [busy, setBusy] = useState(false);
  const close = async () => {
    setBusy(true);
    try {
      await api.updateDesk(item.id, { status: "done", outcome });
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className={clsx("overflow-hidden", item.mood === "upset" && "border-bad-600/30")}>
      <div className="flex flex-wrap items-start gap-3 px-5 py-4">
        <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-full", item.mood === "upset" ? "bg-bad-50 text-bad-600" : "bg-navy-50 text-navy-800")}>
          <ch.icon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-500">
            <span className="font-medium text-ink-700">{ch.label}</span>· {when(item.at)}
            {item.ticketId && <span>· {item.ticketId}</span>}
            {item.mood === "upset" && (
              <Badge tint="bad">
                <Frown size={11} /> Upset
              </Badge>
            )}
            {item.priority === "high" && <Badge tint="warn">High priority</Badge>}
          </div>
          <div className="mt-0.5 text-[15px] font-semibold text-ink-950">{item.topic}</div>
          {item.detail && <p className="mt-1 text-[13px] text-ink-700">“{item.detail}”</p>}
        </div>
        {item.status === "waiting" ? (
          <div className="flex shrink-0 items-center gap-2">
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="h-8 rounded-lg border border-ink-200 bg-white px-2 text-[12.5px]" aria-label="Outcome">
              {["Solved", "Callback planned", "Escalated", "No answer"].map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <Button size="sm" variant="primary" icon={Check} onClick={close} disabled={busy}>
              Log contact
            </Button>
          </div>
        ) : (
          <Badge tint="good">Closed · {item.outcome}</Badge>
        )}
      </div>
      {item.transcript && (
        <div className="border-t border-ink-100">
          <button onClick={() => setShowTranscript((v) => !v)} className="flex w-full items-center gap-1.5 px-5 py-2 text-left text-[12.5px] font-medium text-ink-600 hover:bg-ink-50">
            {showTranscript ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Call transcript
          </button>
          {showTranscript && (
            <div className="space-y-1.5 px-5 pb-4">
              {item.transcript.split("\n").filter(Boolean).map((l, i) => {
                const agent = l.startsWith("Agent:");
                return (
                  <div key={i} className={clsx("flex", agent ? "justify-start" : "justify-end")}>
                    <div className={clsx("max-w-[80%] rounded-2xl px-3 py-1.5 text-[12.5px] leading-relaxed", agent ? "rounded-bl-md bg-ink-100 text-ink-800" : "rounded-br-md bg-navy-900 text-white")}>
                      {l.replace(/^(Agent|Kunde):\s*/, "")}
                    </div>
                  </div>
                );
              })}
              <p className="pt-1 text-[11px] text-ink-400">Speech-to-text from the telephony system. Customer words are shown as they were said; Kompass reads them as information, never as instructions.</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "bad" | "warn" }) {
  return (
    <div>
      <div className={clsx("num text-[17px] font-semibold", tone === "bad" ? "text-bad-600" : tone === "warn" ? "text-warn-600" : "text-ink-950")}>{value}</div>
      <div className="text-[11.5px] text-ink-500">{label}</div>
    </div>
  );
}

const CHANNEL_ICON: Record<string, LucideIcon> = { email: Mail, newsletter: Mail, sms: MessageSquare, outbound_call: Phone, portal_popup: MonitorSmartphone };
function ChannelIcon({ channel }: { channel: string }) {
  const I = CHANNEL_ICON[channel] ?? Mail;
  return <I size={12} />;
}

/** One customer opened from search in service mode. */
export function AgentCustomerPage() {
  const { id = "" } = useParams();
  const live = useLive();
  const nav = useNavigate();
  const item = live.state?.desk.find((d) => d.customerId === id && d.status === "waiting");
  useScreen("service", { view: "service", title: `Service · ${id}`, data: { customer: id } });
  return (
    <>
      <PageBar
        title={
          <span className="flex items-center gap-2">
            <button onClick={() => nav(-1)} className="no-drag text-ink-400 hover:text-ink-700" aria-label="Back">
              <ArrowLeft size={16} />
            </button>
            Customer · service view
          </span>
        }
        subtitle={id}
      />
      <div className="flex-1 overflow-y-auto page-scroll scroll-thin">
        <AgentView customerId={id} item={item} />
      </div>
    </>
  );
}

export function ServiceCustomersPage() {
  return <CustomersPage base="/service/customers" />;
}
