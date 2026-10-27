// Standard reports: what worked, measured against control groups, from the team's insights service.
import clsx from "clsx";
import { BarChart3 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Campaign, ChartSpec } from "../../../shared/types";
import { api } from "../api/client";
import { dec, pct, pts } from "../components/analytics/ChartView";
import { ActionTypeBadge, Badge, Card, ErrorNote, Figure, SectionTitle, Skeleton, Tabs } from "../components/ui";
import { chLabel, fmtDate, fmtEur, fmtInt, humanize } from "../lib/format";
import { useAsync } from "../lib/useAsync";

type Tab = "campaigns" | "channels" | "offers" | "problems" | "savings" | "compliance";

interface ChannelPerf {
  channel: string;
  tonality: string;
  treated: number;
  treated_conversion_rate: number;
  control: number;
  control_conversion_rate: number;
  uplift_pp: number;
  click_rate: number;
  dismiss_rate: number;
}
interface Channels {
  performance: ChannelPerf[];
  reach: { channel: string; consent: string; reachable_customers: number; share: number }[];
  tone: { key: string; count: number }[];
}
interface OfferPerf {
  offer_id: string;
  product_name: string;
  action_type: string;
  eligible_customers: number;
  recommended_customers: number;
  best_for_customers: number;
  best_dclv_total_eur: number;
  suppressed_by_reason: Record<string, number>;
  legacy_sent: number;
  legacy_conversion_rate: number | null;
  uplift_pp: number | null;
}
interface PainPerf {
  pain: string;
  description: string;
  customers: number;
  churn_avg: number;
  value_at_risk_eur: number;
  open_ticket_share: number;
  last_csat_avg: number | null;
  segments: { key: string; count: number }[];
}
interface SavingPerf {
  kind: string;
  title: string;
  basis: "data" | "assumption";
  customers: number;
  reachable_customers: number;
  annual_saving_total_eur: number;
  one_off_saving_total_eur: number;
  annual_saving_avg_eur: number;
}
interface Audit {
  legacy_actions: number;
  treated: number;
  control: number;
  control_share: number;
  sent_without_consent_today: number;
  sales_without_profiling_consent: number;
  sent_into_service_case: number;
  contacts_per_customer_30d: { key: string; count: number }[];
  by_channel: { channel: string; sent: number; without_consent_today: number; sales_without_profiling_consent: number; into_service_case: number }[];
  notes: string[];
}

/**
 * Reports whose numbers the analytics layer can draw open as an editable chart. Campaigns, savings and
 * compliance have none: their figures (simulated results, refunds, "sent without today's consent") are
 * not in the 12 datasets, so those tabs show no link rather than an unrelated chart.
 */
const EDITABLE: Partial<Record<Tab, ChartSpec>> = {
  channels: { source: "offers", x: "channel", split: "tone", measures: ["uplift"], title: "Uplift vs control by channel and form of address" },
  offers: { source: "offers", x: "offer", measures: ["conversion_rate"], filters: [{ field: "control_group", values: ["false"] }], title: "Conversion rate by offer" },
  problems: { source: "customers", x: "c_pain", measures: ["var_sum"], title: "Value at risk by pain" },
};

