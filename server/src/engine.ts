// The live decision layer. The insights service ranks actions on the 30.09. snapshot; this module
// re-ranks them for "now": it applies what the event stream delivered since (a withdrawn consent
// closes its channel at once, dunning or an open complaint blocks sales, an agent's "customer upset"
// pauses offers), lifts offers a fresh signal points to, prices a sales contact during a service case
// as the churn risk it is, and drops what scores negative. Every place that decides or renders for a
// customer reads the profile through overlayProfile(), so the 360, campaigns, automations and
// approvals agree.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BestAction, CustomerProfile, LiveAction, LiveFacts, LiveRule, Tone } from "../../shared/types.ts";
import { log } from "./log.ts";
import { ws, type LiveStore } from "./workspace.ts";

/** The data snapshot the insights service was built from; the replayed day starts after it. */
export const SNAPSHOT_END = "2026-09-30 23:59:59";

/** Channels each consent opens. Profiling is separate: without it nothing may be personalised. */
export const CONSENT_CHANNELS: Record<string, string[]> = {
  marketing_email: ["email"],
  newsletter_email: ["newsletter"],
  marketing_sms: ["sms"],
  marketing_phone: ["outbound_call"],
  portal_app_personalisation: ["portal_popup"],
};

// value_assumptions.csv (mock data): contact costs and the churn a sales contact adds during a service case.
const CONTACT_COST: Record<string, number> = { email: 0.01, newsletter: 0.01, sms: 0.08, portal_popup: 0, outbound_call: 6, service_contact: 0 };
const SERVICE_CASE_CHURN = 0.05;
const SERVICE_RESOLUTION_COST = 15;
/** Present value of 1 €/year: 10 years, 6 % discount, 14 % base churn (value_assumptions). */
const ANNUITY = 3.76;
const CHANNEL_ORDER = ["portal_popup", "email", "newsletter", "sms", "outbound_call"];
export const CHANNEL_NAME: Record<string, string> = { email: "email", newsletter: "newsletter", sms: "SMS", portal_popup: "portal pop-up", outbound_call: "phone", service_contact: "service contact" };

// ---------- Product catalog (mock data) ----------

interface CatalogItem {
  id: string;
  name: string;
  type: string;
  margin: number;
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

export const CATALOG: Map<string, CatalogItem> = (() => {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "maingau_nba_mockdata_csv_jsonl", "csv", "product_catalog.csv");
  try {
    return new Map(parseCsv(readFileSync(file, "utf8")).map((r) => [r.product_id, { id: r.product_id, name: r.product_name, type: r.action_type, margin: Number(r.annual_margin_if_bought_eur) || 0 }]));
  } catch (e) {
    log.error("engine", "product catalog not readable, signal offers without an upstream estimate are skipped", e);
    return new Map();
  }
})();

const SHOP_PRODUCT: Record<string, string> = { "Wallbox 11 kW": "P-SH-02", "Balkonkraftwerk 800 W": "P-SH-01", "Smarte Thermostate 3er": "P-SH-03", "Smart Plug 4er-Set": "P-SH-04" };

// ---------- Facts store ----------

export const emptyFacts = (): LiveFacts => ({ withdrawn: [], failedToday: 0, dismissed: [], hasIt: [], events: 0 });

export const newLiveStore = (): LiveStore => ({ clock: SNAPSHOT_END, morningRun: false, facts: {}, decisions: [], desk: [], feedback: [], created: [], cancelled: [] });

export const liveClock = () => ws.live?.clock ?? SNAPSHOT_END;

export function factsFor(id: string): LiveFacts | undefined {
  return ws.live?.facts[id];
}

export function factsOf(id: string): LiveFacts {
  ws.live ??= newLiveStore();
  return (ws.live.facts[id] ??= emptyFacts());
}

