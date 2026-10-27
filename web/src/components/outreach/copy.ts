// Words, numbers and dates the three steps of the guided outreach share: one name per channel, one
// SMS limit, one preview size, one date style, plurals that agree with the count, and plain wording
// for what the engine and the server report in keys. Pure functions, no React.
import type { Campaign, GuardrailCheck, PlanSummary, Settings } from "../../../../shared/types";
import { fmtInt, humanize, statusLabel } from "../../lib/format";

// ---------- Counts ----------

/** "1 customer", "2 customers", "1.200 customers". */
export const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;
/** The verb that agrees with a count: "gets" for 1, "get" otherwise. */
export const agree = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ---------- Channels ----------

/** One name per channel, everywhere. Calls and service contacts are both the call script's channel. */
const CHANNEL_NAME: Record<string, string> = { email: "Email", newsletter: "Newsletter", portal_popup: "Portal pop-up", app_push: "App push", sms: "SMS", outbound_call: "Call", service_contact: "Call", call: "Call" };
export const channelName = (key?: string | null) => (key ? (CHANNEL_NAME[key] ?? humanize(key)) : "–");
/** The channel behind words the server wrote with spaces ("portal popup"). */
const channelFromWords = (words: string) => channelName(words.trim().toLowerCase().replace(/[\s-]+/g, "_"));

// ---------- Limits and sample sizes ----------

/** An SMS may take two messages; the guardrail on the server counts the same 320 characters. */
export const SMS_SEGMENT = 160;
export const SMS_MAX_SEGMENTS = 2;
export const SMS_LIMIT = SMS_SEGMENT * SMS_MAX_SEGMENTS;
/** Recipients the message preview flips through. The review on the server checks the same number. */
export const PREVIEW_SAMPLE = 40;
/** "Preview of 40 of 203 recipients", or "All 12 recipients" when nothing is cut off. */
export const sampleLabel = (shown: number, total?: number) => (total != null && total > shown ? `Preview of ${fmtInt(shown)} of ${fmtInt(total)} recipients` : `All ${plural(shown, "recipient")}`);