/** The teammate's standard views, as a tab of Analytics. */
export function StandardReports() {
  const [tab, setTab] = useState<Tab>("campaigns");
  const nav = useNavigate();
  const editable = EDITABLE[tab];
  return (
    <>
      <div className="shrink-0 bg-white px-6 pt-3">
        <div className="flex items-end justify-between gap-3">
          <Tabs
            value={tab}
            onChange={setTab}
            options={[
              { value: "campaigns", label: "Campaigns" },
              { value: "channels", label: "Channels & tone" },
              { value: "offers", label: "Offers" },
              { value: "problems", label: "Problems" },
              { value: "savings", label: "Customer savings" },
              { value: "compliance", label: "Compliance" },
            ]}
          />
          {/* The slot is always there, so the tab row keeps its height on tabs without a chart. */}
          <div className="mb-2 flex h-7 shrink-0 items-center">
            {editable && (
              <button
                onClick={() => nav("/analytics/new", { state: { spec: editable } })}
                title={`Opens “${editable.title}” in the chart builder`}
                className="flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-navy-700 hover:bg-navy-50"
              >
                <BarChart3 size={14} /> Open as editable chart
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto page-scroll scroll-thin">
        <div className="@container mx-auto max-w-[1280px] space-y-5 px-6 py-5">
          {tab === "campaigns" && <CampaignsTab />}
          {tab === "channels" && <ChannelsTab />}
          {tab === "offers" && <OffersTab />}
          {tab === "problems" && <ProblemsTab />}
          {tab === "savings" && <SavingsTab />}
          {tab === "compliance" && <ComplianceTab />}
        </div>
      </div>
    </>
  );
}

/** A thin bar inside a table cell. */
function Bar({ value, max, tone = "navy" }: { value: number; max: number; tone?: "navy" | "good" | "warn" | "bad" | "violet" }) {
  const w = max > 0 ? Math.max(2, Math.round((Math.max(0, value) / max) * 100)) : 0;
  const color = { navy: "bg-navy-700", good: "bg-good-600", warn: "bg-warn-600", bad: "bg-bad-600", violet: "bg-violet-600" }[tone];
  return (
    <div className="h-1.5 w-full min-w-[60px] rounded-full bg-ink-100">
      <div className={clsx("h-1.5 rounded-full", color)} style={{ width: `${w}%` }} />
    </div>
  );
}

function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[11.5px] uppercase tracking-wider text-ink-400">
            {head.map((h, i) => (
              <th key={i} className={clsx("whitespace-nowrap py-2 pr-4 font-medium", i > 0 && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100 border-t border-ink-200">{children}</tbody>
      </table>
    </div>
  );
}
const td = "num whitespace-nowrap py-2 pr-4 text-right";

function useInsights<T>(path: string) {
  return useAsync(() => api.insights<T>(path), [path]);
}

function Loading({ error }: { error?: Error }) {
  return error ? <ErrorNote error={error} /> : <Skeleton className="h-80" />;
}

function rates(c: Campaign) {
  const f = Object.fromEntries((c.results?.funnel ?? []).map((s) => [s.key, s.count]));
  const sent = f.sent ?? f.delivered ?? 0;
  return {
    sent,
    open: sent ? (f.opened ?? f.human_opens ?? 0) / sent : 0,
    click: sent ? (f.clicked ?? f.clicks ?? 0) / sent : 0,
    conv: sent ? (f.converted ?? f.conversions ?? 0) / sent : 0,
    unsub: sent ? (f.unsubscribed ?? f.unsubscribes ?? 0) / sent : 0,
  };
}

function CampaignsTab() {
  const { data, error } = useAsync(() => api.campaigns(), []);
  if (!data) return <Loading error={error} />;
  const done = data.filter((c) => c.results).sort((a, b) => (b.launchedAt ?? "").localeCompare(a.launchedAt ?? ""));
  const kompass = done.filter((c) => c.source === "kompass");
  const legacy = done.filter((c) => c.source === "legacy_newsletter");
  const avg = (list: Campaign[], k: "open" | "click" | "conv" | "unsub") => {
    const sent = list.reduce((s, c) => s + rates(c).sent, 0);
    return sent ? list.reduce((s, c) => s + rates(c)[k] * rates(c).sent, 0) / sent : 0;
  };
  const maxConv = Math.max(0.01, ...done.map((c) => rates(c).conv));
  return (
    <>
      <div className="grid gap-5 @3xl:grid-cols-2">
        <Card className="p-5">
          <SectionTitle>Before: newsletter to everyone</SectionTitle>
          <div className="grid grid-cols-3 gap-4">
            <Figure label="Human opens" value={pct(avg(legacy, "open"), 1)} />
            <Figure label="Conversion" value={pct(avg(legacy, "conv"), 1)} />
            <Figure label="Unsubscribes" value={pct(avg(legacy, "unsub"), 1)} tone="warn" />
          </div>
          <p className="mt-3 text-[12px] text-ink-500">{legacy.length} newsletters, one text for all, no control group.</p>
        </Card>
        <Card className="p-5">
          <SectionTitle>With Kompass: chosen per customer</SectionTitle>
          {kompass.length ? (
            <>
              <div className="grid grid-cols-3 gap-4">
                <Figure label="Human opens" value={pct(avg(kompass, "open"), 1)} />
                <Figure label="Conversion" value={pct(avg(kompass, "conv"), 1)} tone="good" />
                <Figure label="Uplift vs control" value={pts(kompass.reduce((s, c) => s + (c.results?.upliftPp ?? 0), 0) / kompass.length)} tone="good" />
              </div>
              <p className="mt-3 text-[12px] text-ink-500">{kompass.length} launched campaigns · simulated from acceptance probabilities and channel benchmarks.</p>
            </>
          ) : (
            <p className="text-[13px] text-ink-500">
              No Kompass campaign launched yet. <Link to="/campaigns" className="font-medium text-navy-700 hover:underline">Build one</Link> to compare.
            </p>
          )}
        </Card>
      </div>
      <Card className="p-5">
        <SectionTitle>All campaigns</SectionTitle>
        <Table head={["Campaign", "Sent", "Opens", "Clicks", "Conversion", "", "Unsubscribes", "Uplift vs control"]}>
          {done.map((c) => {
            const r = rates(c);
            return (
              <tr key={c.id}>
                <td className="max-w-[340px] py-2 pr-4">
                  <Link to={`/campaigns/${c.id}${c.source === "kompass" ? "?step=results" : ""}`} className="block truncate font-medium text-ink-900 hover:underline">
                    {c.name}
                  </Link>
                  <div className="text-[11.5px] text-ink-400">
                    {c.source === "kompass" ? <Badge tint="violet">Kompass · simulated</Badge> : "Newsletter"} {fmtDate(c.launchedAt)}
                  </div>
                </td>
                <td className={td}>{fmtInt(r.sent)}</td>
                <td className={td}>{pct(r.open, 1)}</td>
                <td className={td}>{pct(r.click, 1)}</td>
                <td className={td}>{pct(r.conv, 1)}</td>
                <td className="w-28 py-2 pr-4">
                  <Bar value={r.conv} max={maxConv} tone={c.source === "kompass" ? "violet" : "navy"} />
                </td>
                <td className={td}>{pct(r.unsub, 1)}</td>
                <td className={clsx(td, c.source === "kompass" ? "text-good-600" : "text-ink-400")}>{c.source === "kompass" && c.results ? pts(c.results.upliftPp) : "no control"}</td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}

function ChannelsTab() {
  const { data, error } = useInsights<Channels>("/growth/channels");
  if (!data) return <Loading error={error} />;
  const perf = [...data.performance].sort((a, b) => b.uplift_pp - a.uplift_pp);
  const maxUp = Math.max(...perf.map((p) => p.uplift_pp), 0.1);
  const toneTotal = data.tone.reduce((s, t) => s + t.count, 0);
  return (
    <>
      <Card className="p-5">
        <SectionTitle>Which channel and tone convert, against control (past offers)</SectionTitle>
        <Table head={["Channel", "Tone", "Contacted", "Conversion", "Control", "Uplift", "", "Clicks", "Dismissed"]}>
          {perf.map((p) => (
            <tr key={`${p.channel}-${p.tonality}`}>
              <td className="py-2 pr-4 text-ink-900">{chLabel(p.channel.replace("newsletter_email", "newsletter"))}</td>
              <td className={td}>{p.tonality === "du" ? "Du" : "Sie"}</td>
              <td className={td}>{fmtInt(p.treated)}</td>
              <td className={td}>{pct(p.treated_conversion_rate, 1)}</td>
              <td className={clsx(td, "text-ink-400")}>{pct(p.control_conversion_rate, 1)}</td>
              <td className={clsx(td, p.uplift_pp > 0 ? "text-good-600" : "text-bad-600")}>{pts(p.uplift_pp)}</td>
              <td className="w-28 py-2 pr-4">
                <Bar value={p.uplift_pp} max={maxUp} tone="good" />
              </td>
              <td className={td}>{pct(p.click_rate, 0)}</td>
              <td className={td}>{pct(p.dismiss_rate, 0)}</td>
            </tr>
          ))}
        </Table>
        <p className="mt-3 text-[12px] text-ink-500">Small control groups: read the uplift as a direction, not a precise number.</p>
      </Card>
      <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="p-5">
          <SectionTitle>Who we may legally reach today</SectionTitle>
          <Table head={["Channel", "Customers", "", "Needs"]}>
            {data.reach.map((r) => (
              <tr key={r.channel}>
                <td className="py-2 pr-4 text-ink-900">{chLabel(r.channel)}</td>
                <td className={td}>
                  {fmtInt(r.reachable_customers)} <span className="text-ink-400">({pct(r.share)})</span>
                </td>
                <td className="w-32 py-2 pr-4">
                  <Bar value={r.share} max={1} />
                </td>
                <td className="py-2 text-right text-[12px] text-ink-500">{r.consent.replace("Needs consent ", "").replace(/_/g, " ")}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card className="p-5">
          <SectionTitle>Tone</SectionTitle>
          <ul className="space-y-2.5">
            {data.tone.map((t) => (
              <li key={t.key}>
                <div className="flex justify-between text-[13px]">
                  <span className="text-ink-800">{t.key === "du" ? "Du (from their own messages)" : t.key === "sie" ? "Sie (from their own messages)" : "Sie (default, no signal)"}</span>
                  <span className="num text-ink-500">{fmtInt(t.count)}</span>
                </div>
                <Bar value={t.count} max={toneTotal} tone="violet" />
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function OffersTab() {
  const { data, error } = useInsights<OfferPerf[]>("/growth/offers");
  if (!data) return <Loading error={error} />;
  const list = [...data].sort((a, b) => b.best_dclv_total_eur - a.best_dclv_total_eur);
  const max = Math.max(...list.map((o) => o.best_dclv_total_eur), 1);
  return (
    <Card className="p-5">
      <SectionTitle>Offers: who they fit, what they are worth, what worked before</SectionTitle>
      <Table head={["Offer", "Eligible", "Best next step for", "CLV if taken", "", "Sent before", "Converted", "Uplift", "Held back because"]}>
        {list.map((o) => (
          <tr key={o.offer_id}>
            <td className="py-2 pr-4">
              <div className="font-medium text-ink-900">{o.product_name}</div>
              <ActionTypeBadge type={o.action_type} />
            </td>
            <td className={td}>{fmtInt(o.eligible_customers)}</td>
            <td className={td}>{fmtInt(o.best_for_customers)}</td>
            <td className={clsx(td, "text-good-600")}>{fmtEur(o.best_dclv_total_eur)}</td>
            <td className="w-24 py-2 pr-4">
              <Bar value={o.best_dclv_total_eur} max={max} tone="good" />
            </td>
            <td className={td}>{o.legacy_sent ? fmtInt(o.legacy_sent) : "–"}</td>
            <td className={td}>{o.legacy_conversion_rate != null ? pct(o.legacy_conversion_rate, 1) : "–"}</td>
            <td className={clsx(td, (o.uplift_pp ?? 0) > 0 ? "text-good-600" : "text-ink-400")}>{o.uplift_pp != null ? pts(o.uplift_pp) : "–"}</td>
            <td className="max-w-[260px] py-2 text-right text-[12px] text-ink-500">
              {Object.entries(o.suppressed_by_reason)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 2)
                .map(([k, v]) => `${humanize(k)} ${fmtInt(v)}`)
                .join(" · ") || "–"}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function ProblemsTab() {
  const { data, error } = useInsights<PainPerf[]>("/pains");
  if (!data) return <Loading error={error} />;
  const list = [...data].sort((a, b) => b.value_at_risk_eur - a.value_at_risk_eur);
  const max = Math.max(...list.map((p) => p.value_at_risk_eur), 1);
  return (
    <Card className="p-5">
      <SectionTitle>Problems customers tell us about, by revenue at risk</SectionTitle>
      <Table head={["Problem", "Customers", "Avg churn", "Revenue at risk", "", "Ticket still open", "Last CSAT", "Mostly in"]}>
        {list.map((p) => (
          <tr key={p.pain}>
            <td className="py-2 pr-4">
              <Link to={`/customers?pain=${p.pain}`} className="font-medium text-ink-900 hover:underline">
                {humanize(p.pain)}
              </Link>
              <div className="text-[12px] text-ink-500">{p.description}</div>
            </td>
            <td className={td}>{fmtInt(p.customers)}</td>
            <td className={clsx(td, p.churn_avg >= 0.25 && "text-bad-600")}>{pct(p.churn_avg)}</td>
            <td className={td}>{fmtEur(p.value_at_risk_eur)}</td>
            <td className="w-28 py-2 pr-4">
              <Bar value={p.value_at_risk_eur} max={max} tone="warn" />
            </td>
            <td className={td}>{pct(p.open_ticket_share)}</td>
            <td className={td}>{p.last_csat_avg != null ? dec(p.last_csat_avg, 1) : "–"}</td>
            <td className="py-2 text-right text-[12px] text-ink-500">
              {p.segments
                .slice(0, 2)
                .map((s) => humanize(s.key))
                .join(", ")}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function SavingsTab() {
  const { data, error } = useInsights<SavingPerf[]>("/savings/summary");
  if (!data) return <Loading error={error} />;
  const fromData = data.filter((s) => s.basis === "data");
  const total = fromData.reduce((s, x) => s + x.annual_saving_total_eur, 0);
  const oneOff = fromData.reduce((s, x) => s + x.one_off_saving_total_eur, 0);
  const max = Math.max(...data.map((s) => s.annual_saving_total_eur || s.one_off_saving_total_eur), 1);
  return (
    <>
      <Card className="grid grid-cols-2 gap-5 p-5 md:grid-cols-3">
        <Figure label="Customers could save per year (from their data)" value={fmtEur(total)} tone="good" />
        <Figure label="Refunds owed once (failed charging)" value={fmtEur(oneOff)} />
        <Figure label="Customers with a real saving" value={fmtInt(fromData.reduce((s, x) => s + x.customers, 0))} />
      </Card>
      <Card className="p-5">
        <SectionTitle>Where customers could save: the honest reason to contact them</SectionTitle>
        <Table head={["Saving", "Customers", "Reachable", "Per year, total", "", "Average", "Based on"]}>
          {data.map((s) => (
            <tr key={s.kind}>
              <td className="py-2 pr-4 text-ink-900">{s.title}</td>
              <td className={td}>{fmtInt(s.customers)}</td>
              <td className={td}>{fmtInt(s.reachable_customers)}</td>
              <td className={td}>{s.annual_saving_total_eur ? fmtEur(s.annual_saving_total_eur) : `${fmtEur(s.one_off_saving_total_eur)} once`}</td>
              <td className="w-28 py-2 pr-4">
                <Bar value={s.annual_saving_total_eur || s.one_off_saving_total_eur} max={max} tone={s.basis === "data" ? "good" : "navy"} />
              </td>
              <td className={td}>{s.annual_saving_avg_eur ? fmtEur(s.annual_saving_avg_eur) : "–"}</td>
              <td className="py-2 text-right">
                <Badge tint={s.basis === "data" ? "good" : "neutral"}>{s.basis === "data" ? "their data" : "estimate"}</Badge>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

function ComplianceTab() {
  const { data, error } = useInsights<Audit>("/governance/audit");
  if (!data) return <Loading error={error} />;
  return (
    <>
      <Card className="p-5">
        <SectionTitle>Past contacts (before Kompass), checked against today's rules</SectionTitle>
        <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
          <Figure label="Offers sent" value={fmtInt(data.legacy_actions)} />
          <Figure label="Sent without today's consent" value={fmtInt(data.sent_without_consent_today)} tone="bad" />
          <Figure label="Sales without profiling consent" value={fmtInt(data.sales_without_profiling_consent)} tone="warn" />
          <Figure label="Offers into an open service case" value={fmtInt(data.sent_into_service_case)} tone="warn" />
        </div>
        <p className="mt-4 rounded-lg bg-good-50 px-3 py-2 text-[12.5px] text-good-600">
          With Kompass all three are zero by construction: every campaign and automation passes the consent and exclusions gate at send time, and nothing goes out without approval.
        </p>
      </Card>
      <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="p-5">
          <SectionTitle>By channel</SectionTitle>
          <Table head={["Channel", "Sent", "Without consent", "Sales w/o profiling", "Into service case"]}>
            {data.by_channel.map((c) => (
              <tr key={c.channel}>
                <td className="py-2 pr-4 text-ink-900">{chLabel(c.channel.replace("newsletter_email", "newsletter"))}</td>
                <td className={td}>{fmtInt(c.sent)}</td>
                <td className={clsx(td, "text-bad-600")}>
                  {fmtInt(c.without_consent_today)} <span className="text-ink-400">({pct(c.without_consent_today / Math.max(1, c.sent))})</span>
                </td>
                <td className={td}>{fmtInt(c.sales_without_profiling_consent)}</td>
                <td className={td}>{fmtInt(c.into_service_case)}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card className="p-5">
          <SectionTitle>Contacts per customer, last 30 days</SectionTitle>
          <ul className="space-y-2">
            {data.contacts_per_customer_30d.map((b) => (
              <li key={b.key} className="grid grid-cols-[70px_1fr_40px] items-center gap-2 text-[12.5px]">
                <span className="text-ink-600">{b.key === "1" ? "1 contact" : `${b.key} contacts`}</span>
                <Bar value={b.count} max={Math.max(...data.contacts_per_customer_30d.map((x) => x.count))} tone={Number(b.key) >= 3 ? "warn" : "navy"} />
                <span className="num text-right text-ink-500">{fmtInt(b.count)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] text-ink-500">Control share in past offers: {pct(data.control_share, 1)}</p>
        </Card>
      </div>
      <ul className="space-y-1 text-[12px] text-ink-500">
        {data.notes.map((n) => (
          <li key={n}>· {n}</li>
        ))}
      </ul>
    </>
  );
}