/** Reasons from the stream that block sales content right now. */
export function liveBlockers(f: LiveFacts | undefined, clock = liveClock()): string[] {
  if (!f) return [];
  const out: string[] = [];
  if ((f.dunningLevel ?? 0) >= 1) out.push(`dunning level ${f.dunningLevel}`);
  if (f.complaint) out.push("open complaint");
  if (f.cancellation) out.push(`${f.cancellation} cancellation received`);
  if (f.upsetUntil && f.upsetUntil > clock) out.push("customer upset (agent feedback)");
  return out;
}

export function withdrawnChannels(f: LiveFacts | undefined) {
  return new Set((f?.withdrawn ?? []).flatMap((c) => CONSENT_CHANNELS[c] ?? []));
}

// ---------- Ranking ----------

export interface Ranked {
  actions: LiveAction[];
  blocked: { offerId: string; product: string; reason: string }[];
  rules: LiveRule[];
  salesBlockers: string[];
  allowedChannels: string[];
  profiling: boolean;
  serviceCase: boolean;
  tone: Tone;
}

interface Signal {
  offerId: string;
  p: number;
  why: string;
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
const eur = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(2).replace(".", ",")} €`;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Offers a fresh event points to, with the acceptance it justifies (pilot assumptions, shown in the reason). */
function signalsFrom(f: LiveFacts | undefined): Signal[] {
  if (!f) return [];
  const out: Signal[] = [];
  if (f.heatPump) out.push({ offerId: "P-EN-03", p: 0.3, why: `gas meter deregistered (effective ${f.heatPump}), so probably a new heat pump` });
  if (f.retention) out.push({ offerId: "P-EN-02", p: 0.45, why: f.retention });
  if (f.cancellation) out.push({ offerId: "P-EN-02", p: 0.2, why: `${f.cancellation} cancellation received: a renewed guarantee can save the contract` });
  if (f.cart && SHOP_PRODUCT[f.cart]) out.push({ offerId: SHOP_PRODUCT[f.cart], p: 0.25, why: `left “${f.cart}” in the shop cart` });
  for (const o of f.ordered ?? [])
    if (/wallbox/i.test(o)) {
      out.push({ offerId: "P-AS-01", p: 0.2, why: `bought a wallbox (“${o}”): charging on the road with Autostrom` });
      out.push({ offerId: "P-SL-03", p: 0.15, why: `bought a wallbox (“${o}”): smart charging at home` });
    } else if (/ladekabel|typ 2/i.test(o)) out.push({ offerId: "P-AS-01", p: 0.15, why: `bought a charging cable (“${o}”): drives an EV, so charging on the road with Autostrom` });
  if (f.clicked && /smart_living|hems/i.test(f.clicked)) out.push({ offerId: "P-SL-01", p: 0.12, why: `clicked “${f.clicked.replace(/_/g, " ")}” in a newsletter` });
  if (f.clicked && /waerme|wärme|heat/i.test(f.clicked)) out.push({ offerId: "P-EN-03", p: 0.15, why: `clicked “${f.clicked.replace(/_/g, " ")}” in a newsletter` });
  if ((f.dataThresholdPct ?? 0) >= 80) out.push({ offerId: "P-MO-02", p: f.dataThresholdPct! >= 100 ? 0.3 : 0.2, why: `used ${f.dataThresholdPct} % of the mobile data volume` });
  return out;
}

/** The offer makes no sense for this customer (already held, or nothing to retain), so a signal must not create it. */
function cannotOffer(p: CustomerProfile, offerId: string) {
  const f = p.features;
  const tariffs = String(f.energy_tariffs ?? "");
  switch (offerId) {
    case "P-EN-03":
      return /wärme/i.test(tariffs);
    case "P-EN-02":
      return !f.has_electricity;
    case "P-AS-01":
      return !!f.has_autostrom;
    case "P-SH-02":
      return !!f.owns_wallbox;
    case "P-SL-01":
      return !!f.hems_user;
    case "P-MO-02":
      return !f.has_mobile;
    default:
      return false;
  }
}

/** What a service agent should actually do, in one line. */
export function serviceInstruction(p: CustomerProfile, f: LiveFacts | undefined): string {
  const feat = p.features;
  const parts: string[] = [];
  if (f?.callback) parts.push("call back: the customer asked for a callback");
  if (f?.complaint || feat.open_complaint) parts.push("solve the open complaint first");
  const failed = num(feat.failed_charges_30d) + (f?.failedToday ?? 0);
  if (failed >= 1 && (failed >= 3 || f?.failedToday)) {
    const billed = num(feat.billed_failed_charges_eur);
    parts.push(`fix charging (${failed} failed session${failed > 1 ? "s" : ""} in 30 days)${billed ? ` and refund ${billed.toFixed(2).replace(".", ",")} € billed for failed sessions` : ""}`);
  }
  if (f?.blockingMinutes) parts.push(`explain the blocking fee (${f.blockingMinutes} min at the charger) before it shows on the invoice`);
  const dunning = Math.max(num(feat.max_dunning_level), f?.dunningLevel ?? 0);
  if (dunning >= 1) parts.push(`dunning level ${dunning}: no offers, leave payment questions to billing`);
  if (f?.cancellation) parts.push(`${f.cancellation} cancellation received: ask why before anything else`);
  if (f?.hemsOffline || feat.hems_offline) parts.push("HEMS gateway offline: help reconnect it");
  if (!parts.length) parts.push("resolve the open service case");
  const s = parts.join("; ");
  return s[0].toUpperCase() + s.slice(1);
}

export function rank(p: CustomerProfile, f: LiveFacts | undefined, clock = liveClock()): Ranked {
  const rules: LiveRule[] = [];
  const feat = p.features;
  const s = p.summary;
  const tone: Tone = /^du/i.test(p.contact_policy.salutation) ? "du" : "sie";

  const closed = withdrawnChannels(f);
  const allowed = p.contact_policy.allowed_channels.filter((c) => !closed.has(c));
  if (closed.size) rules.push({ rule: "Consent is binding", effect: `${[...closed].map((c) => CHANNEL_NAME[c] ?? c).join(", ")} closed after the withdrawal` });
  const profiling = p.contact_policy.profiling_allowed && !f?.withdrawn.includes("profiling_analytics");
  if (!profiling) rules.push({ rule: "Profiling needs consent", effect: "no personalised offers, service only" });
  const hard = [...new Set([...p.contact_policy.sales_blockers, ...liveBlockers(f, clock)])];
  if (hard.length) rules.push({ rule: "Exclusions beat offers", effect: `sales blocked: ${hard.join(", ")}` });
  const failed30 = num(feat.failed_charges_30d) + (f?.failedToday ?? 0);
  const serviceCase = hard.length > 0 || !!s.service_case || failed30 >= 3 || !!f?.blockingMinutes || !!f?.hemsOffline;
  const clv = Math.max(0, s.clv_eur ?? 0);
  const penalty = round2(SERVICE_CASE_CHURN * clv);

  const pool = new Map<string, BestAction>();
  for (const a of [...p.recommended_actions, ...p.suppressed_actions]) if (!pool.has(a.offer_id)) pool.set(a.offer_id, a);
  const signals = signalsFrom(f);
  for (const sig of signals) {
    rules.push({ rule: "Signal", effect: sig.why });
    const item = CATALOG.get(sig.offerId);
    if (pool.has(sig.offerId) || !item || cannotOffer(p, sig.offerId)) continue;
    // Not in the snapshot ranking: estimate from the catalog margin.
    const gain = item.type === "one_off" ? item.margin : item.margin * ANNUITY;
    pool.set(sig.offerId, {
      offer_id: sig.offerId,
      product_name: item.name,
      action_type: item.type,
      dclv_eur: round2(sig.p * gain),
      p_accept: sig.p,
      channel: null,
      reason: `${sig.why}: ${Math.round(sig.p * 100)} % likely · estimate from the catalog: ${item.margin} € margin${item.type === "one_off" ? " once" : `/year × ${ANNUITY} (10 years, 6 %, 14 % churn)`}`,
      blocked_by: null,
    });
  }

  const actions: LiveAction[] = [];
  const blocked: Ranked["blocked"] = [];
  let penalised = false;
  for (const a of pool.values()) {
    const block = (reason: string) => blocked.push({ offerId: a.offer_id, product: a.product_name, reason });
    if (f?.hasIt.includes(a.offer_id)) {
      block("agent: the customer already has it");
      continue;
    }
    if (f?.dismissed.includes(a.offer_id)) {
      block("agent: not relevant for this customer");
      continue;
    }
    const isService = a.action_type === "service";
    let pAccept = a.p_accept;
    let dclv = a.dclv_eur;
    let reason = a.reason;
    let channel: string | null;
    if (isService) {
      channel = "service_contact";
      reason = `${serviceInstruction(p, f)}. Solving it first is worth about ${eur(a.dclv_eur)} in customer value.`;
    } else {
      if (a.blocked_by) {
        block(a.blocked_by);
        continue;
      }
      if (!profiling) {
        block("no profiling consent: nothing personalised");
        continue;
      }
      if (hard.length) {
        block(`exclusion: ${hard.join(", ")}`);
        continue;
      }
      const want = a.channel;
      channel = want && allowed.includes(want) ? want : (CHANNEL_ORDER.find((c) => allowed.includes(c)) ?? null);
      if (!channel) {
        block("no consented channel");
        continue;
      }
      const costWant = CONTACT_COST[want ?? channel] ?? 0;
      const cost = CONTACT_COST[channel] ?? 0;
      if (want && want !== channel) {
        dclv = dclv + costWant - cost;
        reason += ` · ${CHANNEL_NAME[want] ?? want} closed, sent via ${CHANNEL_NAME[channel] ?? channel}`;
      }
      const sig = signals.find((x) => x.offerId === a.offer_id);
      if (sig && sig.p > pAccept) {
        const gain = pAccept > 0 ? (dclv + cost) / pAccept : dclv + cost;
        // The snapshot reason carries the old likelihood and value; keep only its "why" next to the new likelihood.
        const [head, ...rest] = reason.split(" · ");
        const why = head.split(" → ")[0].replace(/\s*\(churn [^)]*\)/, "");
        reason = [`${sig.why}: likelihood ${Math.round(pAccept * 100)} % → ${Math.round(sig.p * 100)} %`, why, ...rest].filter(Boolean).join(" · ");
        pAccept = sig.p;
        dclv = pAccept * gain - cost;
      }
      if (serviceCase && penalty > 0) {
        dclv -= penalty;
        penalised = true;
        reason += ` · ${eur(-penalty)} for selling during a service case`;
      }
    }
    dclv = round2(dclv);
    if (dclv <= 0) {
      // "Service-only / no offer" is the do-nothing baseline, not an offer anyone holds back.
      if (a.offer_id === "P-SV-01") continue;
      block(`scores ${eur(dclv)}${!isService && serviceCase ? " during the open service case" : ""}`);
      continue;
    }
    // Every service action carries the same instruction, so the customer gets one: the one worth most.
    const twin = isService ? actions.findIndex((x) => x.type === "service") : -1;
    if (twin >= 0) {
      if (actions[twin].dclvEur >= dclv) continue;
      actions.splice(twin, 1);
    }
    actions.push({ offerId: a.offer_id, product: a.product_name, type: a.action_type, dclvEur: dclv, pAccept: round2(pAccept), channel, tone, reason });
  }
  if (penalised) rules.push({ rule: "Service before sales", effect: `a sales contact during a service case adds 5 points churn: ${eur(-penalty)} on each offer (CLV ${clv.toFixed(0)} €)` });

  // A service case always gets a service action, even when the snapshot had none.
  if (serviceCase && !actions.some((a) => a.type === "service")) {
    const churnAdd = (f?.complaint || feat.open_complaint ? 0.12 : 0) + (Math.max(num(feat.max_dunning_level), f?.dunningLevel ?? 0) >= 2 ? 0.08 : 0) + (failed30 >= 3 ? 0.1 : 0) || 0.05;
    const dclv = round2(0.6 * churnAdd * clv - SERVICE_RESOLUTION_COST);
    actions.push({
      offerId: "P-SV-01",
      product: "Service first",
      type: "service",
      dclvEur: dclv,
      pAccept: 0.6,
      channel: "service_contact",
      tone,
      reason: `${serviceInstruction(p, f)}. Solving it lowers the churn risk by about ${Math.round(churnAdd * 100)} points: worth ${eur(dclv)} in customer value after ${SERVICE_RESOLUTION_COST} € handling`,
    });
  }

  actions.sort((x, y) => (serviceCase ? Number(y.type === "service") - Number(x.type === "service") : 0) || y.dclvEur - x.dclvEur);
  return { actions, blocked, rules, salesBlockers: hard, allowedChannels: allowed, profiling, serviceCase, tone };
}

const toBest = (a: LiveAction): BestAction => ({ offer_id: a.offerId, product_name: a.product, action_type: a.type, dclv_eur: a.dclvEur, p_accept: a.pAccept, channel: a.channel, reason: a.reason, blocked_by: null });

/** The profile as of the live clock: snapshot, live facts, and the live ranking. */
export function overlayWith(p: CustomerProfile, f: LiveFacts | undefined): CustomerProfile {
  const r = rank(p, f);
  const blockedBest = r.blocked.map((b) => ({ ...(pickAction(p, b.offerId) ?? { offer_id: b.offerId, product_name: b.product, action_type: "sales", dclv_eur: 0, p_accept: 0, channel: null, reason: "" }), blocked_by: b.reason }));
  const contact = p.summary.contact_channel && r.allowedChannels.includes(p.summary.contact_channel) ? p.summary.contact_channel : (r.allowedChannels[0] ?? null);
  const salesAllowed = p.contact_policy.sales_allowed && r.salesBlockers.length === 0 && r.profiling;
  return {
    ...p,
    contact_policy: { ...p.contact_policy, allowed_channels: r.allowedChannels, profiling_allowed: r.profiling, sales_allowed: salesAllowed, sales_blockers: r.salesBlockers },
    recommended_actions: r.actions.map(toBest),
    suppressed_actions: blockedBest,
    summary: { ...p.summary, contact_channel: contact, sales_blockers: r.salesBlockers, service_case: r.serviceCase, best_action: r.actions[0] ? toBest(r.actions[0]) : null },
    features: {
      ...p.features,
      profiling_allowed: r.profiling,
      marketing_channels: r.allowedChannels,
      ...(f?.dunningLevel != null ? { max_dunning_level: Math.max(num(p.features.max_dunning_level), f.dunningLevel) } : {}),
      ...(f?.complaint ? { open_complaint: true } : {}),
      ...(f?.cancellation ? { cancellation_pending: true } : {}),
      ...(f?.heatPump ? { gas_meter_deregistered: true } : {}),
      ...(f?.failedToday ? { failed_charges_30d: num(p.features.failed_charges_30d) + f.failedToday } : {}),
    },
  };
}

const pickAction = (p: CustomerProfile, id: string) => [...p.recommended_actions, ...p.suppressed_actions].find((a) => a.offer_id === id);

export function overlayProfile(id: string, p: CustomerProfile): CustomerProfile {
  try {
    return overlayWith(p, factsFor(id));
  } catch (e) {
    log.error("engine", `overlay failed for ${id}, using the snapshot profile`, e);
    return p;
  }
}