// ---------- Dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
/** One date style everywhere: 28.10.2026, and with a time 28.10.2026, 09:00. */
export function fmtWhen(s?: string | null, withTime = true) {
  if (!s) return "–";
  const d = new Date(s.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return s;
  const day = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  return withTime ? `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}
/** A date-time value ("2026-10-28T09:00") as the German text the inputs show. */
export function splitWhen(iso?: string | null) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso ?? "");
  return m ? { date: `${m[3]}.${m[2]}.${m[1]}`, time: `${m[4]}:${m[5]}` } : { date: "", time: "" };
}
/** 28.10.2026 and 9:00 back to "2026-10-28T09:00", or null while the text is not a real date and time. */
export function joinWhen(date: string, time: string) {
  const d = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!d || !t) return null;
  const [day, month, year, hour, minute] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  const check = new Date(year, month - 1, day, hour, minute);
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day || hour > 23 || minute > 59) return null;
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

// ---------- Names, status ----------

export const DEFAULT_NAME = "New campaign";
/** A name nobody asked for: the new-campaign default, with or without a "(2)" behind it. */
export const isDefaultName = (name: string) => /^(New campaign|Neue Kampagne)( \(\d+\))?$/.test(name.trim());
export const withoutCount = (name: string) => name.replace(/ \(\d+\)$/, "");
/** A name nobody else uses: "Price watchers", then "Price watchers (2)", "(3)". */
export function uniqueName(wanted: string, taken: string[]) {
  const want = wanted.trim() || DEFAULT_NAME;
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(want.toLowerCase())) return want;
  const base = withoutCount(want);
  for (let n = 2; ; n++) if (!used.has(`${base} (${n})`.toLowerCase())) return `${base} (${n})`;
}

/** Approvals a campaign needs before it can go out (Settings → second approver). Unknown settings count as two. */
export const approvalsNeeded = (settings?: Settings | null) => (settings?.terms.requireSecondApprover === false ? 1 : 2);
/** What the list and the editor call a campaign: an approved one in review is ready to send. */
export function campaignStatus(c: Pick<Campaign, "status" | "approvals">, need: number) {
  const ready = c.status === "review" && c.approvals.length >= need;
  return { ready, label: ready ? "Ready to send" : (statusLabel[c.status] ?? c.status), tint: ready ? ("sun" as const) : ({ draft: "neutral", review: "warn", running: "navy", done: "good" } as const)[c.status] };
}

// ---------- Left out, and why ----------

const REASON_TEXT: Record<string, string> = {
  "no profiling consent": "No profiling consent",
  "no consented channel": "No channel they consented to",
  "service case": "Open problem: service comes first, no sales",
  "no positive value": "No positive expected CLV gain",
  "offer disabled": "Offer switched off",
  "not eligible": "No offer fits",
};
/** A reason in words. The server already writes plain ones; this also reads the insights service's keys. */
export function plainReason(reason: string) {
  const one = (r: string) => {
    const k = r.trim().toLowerCase();
    const below = /^dclv below (-?[\d.]+) ?€$/.exec(k);
    if (below) return `Expected CLV gain below ${Number(below[1])} €`;
    if (k === "over max_contacts") return "Over this campaign's contact limit";
    const off = /^channel (.+) (not selected|switched off in settings)$/.exec(k);
    if (off) return `${channelFromWords(off[1])} ${off[2] === "not selected" ? "not selected for this campaign" : "switched off in Settings"}`;
    const complaint = /^complaint in the last (\d+) days$/.exec(k);
    if (complaint) return `Complaint in the last ${plural(Number(complaint[1]), "day")}`;
    const limit = /^contact limit \((\d+) per 30 days\)$/.exec(k);
    if (limit) return `Contact limit reached (${limit[1]} per 30 days)`;
    return REASON_TEXT[k] ?? (r.charAt(0).toUpperCase() + r.slice(1)).replace(/_/g, " ");
  };
  return reason.split(/;\s*/).filter(Boolean).map(one).join(" and ") || "No offer fits";
}
/** The reasons for the "left out" number, biggest first, adding up to exactly that number. */
export function skipList(s: PlanSummary, top = 7): [string, number][] {
  const merged = new Map<string, number>();
  for (const [k, n] of Object.entries(s.skipped_by_reason)) merged.set(plainReason(k), (merged.get(plainReason(k)) ?? 0) + n);
  const all = [...merged].sort((a, b) => b[1] - a[1]);
  // One reason more than fits is shown by name; "Other reasons" is for two or more.
  const shown = all.length <= top + 1 ? all : all.slice(0, top);
  const rest = s.skipped - shown.reduce((t, [, n]) => t + n, 0);
  return rest > 0 ? [...shown, ["Other reasons", rest]] : shown;
}

/** "P-EN-03 StromWärme" → "StromWärme": the plan summary keys offers by id and name. */
export const offerLabel = (key: string) => key.replace(/^P-[A-Z]{2}-\d+\s+/, "");

// ---------- Audience keys in plain words (mirrors server/src/outreach.ts) ----------

export const SEGMENT_LABEL: Record<string, string> = {
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
export const PAIN_LABEL: Record<string, string> = {
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
export const HOLDING_LABEL: Record<string, string> = {
  energy: "Energy contract",
  electricity: "Electricity",
  gas: "Gas",
  mobile: "Mobile",
  autostrom: "Autostrom",
  hems: "Energy manager (HEMS)",
  ev: "EV",
  heat_pump: "Heat pump",
  pv: "Solar (PV)",
  smart_meter: "Smart meter",
  wallbox: "Wallbox",
  app: "App",
};
export const TIER_LABEL: Record<string, string> = { high: "High", medium: "Medium", low: "Low", negative: "Negative", unknown: "Unknown" };
export const DRIVER_LABEL: Record<string, string> = {
  tickets_12m_ge2: "2 or more tickets in 12 months",
  price_guarantee_ends_90d: "guarantee ends within 90 days",
  low_csat: "unhappy with the last contact",
  open_complaint: "open complaint",
  dunning: "in dunning",
  cancellation_pending: "cancellation pending",
  failed_charges_30d: "failed charging sessions",
  multi_product: "several products",
  hems_user: "uses an energy manager",
};
export const SAVING_LABEL: Record<string, string> = {
  electricity_tariff: "Electricity tariff",
  heat_pump_tariff: "Heat-pump tariff",
  gas_tariff: "Gas tariff",
  mobile_downsize: "Smaller mobile plan",
  balcony_pv: "Balcony solar",
  dynamic_tariff: "Dynamic tariff",
  charging_refund: "Charging refund",
};
const label = (map: Record<string, string>) => (key: string) => map[key] ?? humanize(key);
export const segmentLabel = label(SEGMENT_LABEL);
export const painLabel = label(PAIN_LABEL);
export const holdingLabel = label(HOLDING_LABEL);
export const tierLabel = label(TIER_LABEL);
export const driverLabel = (key: string) => DRIVER_LABEL[key] ?? humanize(key).toLowerCase();

// ---------- Text the engine writes in keys ----------

export interface Plainer {
  /** Rule fields of the block catalog (field key and plain label). */
  fields?: { field: string; label: string }[];
  /** Offers of the vocabulary, to turn "P-EN-03" into its name. */
  offers?: { offer_id: string; product_name: string }[];
}
/** Offer ids, snake_case keys, "dCLV" and consent purposes in a server text, said plainly. */
export function plainText(text: string, ctx: Plainer = {}) {
  return text
    .replace(/\bP-[A-Z]{2}-\d+\b/g, (id) => ctx.offers?.find((o) => o.offer_id === id)?.product_name ?? "this offer")
    .replace(/\bprofiling_analytics( consent)?\b/g, "profiling consent")
    .replace(/\b(?:dCLV|ΔCLV)\b/g, "CLV")
    .replace(/\b(portal_popup|outbound_call|service_contact|app_push)\b/g, (k) => channelName(k))
    .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (k) => ctx.fields?.find((f) => f.field === k)?.label ?? k.replace(/_/g, " "));
}

const RULE_OPS: Record<string, string> = { is: "is", "is not": "is not", gt: "is more than", lt: "is less than", contains: "includes", "not contains": "does not include", exists: "is set", "not exists": "is not set" };
/** Why a block is hidden for one customer, e.g. "Rule not met: has_autostrom is true" → "Rule not met: Has Autostrom is yes". */
export function plainHidden(reason: string | undefined, ctx: Plainer = {}) {
  if (!reason) return "";
  const rule = /^Rule not met: (\S+) (is not|is|gt|lt|contains|not contains|exists|not exists)(?: (.*))?$/.exec(reason);
  if (rule) {
    const [, field, op, value] = rule;
    const name = ctx.fields?.find((f) => f.field === field)?.label ?? humanize(field);
    const shown = value === "true" ? "yes" : value === "false" ? "no" : value && field === "segments" ? segmentLabel(value) : value && field === "pains" ? painLabel(value) : value;
    return `Rule not met: ${name} ${RULE_OPS[op] ?? op}${shown ? ` ${shown}` : ""}`;
  }
  const notUsed = /^Not used in (.+)$/.exec(reason);
  if (notUsed && !/^a call script$/.test(notUsed[1])) return `Not used in ${channelFromWords(notUsed[1])}`;
  return plainText(reason, ctx);
}

/** The consent purpose is "Consent for portal popup" with "allowed: email, portal_popup" behind it. */
export const isConsentCheck = (check: string) => check.startsWith("Consent");
export function plainCheck(c: GuardrailCheck) {
  const consent = /^Consent for (.+)$/.exec(c.check);
  const detail = c.detail?.replace(/^allowed: (.*)$/, (_, list: string) => `allowed: ${list === "none" ? "none" : list.split(/,\s*/).map(channelName).join(", ")}`);
  return { check: consent ? `Consent for ${channelFromWords(consent[1])}` : c.check, detail: detail ? plainText(detail) : undefined };
}

/** Old stored notes of past results, in words ("p_accept", the dataset name). */
export const plainNote = (s: string) =>
  s
    .replace(/\s*\(newsletter_performance\)/, "")
    .replace(/Apple MPP machine opens excluded/, "Machine opens (Apple Mail Privacy Protection) are excluded")
    .replace(/\bp_accept\b/g, "acceptance rate");
