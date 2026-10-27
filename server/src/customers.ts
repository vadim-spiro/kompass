// Customer list and Customer 360: the insights profile and timeline, joined with raw contracts and
// orders (query/rows), a synthetic identity and the problems marketing must see before selling.
import type { Audience, Contract, Customer360, CustomerRow, CustomerSummary, LiveFacts, Page, Problem } from "../../shared/types.ts";
import { dateDe } from "./blocks.ts";
import { CHANNEL_NAME, factsFor, overlayProfile } from "./engine.ts";
import { identityFor } from "./identity.ts";
import { getProfile, getTimeline, queryRows, searchCustomers } from "./upstream.ts";
import { ws } from "./workspace.ts";

const row = (s: CustomerSummary): CustomerRow => ({ ...s, identity: identityFor(s.customer_id, s.city) });

/** All customers matching an audience (the service pages at 500). */
async function allMatching(audience: Audience, sort: string, desc: boolean) {
  const first = await searchCustomers({ audience, sort, desc, limit: 500, offset: 0 });
  const items = [...first.items];
  for (let off = 500; off < first.total; off += 500) items.push(...(await searchCustomers({ audience, sort, desc, limit: 500, offset: off })).items);
  return items;
}

export async function listCustomers(body: { audience?: Audience; q?: string; sort?: string; desc?: boolean; limit?: number; offset?: number }): Promise<Page<CustomerRow>> {
  const { audience = {}, sort = "value_at_risk", desc = true, limit = 50, offset = 0 } = body;
  const q = body.q?.trim().toLowerCase();
  if (!q) {
    const page = await searchCustomers({ audience, sort, desc, limit, offset });
    return { ...page, items: page.items.map(row) };
  }
  // Names are synthetic, so text search runs here over id, name, email, city and products.
  const hits = (await allMatching(audience, sort, desc)).map(row).filter((r) => {
    const hay = `${r.customer_id} ${r.identity.name} ${r.identity.email} ${r.city ?? ""} ${r.products.join(" ")} ${r.segments.join(" ")} ${r.pains.join(" ")}`.toLowerCase();
    return q.split(/\s+/).every((t) => hay.includes(t));
  });
  return { total: hits.length, limit, offset, items: hits.slice(offset, offset + limit) };
}

interface EnergyRow {
  contract_id: string;
  commodity: string;
  tariff: string;
  status: string;
  dunning_level: number;
  price_guarantee_until: string | null;
  payment_method: string;
  annual_consumption_kwh: number | null;
  energy_price_eur_kwh: number | null;
  meter_type: string | null;
}
interface MobileRow {
  contract_id: string;
  plan: string;
  sim_count: number;
  esim: boolean;
  data_limit_reached_3m: number | boolean;
  past_min_term: boolean;
}
interface OrderRow {
  product_name: string;
  product_category: string;
  order_status: string;
  month: string;
}
interface TicketRow {
  ticket_id: string;
  category: string;
  status: string;
  channel: string;
  created_at: string;
}

const rows = <T>(dataset: string, fields: string[], id: string) =>
  queryRows<T>(dataset, fields, [{ field: "customer_id", value: id }], 100)
    .then((r) => r.rows)
    .catch(() => [] as T[]);

const CATEGORY: Record<string, string> = {
  billing: "Bill / installment",
  tariff: "Tariff",
  moving: "Moving",
  meter: "Meter reading",
  autostrom: "Autostrom charging",
  complaint: "Complaint",
  mobile: "Mobile",
  hems: "Energy manager",
  smart_living: "Smart living",
  shop: "Shop order",
};

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const days = (iso: string) => Math.round((new Date("2026-09-30T23:59:00").getTime() - new Date(iso.replace(" ", "T")).getTime()) / 86400000);

/** Problems the 01.10. event stream added after the snapshot. */
function liveProblems(live: LiveFacts | undefined): Problem[] {
  if (!live) return [];
  const out: Problem[] = [];
  if (live.callback) out.push({ key: "live-callback", label: "Callback requested", detail: "The customer asked for a callback about the open complaint (01.10.).", severity: "high" });
  if (live.withdrawn.length)
    out.push({ key: "live-consent", label: "Consent withdrawn today", detail: `${live.withdrawn.map((w) => w.replace(/_/g, " ")).join(", ")} withdrawn. Kompass stopped these channels at once and cancelled queued messages.`, severity: "medium" });
  if (live.retention) out.push({ key: "live-retention", label: "Comparing offers", detail: live.retention, severity: "high" });
  if (live.failedToday) out.push({ key: "live-charging", label: "Charging failed again today", detail: `${live.failedToday} failed session${live.failedToday > 1 ? "s" : ""} on 01.10.`, severity: "high" });
  if (live.blockingMinutes) out.push({ key: "live-blocking", label: "Blocking fee coming", detail: `${live.blockingMinutes} minutes at the charger after charging; the late roaming record arrived only now.`, severity: "medium" });
  if (live.heatPump) out.push({ key: "live-heatpump", label: "Gas meter deregistered", detail: `Effective ${dateDe(live.heatPump)}: a new heat pump is likely.`, severity: "low" });
  if (live.cart) out.push({ key: "live-cart", label: "Cart abandoned", detail: `Left “${live.cart}” in the shop cart.`, severity: "low" });
  return out;
}

