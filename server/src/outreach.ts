// Guided outreach, step 1: ready-made audiences built from the insights service's own analyses
// (segments, pains, guarantee calendar, savings, best offers, churn drivers) and each customer's
// best time of day, derived from when they were actually active.
import type { AudienceCard, BestTimes, Campaign, TimeSlot } from "../../shared/types.ts";
import { planCampaign } from "./campaigns.ts";
import { hourOf, loadDataset } from "./datasets.ts";
import { log, timed } from "./log.ts";
import { ins, mapLimit } from "./upstream.ts";

// ---------- Audience gallery ----------

const SEGMENT_TITLES: Record<string, string> = {
  price_watcher: "Price watchers",
  energy_without_mobile: "Energy customers without mobile",
  mover: "Moving house",
  ev_driver: "EV drivers",
  connected_household: "Households with several products",
  ev_without_wallbox: "EV drivers without a wallbox",
  smart_meter_without_hems: "Smart meter, no energy manager",
  price_guarantee_ending: "Price guarantee ends soon",
  service_recovery: "Customers with an open problem",
  frustrated_customer: "Frustrated customers",
  energy_transformer: "Electrifying their home",
  mobile_free_to_leave: "Mobile contract free to leave",
  savings_komfort_to_aktiv: "Paying too much on StromKomfort",
  refund_failed_charging: "Billed for failed charging",
  autostrom_only: "Only Autostrom",
  prosumer_without_hems: "Solar, no energy manager",
  extra_sim: "Household on one SIM",
  mobile_upgrade: "Hitting the data limit",
  heat_pump_switch: "Likely a new heat pump",
  no_active_line: "No active product left",
};
const PAIN_TITLES: Record<string, string> = {
  no_answer: "Waited for an answer",
  bill_shock: "Bill higher than expected",
  price_concern: "Worried about prices",
  charging_failure: "Charging failed",
  charging_bill: "Questions about the charging bill",
  data_volume: "Running out of mobile data",
  moving: "Moving house",
  heat_pump_interest: "Interested in a heat pump",
  device_offline: "Device offline",
  upset: "Upset or complaining",
};
/** Churn signals: the service labels them with symbols ("Last CSAT <= 2"); the cards say it in words. */
const DRIVER_TITLES: Record<string, string> = {
  tickets_12m_ge2: "2 or more service tickets in 12 months",
  price_guarantee_ends_90d: "Price guarantee ends within 90 days",
  low_csat: "Unhappy with their last service contact",
  open_complaint: "Open complaint",
  dunning: "In dunning, level 2 or higher",
  cancellation_pending: "Cancellation pending",
  failed_charges_30d: "3 or more failed charging sessions in 30 days",
  multi_product: "Several MAINGAU products",
  hems_user: "Uses an energy manager (HEMS)",
};
/** One sentence per ready-made audience: what the campaign is for. It fills the goal field in step 1. */
const SEGMENT_GOALS: Record<string, string> = {
  price_watcher: "Keep customers who compare prices with a fair, honest offer",
  energy_without_mobile: "Show energy customers a mobile plan that fits them",
  mover: "Make moving easy: take the contract along or set up the new address",
  ev_driver: "Keep EV drivers charging with MAINGAU",
  connected_household: "Keep households that use several MAINGAU products",
  ev_without_wallbox: "Show EV drivers who charge in public how a home wallbox helps",
  smart_meter_without_hems: "Show smart meter customers what an energy manager adds",
  price_guarantee_ending: "Keep customers whose price guarantee ends soon with a fair follow-up tariff",
  service_recovery: "Solve open problems first, then stay in touch",
  frustrated_customer: "Win back frustrated customers: listen and fix first",
  energy_transformer: "Support customers who are electrifying their home",
  mobile_free_to_leave: "Keep mobile customers whose minimum term is over",
  savings_komfort_to_aktiv: "Tell StromKomfort customers honestly that StromAktiv would cost them less",
  refund_failed_charging: "Refund charging sessions that were billed although they failed",
  autostrom_only: "Show customers who only use Autostrom what else MAINGAU offers",
  prosumer_without_hems: "Show solar customers how an energy manager raises their self-consumption",
  extra_sim: "Offer households a second SIM",
  mobile_upgrade: "Help customers who run out of mobile data",
  heat_pump_switch: "Support customers who are likely switching to a heat pump",
  no_active_line: "Win back customers who have no active product left",
};
const SERVICE_FIRST = new Set(["service_recovery", "frustrated_customer", "refund_failed_charging", "upset", "no_answer", "charging_failure", "device_offline", "charging_refund", "P-SV-01"]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const firstSentence = (s: string) => (s.split(/(?<=[.:])\s/)[0] ?? s).replace(/[.:]$/, "");
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The service writes some labels with symbols ("<= 2", "2+", "> 90 %"); the cards say them in words. */
const inWords = (s: string) =>
  s
    .replace(/\bCSAT\s*<=\s*(\d+)/gi, "satisfaction score $1 or lower")
    .replace(/(\d+)\+/g, "$1 or more")
    .replace(/>=\s*(\d+)/g, "$1 or higher")
    .replace(/<=\s*(\d+)/g, "$1 or lower")
    .replace(/>\s*(\d+)/g, "more than $1")
    .replace(/<\s*(\d+)/g, "less than $1");

interface SegmentRow {
  kind: "segment" | "persona";
  key: string;
  description: string;
  stats: { customers: number; value_at_risk_eur: number; churn_avg: number; reachable: number };
}
interface PainRow {
  pain: string;
  description: string;
  customers: number;
  churn_avg: number;
  value_at_risk_eur: number;
  open_ticket_share: number;
}
interface GuaranteeRow {
  month: string;
  customers: number;
  by_tariff: Record<string, number>;
}
interface SavingRow {
  kind: string;
  title: string;
  basis: "data" | "assumption";
  customers: number;
  reachable_customers: number;
  annual_saving_total_eur: number;
  one_off_saving_total_eur: number;
  annual_saving_avg_eur: number;
}
interface OfferRow {
  offer_id: string;
  product_name: string;
  action_type: string;
  disabled: boolean;
  best_for_customers: number;
  best_dclv_total_eur: number;
  uplift_pp: number | null;
}
interface DriverRow {
  key: string;
  label: string;
  effect: "risk" | "protective";
  customers: number;
  value_at_risk_eur: number;
  churn_avg: number;
}

let gallery: { at: number; cards: Promise<AudienceCard[]> } | null = null;

export function audienceCards(): Promise<AudienceCard[]> {
  if (gallery && Date.now() - gallery.at < 10 * 60_000) return gallery.cards;
  const cards = timed("outreach", "audience gallery", buildCards, 6000).then((list) => {
    log.info("outreach", `audience gallery built: ${list.length} cards`, Object.fromEntries(["risk", "pains", "guarantee", "savings", "offers"].map((g) => [g, list.filter((x) => x.group === g).length])));
    return list;
  });
  gallery = { at: Date.now(), cards };
  cards.catch(() => (gallery = null));
  return cards;
}

async function buildCards(): Promise<AudienceCard[]> {
  const [segments, pains, calendar, savings, offers, drivers, customers, contracts] = await Promise.all([
    ins.get<SegmentRow[]>("/segments"),
    ins.get<PainRow[]>("/pains"),
    ins.get<GuaranteeRow[]>("/retention/guarantee-calendar"),
    ins.get<SavingRow[]>("/savings/summary"),
    ins.get<OfferRow[]>("/growth/offers"),
    ins.get<DriverRow[]>("/retention/drivers"),
    loadDataset<{ customer_id: string; clv_eur: number | null; churn_prob_12m: number | null }>("customers", ["customer_id", "clv_eur", "churn_prob_12m"]),
    loadDataset<{ customer_id: string; guarantee_month: string | null; status: string }>("energy_contracts", ["customer_id", "guarantee_month", "status"]),
  ]);
  const atRisk = new Map(customers.map((c) => [c.customer_id, (c.clv_eur ?? 0) * (c.churn_prob_12m ?? 0)]));
  const cards: AudienceCard[] = [];

  // Biggest risk: segments and personas (a persona with the same key as a segment is the same group).
  const seen = new Set<string>();
  for (const s of [...segments].sort((a, b) => b.stats.value_at_risk_eur - a.stats.value_at_risk_eur)) {
    if (seen.has(s.key) || s.stats.customers < 10 || s.stats.value_at_risk_eur < 500) continue;
    seen.add(s.key);
    const title = SEGMENT_TITLES[s.key] ?? sentence(s.key.replace(/_/g, " "));
    cards.push({
      id: `${s.kind === "persona" ? "persona" : "seg"}:${s.key}`,
      group: "risk",
      title,
      description: inWords(firstSentence(s.description)),
      customers: s.stats.customers,
      reachable: s.stats.reachable,
      metric: { label: "value at risk", eur: s.stats.value_at_risk_eur },
      churnAvg: s.stats.churn_avg,
      audience: s.kind === "persona" ? { personas: [s.key] } : { segments: [s.key] },
      offerMode: SERVICE_FIRST.has(s.key) ? "service" : "engine",
      goal: SEGMENT_GOALS[s.key] ?? `Keep customers in this group: ${lowerFirst(title)}`,
    });
  }
  for (const d of drivers) {
    if (d.effect !== "risk" || d.customers < 5) continue;
    const title = DRIVER_TITLES[d.key] ?? sentence(inWords(d.label));
    cards.push({
      id: `driver:${d.key}`,
      group: "risk",
      title,
      description: `Churn signal: on average ${Math.round(d.churn_avg * 100)} % may leave within 12 months`,
      customers: d.customers,
      metric: { label: "value at risk", eur: d.value_at_risk_eur },
      churnAvg: d.churn_avg,
      audience: { churn_drivers: [d.key] },
      offerMode: ["open_complaint", "low_csat", "dunning", "cancellation_pending"].includes(d.key) ? "service" : "engine",
      goal: `Keep customers who show this warning sign: ${lowerFirst(title)}`,
    });
  }

  // Pains: what customers wrote or called about.
  for (const p of pains) {
    const title = PAIN_TITLES[p.pain] ?? sentence(p.pain.replace(/_/g, " "));
    cards.push({
      id: `pain:${p.pain}`,
      group: "pains",
      title,
      description: `${Math.round(p.open_ticket_share * 100)} % still have an open ticket · churn ${Math.round(p.churn_avg * 100)} %`,
      customers: p.customers,
      metric: { label: "value at risk", eur: p.value_at_risk_eur },
      churnAvg: p.churn_avg,
      audience: { pains: [p.pain] },
      offerMode: SERVICE_FIRST.has(p.pain) ? "service" : "engine",
      goal: `Help customers who said: ${inWords(p.description)}`,
    });
  }

  // Guarantee ending: the next four months after the data snapshot (30.09.2026).
  const byMonth = new Map<string, Set<string>>();
  for (const r of contracts) {
    if (r.status !== "active" || !r.guarantee_month) continue;
    (byMonth.get(r.guarantee_month) ?? byMonth.set(r.guarantee_month, new Set()).get(r.guarantee_month)!).add(r.customer_id);
  }
  for (const g of calendar.filter((m) => m.month > "2026-09").slice(0, 4)) {
    const ids = [...(byMonth.get(g.month) ?? [])];
    if (!ids.length) continue;
    const [y, m] = g.month.split("-").map(Number);
    const name = `${MONTHS[m - 1]}${y !== 2026 ? ` ${y}` : ""}`;
    cards.push({
      id: `guar:${g.month}`,
      group: "guarantee",
      title: `Price guarantee ends in ${name}`,
      description: Object.entries(g.by_tariff)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t, n]) => `${n} on ${t}`)
        .join(" · "),
      customers: ids.length,
      metric: { label: "value at risk", eur: Math.round(ids.reduce((s, id) => s + (atRisk.get(id) ?? 0), 0) * 100) / 100 },
      audience: { customer_ids: ids },
      offerMode: "engine",
      goal: `Keep customers whose price guarantee ends in ${name} with a fair follow-up tariff`,
    });
  }

  // Can save money: honest savings from the customer's own data first, then typical values.
  const savingIds = await mapLimit(savings, 4, (s) =>
    ins.get<{ items: { customer_id: string }[] }>(`/savings/opportunities?kind=${encodeURIComponent(s.kind)}&limit=500`).then((r) => [...new Set(r.items.map((i) => i.customer_id))]).catch(() => [] as string[]),
  );
  const savingCards: AudienceCard[] = [];
  savings.forEach((s, i) => {
    const ids = savingIds[i];
    if (!ids.length) return;
    const oneOff = s.annual_saving_total_eur === 0 && s.one_off_saving_total_eur > 0;
    savingCards.push({
      id: `save:${s.kind}`,
      group: "savings",
      title: s.title,
      description: oneOff ? "A one-off refund, from the customer's own sessions" : `On average ${Math.round(s.annual_saving_avg_eur)} € a year · ${s.basis === "data" ? "from the customer's own data" : "estimate from typical values"}`,
      customers: ids.length,
      reachable: s.reachable_customers,
      metric: { label: oneOff ? "to refund" : "saving a year", eur: oneOff ? s.one_off_saving_total_eur : s.annual_saving_total_eur },
      audience: { customer_ids: ids },
      offerMode: SERVICE_FIRST.has(s.kind) ? "service" : "engine",
      goal: oneOff ? `Proactively refund: ${s.title.toLowerCase()}` : `Show customers an honest saving: ${s.title}`,
      basis: s.basis,
    });
  });
  cards.push(...savingCards.sort((a, b) => (a.basis === b.basis ? b.metric.eur - a.metric.eur : a.basis === "data" ? -1 : 1)));

  // Best offer: customers for whom the engine's best next step is this offer.
  for (const o of [...offers].sort((a, b) => b.best_dclv_total_eur - a.best_dclv_total_eur)) {
    if (o.disabled || o.best_for_customers < 3) continue;
    cards.push({
      id: `offer:${o.offer_id}`,
      group: "offers",
      title: o.action_type === "service" ? "Service first, no offer" : o.product_name,
      description: `The best next step for these customers${o.uplift_pp != null ? ` · past uplift vs control ${o.uplift_pp > 0 ? "+" : ""}${o.uplift_pp.toFixed(1).replace(".", ",")} pp` : ""}`,
      customers: o.best_for_customers,
      metric: { label: "expected CLV gain", eur: o.best_dclv_total_eur },
      audience: { best_action_in: [o.offer_id] },
      offerMode: o.action_type === "service" ? "service" : "engine",
      goal: o.action_type === "service" ? "Solve open service issues first" : `Offer ${o.product_name} where it is the best next step`,
    });
  }
  return cards;
}

