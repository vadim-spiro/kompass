// Customer 360: one customer on one page — problems, what to do next, what they have, what they are worth.
import clsx from "clsx";
import { AlertTriangle, ArrowLeft, CheckCircle2, Circle, ClipboardList, Cpu, FileText, type LucideIcon, Mail, MessageSquare, MonitorSmartphone, Phone, Send, ShieldCheck, ShoppingBag, Sparkles, Target, UserX, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { BestAction, Customer360, RenderedEmail } from "../../../shared/types";
import { api, type Template } from "../api/client";
import { Checks } from "../components/EmailPreview";
import { ChannelPreview } from "../components/outreach/ChannelPreviews";
import { ActionTypeBadge, Badge, Button, Card, ChannelChip, Empty, ErrorNote, Field, Figure, PageBar, SectionTitle, Select, Sheet, Skeleton, Spinner, Tabs, Textarea, ToneBadge } from "../components/ui";
import { useScreen } from "../lib/screen";
import { emitDataChanged } from "../lib/useAsync";
import { chLabel, fmtDate, fmtDelta, fmtEur, fmtPct, humanize, plainWhy } from "../lib/format";

const ALL_CHANNELS = ["email", "newsletter", "portal_popup", "sms", "outbound_call"];

type TimelineFilter = "key" | "service" | "purchases" | "marketing" | "usage" | "all";
const GROUPS: Record<Exclude<TimelineFilter, "key" | "all">, string[]> = {
  service: ["service_ticket", "call", "dunning", "charge_failure", "kompass"],
  purchases: ["shop_order", "energy_contract", "mobile_contract", "autostrom_contract", "cancellation"],
  marketing: ["newsletter", "nba_action", "consent", "kompass"],
  usage: ["portal_session", "hems_day", "hems_device", "charge_session"],
};
const NOISY = new Set(["hems_day", "newsletter", "portal_session", "consent", "hems_device", "charge_session"]);
const EVENT_ICONS: Record<string, LucideIcon> = {
  service_ticket: MessageSquare,
  call: Phone,
  shop_order: ShoppingBag,
  energy_contract: FileText,
  mobile_contract: FileText,
  portal_session: MonitorSmartphone,
  newsletter: Mail,
  nba_action: Target,
  consent: ShieldCheck,
  hems_day: Zap,
  hems_device: Cpu,
  charge_session: Zap,
  kompass: Sparkles,
};

interface Entry {
  at: string;
  type: string;
  status: string | null;
  text: string;
  quote?: string;
  amount: number | null;
}

/** Splits "Service ticket TK-1 (complaint, email) open: <customer text>" so the customer's words show as a quote. */
function toEntry(t: Customer360["timeline"][number]): Entry {
  const quoted = t.event_type === "service_ticket" || t.event_type === "call";
  const i = quoted ? t.text.indexOf(": ") : -1;
  return {
    at: t.occurred_at,
    type: t.event_type,
    status: t.status,
    text: i > 0 ? t.text.slice(0, i) : t.text,
    quote: i > 0 ? t.text.slice(i + 2) : undefined,
    amount: t.amount_eur,
  };
}

export function Customer360Page() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<Customer360 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"message" | "task" | null>(null);
  const [filter, setFilter] = useState<TimelineFilter>("key");
  const [showSuppressed, setShowSuppressed] = useState(false);

  const load = () =>
    api
      .customer360(id)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    setData(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const [drafted, setDrafted] = useState<string | null>(null);
  useScreen(
    "customer",
    {
      view: "customer",
      title: data ? `Customer ${id} · ${data.profile.contact_policy.salutation}` : `Customer ${id}`,
      data: data
        ? {
            id,
            tone: data.profile.contact_policy.salutation,
            value_tier: data.profile.summary.value_tier,
            churn: data.profile.summary.churn_prob_12m,
            clv: data.profile.summary.clv_eur,
            sales_blockers: data.profile.summary.sales_blockers,
            pains: data.profile.summary.pains,
            contact_channel: data.profile.summary.contact_channel,
            next_actions: data.profile.recommended_actions.slice(0, 3).map((a) => `${a.product_name} (${a.action_type}, ${a.channel})`),
          }
        : { id, loading: true },
    },
    {
      draft_message: {
        target: () => "customer-actions",
        run: async (a) => {
          const p = await api.createProposal({ customerId: id, kind: "message", channel: String(a.channel ?? "auto"), text: String(a.text ?? ""), subject: a.subject ? String(a.subject) : undefined });
          emitDataChanged();
          setDrafted(p.id);
          return `Draft ${p.id} (${p.channel}) is waiting in Approvals. Nothing was sent.`;
        },
      },
    },
  );

  const entries = useMemo(() => {
    if (!data) return [];
    const all: Entry[] = [
      ...data.timeline.map(toEntry),
      ...data.kompass.map((k) => ({ at: k.at, type: "kompass", status: null, text: k.text, amount: null })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    if (filter === "all") return all;
    if (filter === "key") return all.filter((e) => !NOISY.has(e.type) || (e.type === "consent" && e.status === "withdrawn"));
    return all.filter((e) => GROUPS[filter].includes(e.type));
  }, [data, filter]);

  if (error)
    return (
      <>
        <PageBar title={id} />
        <div className="p-10">
          <Empty icon={UserX} title={/not found|404/i.test(error) ? `No customer with the ID ${id}` : "This customer could not be loaded"} hint={/not found|404/i.test(error) ? "Check the ID, or find the customer in the list." : error} />
          <div className="mt-4 flex justify-center">
            <Button icon={ArrowLeft} onClick={() => nav("/customers")}>
              Back to customers
            </Button>
          </div>
        </div>
      </>
    );
  if (!data)
    return (
      <>
        <PageBar title={id} subtitle="Loading…" />
        <div className="grid gap-5 p-6 lg:grid-cols-[1fr_340px]">
          <Skeleton className="h-[520px]" />
          <Skeleton className="h-[520px]" />
        </div>
      </>
    );

  const { profile, identity: who } = data;
  const s = profile.summary;
  const f = profile.features;
  const policy = profile.contact_policy;
  const tone = (policy.salutation === "Du" ? "du" : "sie") as "du" | "sie";
  const since = typeof f.customer_since === "string" ? f.customer_since : null;

  return (
    <>
      <PageBar
        title={
          <span className="flex items-center gap-2">
            <Link to="/customers" className="no-drag text-ink-400 hover:text-ink-700" aria-label="Back to customers">
              <ArrowLeft size={16} />
            </Link>
            {who.name}
            <ToneBadge tone={tone} source={policy.tone_observed ? "detected" : "default"} />
            <Badge tint={s.value_tier === "high" || s.value_tier === "top" ? "sun" : "neutral"}>{humanize(s.value_tier)} value</Badge>
          </span>
        }
        subtitle={`${s.customer_id} · ${who.city}${since ? ` · customer since ${fmtDate(since)}` : ""}`}
        actions={
          <span data-ai="customer-actions" className="flex items-center gap-2">
            {drafted && (
              <Link to="/" className="no-drag flex items-center gap-1 rounded-full bg-violet-50 px-2.5 py-1 text-[12px] font-medium text-violet-600">
                Draft waiting for approval →
              </Link>
            )}
            <Button size="sm" icon={ClipboardList} onClick={() => setSheet("task")}>
              Create task
            </Button>
            <Button size="sm" variant="primary" icon={Send} onClick={() => setSheet("message")}>
              Draft message
            </Button>
          </span>
        }
      />
      <div className="flex-1 overflow-y-auto page-scroll scroll-thin">
        <div className="mx-auto grid max-w-[1280px] gap-5 px-6 py-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-5">
            <Problems data={data} />

            <Card className="p-5">
              <SectionTitle>What to do next</SectionTitle>
              {profile.recommended_actions.length === 0 ? (
                <p className="text-[13px] text-ink-500">Nothing worth offering right now. Leave this customer alone.</p>
              ) : (
                <div className="divide-y divide-ink-100">
                  {profile.recommended_actions.slice(0, 4).map((a, i) => (
                    <ActionRow key={a.offer_id} a={a} first={i === 0} />
                  ))}
                </div>
              )}
              {profile.suppressed_actions.length > 0 && (
                <div className="mt-3 border-t border-ink-100 pt-3">
                  <button onClick={() => setShowSuppressed((v) => !v)} className="text-[12.5px] font-medium text-ink-500 hover:text-ink-800">
                    {showSuppressed ? "Hide" : "Show"} {profile.suppressed_actions.length} offers we are not making, and why
                  </button>
                  {showSuppressed && (
                    <ul className="mt-2 space-y-1.5">
                      {profile.suppressed_actions.map((a) => (
                        <li key={a.offer_id} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                          <span className="min-w-0">
                            <span className="text-ink-700 line-through decoration-ink-300">{a.product_name}</span>
                            <span className="ml-2 text-ink-500">{a.blocked_by ?? "negative value for the customer relationship"}</span>
                          </span>
                          <span className="num shrink-0 text-ink-400">{fmtDelta(a.dclv_eur)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </Card>

            {profile.savings.length > 0 && (
              <Card className="p-5">
                <SectionTitle>Money this customer could save</SectionTitle>
                {!profile.contact_policy.sales_allowed && (
                  <p className="mb-3 rounded-lg bg-warn-50 px-3 py-2 text-[12.5px] text-warn-600">Not now: {profile.contact_policy.sales_blockers.join(", ") || "an open service case"} comes first. Keep these for when it is solved.</p>
                )}
                <div className={clsx("space-y-3", !profile.contact_policy.sales_allowed && "opacity-60")}>
                  {profile.savings.map((sv) => (
                    <div key={sv.kind} className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-[13.5px] font-medium text-ink-900">{sv.title}</div>
                        <div className="text-[12.5px] text-ink-500">{sv.explanation}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="num text-[15px] font-semibold text-good-600">{sv.annual_saving_eur ? `${fmtEur(sv.annual_saving_eur)}/yr` : fmtEur(sv.one_off_saving_eur)}</div>
                        <div className="text-[11.5px] text-ink-400">{sv.basis === "data" ? "from their data" : "estimate"}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <Card className="p-5">
              <SectionTitle>Timeline</SectionTitle>
              <Tabs
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "key", label: "Key moments" },
                  { value: "service", label: "Service" },
                  { value: "purchases", label: "Purchases & contracts" },
                  { value: "marketing", label: "Marketing" },
                  { value: "usage", label: "Usage" },
                  { value: "all", label: "All", count: data.timeline.length + data.kompass.length },
                ]}
              />
              {entries.length === 0 ? (
                <p className="py-6 text-center text-[13px] text-ink-400">Nothing here.</p>
              ) : (
                <ol className="mt-3 space-y-0.5">
                  {entries.slice(0, 60).map((e, i) => {
                    const Icon = EVENT_ICONS[e.type] ?? Circle;
                    return (
                      <li key={i} className="flex gap-3 py-1.5">
                        <div className={clsx("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", e.type === "kompass" ? "bg-violet-50 text-violet-600" : e.status === "open" ? "bg-bad-50 text-bad-600" : "bg-ink-100 text-ink-500")}>
                          <Icon size={13} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="text-[13px] text-ink-800">{e.text}</span>
                            <span className="num shrink-0 text-[11.5px] text-ink-400">{fmtDate(e.at)}</span>
                          </div>
                          {e.quote && (
                            <blockquote className="mt-1 border-l-2 border-ink-200 pl-2.5 text-[12.5px] italic text-ink-500" title="The customer's own words (shown as data)">
                              “{e.quote}”
                            </blockquote>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </Card>
          </div>

          <div className="min-w-0 space-y-5">
            <Card className="p-5">
              <SectionTitle action={<Badge title="The mock data is anonymised; name, email and street are generated">synthetic</Badge>}>Contact</SectionTitle>
              <div className="space-y-0.5 text-[13px]">
                <div className="font-medium text-ink-900">{who.name}</div>
                <div className="text-ink-600">{who.email}</div>
                <div className="text-ink-600">
                  {who.street}, {who.postalCode} {who.city}
                </div>
              </div>
              <div className="mt-4 text-[12px] font-medium text-ink-500">May contact via</div>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {ALL_CHANNELS.map((ch) => (
                  <span key={ch} className={clsx(!policy.allowed_channels.includes(ch) && "line-through decoration-ink-300")}>
                    <ChannelChip channel={ch} muted={!policy.allowed_channels.includes(ch)} />
                  </span>
                ))}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-y-1.5 text-[12.5px]">
                <dt className="text-ink-500">Personalisation</dt>
                <dd className={policy.profiling_allowed ? "text-ink-800" : "text-warn-600"}>{policy.profiling_allowed ? "allowed" : "no consent"}</dd>
                <dt className="text-ink-500">Sales</dt>
                <dd className={policy.sales_allowed ? "text-ink-800" : "text-bad-600"}>{policy.sales_allowed ? "allowed" : `paused (${policy.sales_blockers.join(", ")})`}</dd>
                <dt className="text-ink-500">Portal / app</dt>
                <dd className="text-ink-800">
                  {f.portal_account ? "portal" : "no portal"}
                  {f.app_installed ? " · app" : ""}
                </dd>
              </dl>
            </Card>

            <Card className="p-5">
              <SectionTitle>Value</SectionTitle>
              <div className="grid grid-cols-2 gap-4">
                <Figure label="Customer lifetime value" value={s.clv_eur != null ? fmtEur(s.clv_eur) : "–"} />
                <Figure label="Churn risk, 12 months" value={s.churn_prob_12m != null ? fmtPct(s.churn_prob_12m) : "–"} tone={(s.churn_prob_12m ?? 0) >= 0.3 ? "bad" : undefined} />
                <Figure label="Margin per year" value={s.annual_margin_eur != null ? fmtEur(s.annual_margin_eur) : "–"} />
                <Figure label="Value at risk" value={s.value_at_risk_eur != null ? fmtEur(s.value_at_risk_eur) : "–"} tone={(s.value_at_risk_eur ?? 0) > 300 ? "warn" : undefined} />
              </div>
              {s.churn_drivers.length > 0 && (
                <div className="mt-4">
                  <div className="text-[12px] font-medium text-ink-500">Why they might leave</div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {s.churn_drivers.map((d) => (
                      <Badge key={d} tint="warn">
                        {humanize(d)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              <dl className="mt-4 grid grid-cols-2 gap-y-1.5 border-t border-ink-100 pt-3 text-[12.5px]">
                <dt className="text-ink-500">Monthly installments</dt>
                <dd className="num text-right text-ink-800">{fmtEur(data.spend.monthlyInstallmentsEur)}</dd>
                <dt className="text-ink-500">Shop, all time</dt>
                <dd className="num text-right text-ink-800">{fmtEur(data.spend.shopEur)}</dd>
                <dt className="text-ink-500">Charging, all time</dt>
                <dd className="num text-right text-ink-800">{fmtEur(data.spend.chargingEur)}</dd>
              </dl>
            </Card>

            <Card className="p-5">
              <SectionTitle>Subscriptions</SectionTitle>
              {data.contracts.length === 0 ? (
                <p className="text-[13px] text-ink-400">No active contract.</p>
              ) : (
                <ul className="space-y-3">
                  {data.contracts.map((c) => (
                    <li key={c.id}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[13.5px] font-medium text-ink-900">{c.title}</span>
                        {c.status !== "active" ? <Badge tint="bad">{c.status}</Badge> : c.monthlyEur ? <span className="num text-[12.5px] text-ink-600">{fmtEur(c.monthlyEur)}/mo</span> : null}
                      </div>
                      <div className="text-[12px] text-ink-500">{c.detail}</div>
                      {c.guaranteeUntil && <div className="text-[12px] text-ink-500">Price guarantee until {fmtDate(c.guaranteeUntil)}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-5">
              <SectionTitle>Purchases</SectionTitle>
              {data.orders.length === 0 ? (
                <p className="text-[13px] text-ink-400">No shop orders.</p>
              ) : (
                <ul className="space-y-1.5 text-[13px]">
                  {data.orders.map((o, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-2">
                      <span className={clsx("min-w-0 truncate", o.status === "returned" || o.status === "cancelled" ? "text-ink-400 line-through" : "text-ink-800")}>{o.product}</span>
                      <span className="shrink-0 text-[12px] text-ink-400">
                        {o.status !== "delivered" && `${o.status} · `}
                        {o.month}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-5">
              <SectionTitle>Segments</SectionTitle>
              <div className="flex flex-wrap gap-1">
                {s.segments.map((x) => (
                  <Badge key={x} tint="navy">
                    {humanize(x)}
                  </Badge>
                ))}
                {s.personas.map((x) => (
                  <Badge key={x} tint="teal">
                    {humanize(x)}
                  </Badge>
                ))}
                {!s.segments.length && !s.personas.length && <span className="text-[13px] text-ink-400">None</span>}
              </div>
              {profile.pain_details.length > 0 && (
                <ul className="mt-3 space-y-1 text-[12.5px]">
                  {profile.pain_details.map((p) => (
                    <li key={p.pain}>
                      <span className="font-medium text-ink-700">{humanize(p.pain)}</span>
                      <span className="text-ink-500"> · {p.description}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </div>

      <Sheet open={sheet === "message"} onClose={() => setSheet(null)} title={`Message to ${who.name}`} width={560}>
        <DraftMessage data={data} onDone={() => { setSheet(null); void load(); }} />
      </Sheet>
      <Sheet open={sheet === "task"} onClose={() => setSheet(null)} title={`Task for ${who.name}`}>
        <CreateTask data={data} onDone={() => { setSheet(null); void load(); }} />
      </Sheet>
    </>
  );
}

function Problems({ data }: { data: Customer360 }) {
  if (data.problems.length === 0)
    return (
      <Card className="flex items-center gap-2.5 p-4 text-[13px] text-good-600">
        <CheckCircle2 size={16} /> No open problems: no missed payments, open tickets or failed charges.
      </Card>
    );
  return (
    <Card className="p-5">
      <SectionTitle>Problems</SectionTitle>
      <ul className="space-y-2.5">
        {data.problems.map((p) => (
          <li key={p.key} className="flex items-start gap-3">
            <AlertTriangle size={15} className={clsx("mt-0.5 shrink-0", p.severity === "high" ? "text-bad-600" : p.severity === "medium" ? "text-warn-600" : "text-ink-400")} />
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-ink-900">
                {p.label}
                {p.since && <span className="ml-2 text-[12px] font-normal text-ink-400">since {fmtDate(p.since)}</span>}
              </div>
              <div className="text-[12.5px] text-ink-500">{p.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ActionRow({ a, first }: { a: BestAction; first: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={clsx("text-[13.5px] font-medium", first ? "text-ink-950" : "text-ink-800")}>{a.product_name}</span>
          <ActionTypeBadge type={a.action_type} />
          {first && <Badge tint="sun">Best</Badge>}
        </div>
        <div className="mt-0.5 text-[12.5px] text-ink-500">{plainWhy(a.reason)}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="num text-[14px] font-semibold text-ink-900">{fmtDelta(a.dclv_eur)}</div>
        <div className="text-[11.5px] text-ink-400">
          {fmtPct(a.p_accept)} likely · {a.channel ? chLabel(a.channel) : "any channel"}
        </div>
      </div>
    </div>
  );
}

function DraftMessage({ data, onDone }: { data: Customer360; onDone: () => void }) {
  const id = data.profile.summary.customer_id;
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [channel, setChannel] = useState("auto");
  const [preview, setPreview] = useState<RenderedEmail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = data.profile.contact_policy.allowed_channels;

  useEffect(() => {
    api.templates().then((t) => {
      setTemplates(t);
      // Service-first customers start with the service template when there is one.
      const service = data.profile.summary.service_case ? t.find((x) => /service|klär/i.test(x.name)) : undefined;
      setTemplateId((service ?? t[0])?.id ?? "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tpl = templates?.find((t) => t.id === templateId);
  useEffect(() => {
    if (!tpl) return;
    setPreview(null);
    api
      .render(tpl.email, id, channel)
      .then((r) => {
        setPreview(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [tpl, id, channel]);

  const queue = async () => {
    setBusy(true);
    try {
      await api.createProposal({ customerId: id, kind: "message", templateId, channel });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!templates) return <Skeleton className="m-5 h-80" />;
  if (!templates.length)
    return (
      <div className="p-5">
        <Empty icon={Mail} title="No templates yet" hint="Create one under Settings → Templates first." />
      </div>
    );
  return (
    <div className="space-y-4 p-5">
      <div className="grid grid-cols-[1fr_180px] gap-3">
        <Field label="Template">
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} options={templates.map((t) => ({ value: t.id, label: t.name }))} />
        </Field>
        <Field label="Channel">
          <Select value={channel} onChange={(e) => setChannel(e.target.value)} options={[{ value: "auto", label: "Best allowed" }, ...allowed.map((c) => ({ value: c, label: chLabel(c) }))]} />
        </Field>
      </div>
      <p className="text-[12.5px] text-ink-500">The smart blocks fill themselves from this customer's data. Change the template under Settings → Templates.</p>
      <ErrorNote error={error} />
      {!preview && !error && (
        <div className="flex items-center gap-2 py-6 text-[13px] text-ink-500">
          <Spinner /> Rendering for this customer…
        </div>
      )}
      {preview && (
        <>
          <div className="flex items-center gap-2 text-[12.5px] text-ink-600">
            <Badge tint={preview.variant === "service" ? "good" : preview.variant.startsWith("offer:") ? "navy" : "neutral"}>{preview.variantLabel}</Badge>
            via {chLabel(preview.channel)}
            {!preview.reachable && <Badge tint="bad">no consent for this channel</Badge>}
          </div>
          <ChannelPreview channel={preview.channel} e={preview} />
          {preview.channel === "email" || preview.channel === "newsletter" ? <Checks checks={preview.checks} /> : null}
        </>
      )}
      <div className="sticky bottom-0 -mx-5 flex items-center justify-between gap-3 border-t border-ink-100 bg-white px-5 py-3">
        <span className="text-[12px] text-ink-500">Nothing is sent: it waits on Home for approval.</span>
        <Button variant="primary" icon={Send} onClick={queue} disabled={busy || !preview?.reachable}>
          Queue for approval
        </Button>
      </div>
    </div>
  );
}

const TEAMS = ["Kundenservice", "Abrechnung", "Technik / Laden", "Vertrieb"];

function CreateTask({ data, onDone }: { data: Customer360; onDone: () => void }) {
  const id = data.profile.summary.customer_id;
  const first = data.problems[0];
  const [team, setTeam] = useState(first?.key === "dunning" ? "Abrechnung" : first?.key === "charging" ? "Technik / Laden" : "Kundenservice");
  const [text, setText] = useState(
    data.problems.length
      ? `Bitte ${data.identity.name} zurückrufen und klären: ${data.problems
          .filter((p) => p.severity !== "low")
          .map((p) => `${p.label} (${p.detail})`)
          .join("; ")}.`
      : `Bitte ${data.identity.name} kontaktieren: `,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      await api.createProposal({ customerId: id, kind: "task", team, text });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 p-5">
      <Field label="Team">
        <Select value={team} onChange={(e) => setTeam(e.target.value)} options={TEAMS.map((t) => ({ value: t, label: t }))} />
      </Field>
      <Field label="What should they do?">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} />
      </Field>
      <ErrorNote error={error} />
      <div className="flex justify-end">
        <Button variant="primary" icon={ClipboardList} onClick={save} disabled={busy || !text.trim()}>
          Create task
        </Button>
      </div>
    </div>
  );
}