function problemsFor(f: Record<string, unknown>, energy: EnergyRow[], mobile: MobileRow[], tickets: TicketRow[], live?: LiveFacts): Problem[] {
  const out: Problem[] = liveProblems(live);
  const dunning = Math.max(num(f.max_dunning_level), live?.dunningLevel ?? 0, ...energy.map((e) => num(e.dunning_level)));
  if (dunning > 0) out.push({ key: "dunning", label: "Missed payments", detail: `Dunning level ${dunning}${dunning >= 2 ? ": sales are paused until it is settled" : ""}`, severity: dunning >= 2 ? "high" : "medium" });
  if (f.cancellation_pending) out.push({ key: "cancellation", label: "Cancellation pending", detail: "The customer has given notice. Win-back by phone, no sales mail.", severity: "high" });
  if (f.open_complaint) out.push({ key: "complaint", label: "Open complaint", detail: "Resolve before any offer (service first).", severity: "high" });
  const open = tickets.filter((t) => t.status !== "closed" && t.status !== "resolved");
  const meter = tickets.filter((t) => t.category === "meter");
  if (meter.length) {
    const openMeter = meter.filter((t) => open.includes(t));
    out.push({
      key: "meter",
      label: openMeter.length ? "Meter reading disputed" : "Meter reading issues",
      detail: `${meter.length} meter ticket${meter.length > 1 ? "s" : ""}${openMeter.length ? `, ${openMeter.length} open` : ""}; last ${dateDe(meter[0].created_at)}`,
      severity: openMeter.length ? "medium" : "low",
      since: meter[meter.length - 1].created_at,
    });
  }
  const unanswered = open.filter((t) => t.category !== "meter" && t.category !== "complaint");
  for (const t of unanswered.slice(0, 3))
    out.push({ key: `open-${t.ticket_id}`, label: `Open request: ${CATEGORY[t.category] ?? t.category}`, detail: `Since ${dateDe(t.created_at)} (${days(t.created_at)} days), via ${t.channel}`, severity: days(t.created_at) > 7 ? "medium" : "low", since: t.created_at });
  const failed30 = num(f.failed_charges_30d);
  const failedAll = num(f.failed_charges_total);
  const billed = num(f.billed_failed_charges_eur);
  if (failed30 > 0 || billed > 0) {
    // Old failures with money still billed: the open part is the refund, not the charging.
    const sessions = failed30 > 0 ? `${failed30} failed session${failed30 === 1 ? "" : "s"} in 30 days` : `${failedAll || "earlier"} failed session${failedAll === 1 ? "" : "s"}, none in the last 30 days`;
    out.push({
      key: "charging",
      label: failed30 > 0 ? "Failed charging" : "Refund due for failed charging",
      detail: `${sessions}${billed > 0 ? `; ${billed.toFixed(2).replace(".", ",")} € billed for failed sessions` : ""}`,
      severity: billed > 0 || failed30 >= 3 ? "high" : "medium",
    });
  }
  if (f.hems_offline) out.push({ key: "hems", label: "Energy manager offline", detail: "The HEMS device has lost its connection.", severity: "medium" });
  const limit = mobile.find((m) => num(m.data_limit_reached_3m) > 0 || m.data_limit_reached_3m === true);
  if (limit) out.push({ key: "data_limit", label: "Data limit reached", detail: `${limit.plan}: hit the data limit in the last 3 months`, severity: "low" });
  if (f.autostrom_cancelled) out.push({ key: "autostrom_cancelled", label: "Autostrom cancelled", detail: "Cancelled the charging contract.", severity: "medium" });
  const withdrawn = (f.withdrawn_consents as string[] | undefined) ?? [];
  if (withdrawn.length) out.push({ key: "consent", label: "Consent withdrawn", detail: `No more ${withdrawn.map((w) => w.replace(/_/g, " ")).join(", ")}. Kompass leaves these channels out.`, severity: "low" });
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

const TARIFF_LABEL: Record<string, string> = { electricity: "Electricity", gas: "Gas" };

export async function customer360(id: string): Promise<Customer360> {
  const [profile, timeline, energy, mobile, orders, tickets] = await Promise.all([
    getProfile(id).then((p) => overlayProfile(id, p)),
    getTimeline(id).catch(() => []),
    rows<EnergyRow>("energy_contracts", ["contract_id", "commodity", "tariff", "status", "dunning_level", "price_guarantee_until", "payment_method", "annual_consumption_kwh", "energy_price_eur_kwh", "meter_type"], id),
    rows<MobileRow>("mobile_contracts", ["contract_id", "plan", "sim_count", "esim", "data_limit_reached_3m", "past_min_term"], id),
    rows<OrderRow>("shop_orders", ["product_name", "product_category", "order_status", "month"], id),
    rows<TicketRow>("service_tickets", ["ticket_id", "category", "status", "channel", "created_at"], id),
  ]);
  tickets.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const f = profile.features;
  const contracts: Contract[] = [
    ...energy.map((e) => {
      const kwh = num(e.annual_consumption_kwh);
      const price = num(e.energy_price_eur_kwh);
      return {
        kind: "energy" as const,
        id: e.contract_id,
        title: `${e.tariff} · ${TARIFF_LABEL[e.commodity] ?? e.commodity}`,
        status: e.status,
        detail: [kwh ? `${kwh.toLocaleString("de-DE")} kWh/year` : "", e.meter_type ? `${e.meter_type} meter` : "", e.payment_method].filter(Boolean).join(" · "),
        guaranteeUntil: e.price_guarantee_until,
        monthlyEur: kwh && price ? Math.round((kwh * price) / 12) : null,
      };
    }),
    ...mobile.map((m) => ({
      kind: "mobile" as const,
      id: m.contract_id,
      title: m.plan,
      status: "active",
      detail: [`${m.sim_count} SIM${m.sim_count > 1 ? "s" : ""}`, m.esim ? "eSIM" : "", m.past_min_term ? "past minimum term" : "in minimum term"].filter(Boolean).join(" · "),
    })),
    ...(f.has_autostrom
      ? [
          {
            kind: "autostrom" as const,
            id: `AS-${id.slice(3)}`,
            title: "Autostrom",
            status: f.autostrom_cancelled ? "cancelled" : "active",
            detail: `${num(f.charge_sessions)} sessions, ${Math.round(num(f.charged_kwh))} kWh charged${num(f.dc_share) ? `, ${Math.round(num(f.dc_share) * 100)} % fast charging` : ""}`,
          },
        ]
      : []),
  ];
  const PROPOSAL_STATUS = { pending: "waiting for approval", approved: "approved", rejected: "rejected", cancelled: "stopped" } as const;
  const KIND = { message: "Message", task: "Task", voucher: "Voucher", survey: "Survey", notify: "Team note" } as const;
  const via = (c: string) => CHANNEL_NAME[c] ?? c.replace(/_/g, " ");
  const kompass = [
    ...ws.sends.filter((s) => s.customerId === id).map((s) => ({ at: s.at, text: `Queued via ${via(s.channel)} (${ws.campaigns.find((c) => c.id === s.campaignId)?.name ?? ws.automations.find((a) => a.id === s.campaignId)?.name ?? "approved draft"})` })),
    ...ws.proposals
      .filter((p) => p.customerId === id)
      .map((p) => ({
        at: p.createdAt,
        text: `${KIND[p.kind]}${p.kind === "task" || p.kind === "notify" ? "" : ` via ${via(p.channel)}`} ${PROPOSAL_STATUS[p.status]}${p.status === "cancelled" && p.cancelReason ? `: ${p.cancelReason}` : ""} · ${p.source.name}`,
      })),
    // What the live stream made Kompass decide for this customer today.
    ...(ws.live?.decisions ?? []).filter((d) => d.customerId === id).map((d) => ({ at: d.at, text: `${d.eventLabel} → ${d.headline}` })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return {
    profile,
    identity: identityFor(id, profile.summary.city),
    problems: problemsFor(f, energy, mobile, tickets, factsFor(id)),
    contracts,
    orders: orders.map((o) => ({ product: o.product_name, category: o.product_category, status: o.order_status, month: o.month })).sort((a, b) => b.month.localeCompare(a.month)),
    timeline,
    kompass,
    spend: {
      monthlyInstallmentsEur: contracts.reduce((s, c) => s + (c.monthlyEur ?? 0), 0),
      shopEur: num(f.shop_value_eur),
      chargingEur: Math.round(num(f.charged_kwh) * 0.49),
    },
  };
}