// ---------- Best time per customer ----------

const SLOTS: { key: TimeSlot; label: string; hours: string; sendAt: string; from: number }[] = [
  { key: "morning", label: "Morning", hours: "7–11 h", sendAt: "09:00", from: 0 },
  { key: "midday", label: "Midday", hours: "11–15 h", sendAt: "12:30", from: 11 },
  { key: "afternoon", label: "Afternoon", hours: "15–18 h", sendAt: "16:00", from: 15 },
  { key: "evening", label: "Evening", hours: "18–22 h", sendAt: "19:00", from: 18 },
];
const slotOf = (h: number): TimeSlot => [...SLOTS].reverse().find((s) => h >= s.from)!.key;
const POSITIVE = new Set(["viewed", "clicked"]);

/**
 * For every contact of the campaign: the time slot with the most own activity. Signals are offers
 * the customer viewed, clicked or bought (weight 3), charging starts and tickets they opened. With
 * fewer than 3 signals a customer gets the audience's best slot for their channel.
 */
export const bestTimes = (c: Campaign) => timed("outreach", `best times for ${c.id}`, () => computeBestTimes(c), 5000);

async function computeBestTimes(c: Campaign): Promise<BestTimes & { byCustomer: Record<string, TimeSlot> }> {
  const plan = c.plan ?? (await planCampaign(c));
  const contacts = plan.rows.filter((r) => r.status === "contact");
  const ids = new Set(contacts.map((r) => r.customer_id));
  const [nba, charges, tickets] = await Promise.all([
    loadDataset<{ customer_id: string; response: string; converted: boolean; control_group: boolean; decided_at: string }>("nba_actions", ["customer_id", "response", "converted", "control_group", "decided_at"]),
    loadDataset<{ customer_id: string; started_at: string }>("charge_sessions", ["customer_id", "started_at"]),
    loadDataset<{ customer_id: string; created_at: string }>("service_tickets", ["customer_id", "created_at"]),
  ]);
  const activity = new Map<string, number[]>();
  const add = (id: string, at: string, w: number) => {
    if (!ids.has(id)) return;
    const h = hourOf(at);
    if (h == null) return;
    const a = activity.get(id) ?? activity.set(id, new Array(24).fill(0)).get(id)!;
    a[h] += w;
  };
  for (const r of nba) if (!r.control_group && (POSITIVE.has(r.response) || r.converted)) add(r.customer_id, r.decided_at, 3);
  for (const r of charges) add(r.customer_id, r.started_at, 1);
  for (const r of tickets) add(r.customer_id, r.created_at, 1);

  const hours = new Array(24).fill(0);
  const byCustomer: Record<string, TimeSlot> = {};
  const channelVotes = new Map<string, Record<TimeSlot, number>>();
  const vote = (ch: string, s: TimeSlot) => {
    const v = channelVotes.get(ch) ?? channelVotes.set(ch, { morning: 0, midday: 0, afternoon: 0, evening: 0 }).get(ch)!;
    v[s]++;
  };
  let withSignals = 0;
  for (const r of contacts) {
    const a = activity.get(r.customer_id);
    const total = a ? a.reduce((s, x) => s + x, 0) : 0;
    if (!a || total < 3) continue;
    a.forEach((w, h) => (hours[h] += w));
    const perSlot: Record<TimeSlot, number> = { morning: 0, midday: 0, afternoon: 0, evening: 0 };
    a.forEach((w, h) => (perSlot[slotOf(h)] += w));
    const best = (Object.entries(perSlot) as [TimeSlot, number][]).sort((x, y) => y[1] - x[1])[0][0];
    byCustomer[r.customer_id] = best;
    vote(r.action?.channel ?? "?", best);
    vote("*", best);
    withSignals++;
  }
  const top = (v?: Record<TimeSlot, number>) => (v ? (Object.entries(v) as [TimeSlot, number][]).sort((x, y) => y[1] - x[1])[0][0] : undefined);
  for (const r of contacts) if (!byCustomer[r.customer_id]) byCustomer[r.customer_id] = top(channelVotes.get(r.action?.channel ?? "?")) ?? top(channelVotes.get("*")) ?? "morning";

  const slots = SLOTS.map(({ from: _from, ...s }) => ({ ...s, customers: Object.values(byCustomer).filter((x) => x === s.key).length }));
  const lead = [...slots].sort((a, b) => b.customers - a.customers)[0];
  const headline = !contacts.length
    ? "No contacts yet: choose an audience first"
    : !withSignals
      ? "Too little activity data in this audience: everyone gets the morning slot"
      : `Most are active ${lead.label.toLowerCase() === "midday" ? "around midday" : `in the ${lead.label.toLowerCase()}`} (${lead.hours}): ${Math.round((lead.customers / contacts.length) * 100)} % get their message at ${lead.sendAt}`;
  log.debug("outreach", `best times for ${c.id}: ${withSignals} of ${contacts.length} customers have their own activity`, { slots: slots.map((x) => `${x.sendAt} ${x.customers}`) });
  return { customers: contacts.length, withSignals, hours, slots, headline, byCustomer };
}
