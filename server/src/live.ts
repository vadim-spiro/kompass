// Live: replays the 01.10.2026 event stream on a clock. An event reaches Kompass when it was
// ingested, not when it happened: duplicates are dropped, late and out-of-order arrivals are flagged,
// and every signal makes Kompass decide again for that customer. The engine enforces consent and
// exclusions at once (queued messages are cancelled), then the flows marketing configured run, and
// calls, tickets and service cases land on the service desk. Every decision is logged with the event,
// the rules that fired, the top action before and after, and what changed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentFeedback, DeskItem, FeedbackAction, LiveAction, LiveCounts, LiveCustomer, LiveDecision, LiveEvent, LiveFacts, LiveFlag, LiveFreshness, LiveState } from "../../shared/types.ts";
import { runFlowsForEvent, runMorningFlows, type StreamEvent } from "./automations.ts";
import { rawRecipient } from "./blocks.ts";
import { CATALOG, CONSENT_CHANNELS, emptyFacts, factsFor, factsOf, newLiveStore, rank, SNAPSHOT_END, type Ranked } from "./engine.ts";
import { identityFor } from "./identity.ts";
import { log, timed } from "./log.ts";
import { mapLimit } from "./upstream.ts";
import { newId, save, ws, type LiveStore } from "./workspace.ts";

const EVENTS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "event_stream_2026-10-01.jsonl");
const DAY = "2026-10-01";
const START = `${DAY} 00:00:00`;

interface RawEvent {
  event_id: string;
  event_type: string;
  source_system?: string;
  customer_id?: string;
  occurred_at: string;
  ingested_at?: string;
  payload?: Record<string, unknown>;
}

// sources.csv (mock data): how each system delivers, which is why events arrive late.
const SOURCES: Record<string, { label: string; refresh: string }> = {
  portal: { label: "Portal & app", refresh: "streaming, < 10 s" },
  autostrom_backend: { label: "Autostrom backend", refresh: "events, minutes" },
  roaming_hub: { label: "Roaming hub (CDRs)", refresh: "batch, 1–72 h late" },
  hems_cloud: { label: "HEMS cloud", refresh: "hourly sync, daily summary" },
  newsletter_tool: { label: "Newsletter tool", refresh: "hourly export, 1–2 h" },
  ticketing: { label: "Ticket system", refresh: "webhooks, < 1 min" },
  shop: { label: "Shopware", refresh: "webhooks, < 1 min" },
  telephony: { label: "Telephony + speech-to-text", refresh: "10–15 min after the call" },
  consent_mgmt: { label: "Consent platform", refresh: "events, < 1 min (must be)" },
  billing_erp: { label: "Billing ERP", refresh: "nightly batch 02:00, 2–26 h" },
  telco_backend: { label: "Telco backend", refresh: "usage alerts as events" },
  crm: { label: "CRM (agent assist)", refresh: "events, < 1 min" },
};

/** Events that make Kompass decide again. The rest (logins, page views, opens) only update what it knows. */
const SIGNALS = new Set([
  "gas_meter_deregistration_received",
  "cart_abandoned",
  "order_placed",
  "newsletter_clicked",
  "charge_session_failed",
  "contract_cancellation_received",
  "consent_changed",
  "dunning_level_changed",
  "ticket_created",
  "ticket_updated",
  "call_transcript_ready",
  "agent_nba_feedback",
  "mobile_data_threshold",
  "hems_device_offline",
]);

const TICKET_TOPIC: Record<string, string> = {
  billing: "Bill or installment",
  tariff: "Tariff question",
  moving: "Moving house",
  complaint: "Complaint",
  meter_deregistration: "Meter deregistration",
  autostrom: "Autostrom charging",
};

const UPSET = /schon wieder|wieder|ärger|unzufrieden|unverschämt|reicht|beschwer|bricht .*ab|zum dritten|enttäuscht/i;
const RETENTION = /preisgarantie|vergleich|günstiger|anderer anbieter|kündig/i;

const ms = (s: string) => new Date(`${s.replace(" ", "T")}Z`).getTime();
const hhmm = (s: string) => s.slice(11, 16);
const hoursBetween = (a: string, b: string) => Math.round((ms(b) - ms(a)) / 3600000);
const dayHm = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}. ${hhmm(s)}`;
const str = (v: unknown) => (v == null ? "" : String(v));
const nameOf = (id: string) => identityFor(id).name;

function labelFor(type: string, p: Record<string, unknown>): string {
  switch (type) {
    case "portal_login":
      return `Logged into the ${p.client === "app" ? "app" : "portal"}`;
    case "page_viewed":
      return `Viewed the portal page “${str(p.page).replace(/_/g, " ")}”`;
    case "charge_session_started":
      return `Started charging (${str(p.charge_type)}${p.location_city ? `, ${p.location_city}` : ""})`;
    case "charge_session_completed":
      return `Charged ${str(p.energy_kwh)} kWh for ${str(p.amount_eur)} €${p.blocking_minutes ? `, then blocked the charger for ${p.blocking_minutes} min` : ""}`;
    case "charge_session_failed":
      return `Charging failed (${str(p.charge_type)}${p.failure_reason ? `, ${str(p.failure_reason).replace(/_/g, " ")}` : ""})`;
    case "newsletter_opened":
      return `Opened newsletter ${str(p.campaign_id)} (may be a machine open)`;
    case "newsletter_clicked":
      return `Clicked “${str(p.click_target).replace(/_/g, " ")}” in newsletter ${str(p.campaign_id)}`;
    case "ticket_created":
      return `New ticket via ${str(p.channel).replace("_form", " form")}: ${TICKET_TOPIC[str(p.category)] ?? str(p.category)}`;
    case "ticket_updated":
      return `Ticket updated: ${str(p.note) || str(p.status)}`;
    case "call_transcript_ready":
      return "Call transcript arrived";
    case "consent_changed":
      return `${p.new_status === "withdrawn" ? "Withdrew" : "Changed"} consent: ${str(p.consent_type).replace(/_/g, " ")}`;
    case "contract_cancellation_received":
      return `Cancelled the ${str(p.commodity)} contract`;
    case "gas_meter_deregistration_received":
      return `Gas meter deregistered, effective ${str(p.effective_date).split("-").reverse().join(".")}`;
    case "dunning_level_changed":
      return `Dunning level ${str(p.old_level)} → ${str(p.new_level)}`;
    case "cart_abandoned":
      return `Left “${str(p.product_name)}” in the shop cart`;
    case "order_placed":
      return `Ordered “${str(p.product_name)}”`;
    case "mobile_data_threshold":
      return `Used ${str(p.threshold_pct)} % of the mobile data${p.days_left_in_cycle ? `, ${p.days_left_in_cycle} days left` : ""}`;
    case "hems_daily_summary":
      return `HEMS day: ${str(p.pv_generation_kwh)} kWh solar, ${Math.round(Number(p.self_consumption_rate ?? 0) * 100)} % used at home`;
    case "hems_device_offline":
      return "HEMS gateway went offline";
    case "meter_reading_submitted":
      return "Submitted a meter reading";
    case "agent_nba_feedback":
      return `Agent ${str(p.agent_action)} the suggested offer${p.dismiss_reason ? ` (${str(p.dismiss_reason).replace(/_/g, " ")})` : ""}`;
    default:
      return type.replace(/_/g, " ");
  }
}

let cached: LiveEvent[] | null = null;

/** The stream in the order Kompass receives it, with its traps flagged. */
export function allEvents(): LiveEvent[] {
  if (cached) return cached;
  const raw = readFileSync(EVENTS_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawEvent);
  const order = raw.map((r, i) => ({ r, i, ing: r.ingested_at ?? r.occurred_at })).sort((a, b) => a.ing.localeCompare(b.ing) || a.r.occurred_at.localeCompare(b.r.occurred_at) || a.i - b.i);
  const seen = new Map<string, number>();
  const offline = new Set<string>();
  let latest = "";
  cached = order.map(({ r, ing }) => {
    const flags: LiveFlag[] = [];
    const n = (seen.get(r.event_id) ?? 0) + 1;
    seen.set(r.event_id, n);
    if (n > 1) flags.push("duplicate");
    const lagMin = Math.max(0, Math.round((ms(ing) - ms(r.occurred_at)) / 60000));
    if (lagMin > 60) flags.push("late");
    else if (latest && ms(r.occurred_at) < ms(latest) - 60_000) flags.push("out_of_order");
    if (r.occurred_at > latest) latest = r.occurred_at;
    const id = str(r.customer_id);
    if (r.event_type === "hems_device_offline") offline.add(id);
    if (r.event_type === "hems_daily_summary" && offline.has(id)) flags.push("device_offline");
    const payload = r.payload ?? {};
    return {
      id: n > 1 ? `${r.event_id}#${n}` : r.event_id,
      type: r.event_type,
      label: labelFor(r.event_type, payload),
      source: r.source_system ?? "unknown",
      customerId: id,
      occurredAt: r.occurred_at,
      ingestedAt: ing,
      lagMin,
      signal: SIGNALS.has(r.event_type) || (r.event_type === "charge_session_completed" && Number(payload.blocking_minutes) > 60),
      flags,
      payload,
    };
  });
  const dupes = cached.filter((e) => e.flags.includes("duplicate")).length;
  log.info("live", `loaded ${cached.length} events (${dupes} duplicates, ${cached.filter((e) => e.flags.includes("late")).length} late)`);
  return cached;
}

const END = () => {
  const last = allEvents().at(-1)?.ingestedAt ?? `${DAY} 23:59:59`;
  return `${last.slice(0, 13)}:59:59`;
};

function store(): LiveStore {
  if (!ws.live) {
    ws.live = newLiveStore();
    save();
  }
  return ws.live;
}

// ---------- Facts ----------

const customerLines = (t: string) =>
  t
    .split("\n")
    .filter((l) => l.startsWith("Kunde:"))
    .map((l) => l.slice(6).trim());

function updateFacts(f: LiveFacts, e: LiveEvent) {
  const p = e.payload;
  f.events++;
  switch (e.type) {
    case "consent_changed": {
      const c = str(p.consent_type);
      if (p.new_status === "withdrawn") f.withdrawn = [...new Set([...f.withdrawn, c])];
      else f.withdrawn = f.withdrawn.filter((x) => x !== c);
      break;
    }
    case "dunning_level_changed":
      f.dunningLevel = Number(p.new_level);
      break;
    case "ticket_created": {
      const text = `${str(p.note)} ${str(p.message_text)}`;
      if (p.category === "complaint") f.complaint = str(p.ticket_id) || "new complaint";
      if (RETENTION.test(text)) f.retention = `said on ${str(p.channel)}: “${str(p.note || p.message_text).slice(0, 140)}”`;
      // The portal form often says it before the billing batch does.
      if (p.category === "meter_deregistration" && /gas/i.test(text)) {
        const m = text.match(/(\d{1,2})\.(\d{1,2})\./);
        if (!f.heatPump) {
          f.heatPump = m ? `${DAY.slice(0, 4)}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "soon";
          f.heatPumpSource = `${str(p.channel).replace("_form", " form")} ticket at ${hhmm(e.ingestedAt)}`;
          f.heatPumpAt = e.ingestedAt;
        }
      }
      break;
    }
    case "ticket_updated":
      if (p.status === "open") f.complaint ??= str(p.ticket_id);
      if (/rückruf/i.test(str(p.note))) f.callback = true;
      break;
    case "call_transcript_ready": {
      const said = customerLines(str(p.transcript)).join(" ");
      if (RETENTION.test(said)) f.retention = `said on the phone: “${customerLines(str(p.transcript))[0]?.slice(0, 140) ?? ""}”`;
      break;
    }
    case "contract_cancellation_received":
      f.cancellation = str(p.commodity) || "contract";
      break;
    case "charge_session_failed":
      f.failedToday++;
      break;
    case "charge_session_completed":
      if (Number(p.blocking_minutes) > 60) f.blockingMinutes = Number(p.blocking_minutes);
      break;
    case "cart_abandoned":
      f.cart = str(p.product_name);
      break;
    case "order_placed":
      f.ordered = [...(f.ordered ?? []), str(p.product_name)];
      if (f.cart === p.product_name) f.cart = undefined;
      break;
    case "newsletter_clicked":
      f.clicked = str(p.click_target);
      break;
    case "mobile_data_threshold":
      f.dataThresholdPct = Math.max(f.dataThresholdPct ?? 0, Number(p.threshold_pct));
      break;
    case "gas_meter_deregistration_received":
      f.heatPumpSource ??= `billing batch at ${dayHm(e.ingestedAt)}`;
      f.heatPumpAt ??= e.ingestedAt;
      f.heatPump = str(p.effective_date) || f.heatPump || "soon";
      break;
    case "hems_device_offline":
      f.hemsOffline = true;
      break;
    case "agent_nba_feedback": {
      const offerId = str(p.suggested_offer_id);
      const action: FeedbackAction = p.dismiss_reason === "customer_upset" ? "upset" : p.agent_action === "dismissed" ? "not_relevant" : "mentioned";
      applyFeedback(f, offerId, action, e.ingestedAt);
      store().feedback.unshift({ id: newId("FB"), at: e.ingestedAt, customerId: e.customerId, offerId, product: CATALOG.get(offerId)?.name ?? offerId, action, source: "stream" });
      break;
    }
    default:
      f.lastActiveAt = e.occurredAt;
  }
}

const plusDays = (at: string, days: number) => {
  const d = new Date(ms(at) + days * 86400000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 19)}`;
};

function applyFeedback(f: LiveFacts, offerId: string, action: FeedbackAction, at: string) {
  if (action === "upset") f.upsetUntil = plusDays(at, 30);
  if (action === "not_relevant" && offerId) f.dismissed = [...new Set([...f.dismissed, offerId])];
  if (action === "has_it" && offerId) f.hasIt = [...new Set([...f.hasIt, offerId])];
}

// ---------- Decisions ----------

/** Consent and exclusions stop queued messages at once, whatever the flows say. */
function enforce(id: string, f: LiveFacts, before: Ranked, after: Ranked, at: string): string[] {
  const st = store();
  const closed = new Set(f.withdrawn.flatMap((c) => CONSENT_CHANNELS[c] ?? []));
  const noProfiling = f.withdrawn.includes("profiling_analytics");
  const newBlock = after.salesBlockers.filter((b) => !before.salesBlockers.includes(b));
  const out: string[] = [];
  for (const p of ws.proposals) {
    if (p.customerId !== id || p.status !== "pending" || p.kind === "task" || p.kind === "notify") continue;
    const sales = !!p.offerId && p.offerId !== "P-SV-01";
    let why = "";
    if (closed.has(p.channel)) why = `consent for ${p.channel.replace("_", " ")} withdrawn at ${dayHm(at)}`;
    // Every queued 1:1 message is built from the profile, so it is personalised.
    else if (noProfiling) why = `profiling consent withdrawn at ${dayHm(at)}: no personalised messages`;
    else if (newBlock.length && sales) why = `exclusion at ${dayHm(at)}: ${newBlock.join(", ")}`;
    if (!why) continue;
    p.status = "cancelled";
    p.cancelReason = why[0].toUpperCase() + why.slice(1);
    out.push(p.id);
  }
  if (out.length) {
    st.cancelled.push(...out);
    log.info("live", `cancelled ${out.length} queued message(s) for ${id}`, { ids: out });
  }
  return out;
}

const SERVICE_TYPES = new Set(["ticket_created", "ticket_updated", "call_transcript_ready", "contract_cancellation_received", "charge_session_failed", "hems_device_offline", "charge_session_completed"]);

function deskFor(e: LiveEvent, f: LiveFacts, name: string): DeskItem | undefined {
  if (!SERVICE_TYPES.has(e.type)) return undefined;
  const st = store();
  const p = e.payload;
  const ticketId = str(p.ticket_id) || undefined;
  // A transcript or update belongs to the ticket already on the desk: same ticket id, or the same
  // customer's open item from within half an hour (tickets created by phone carry no id yet).
  const near = (d: DeskItem) => d.customerId === e.customerId && d.status === "waiting" && Math.abs(ms(d.at) - ms(e.occurredAt)) <= 30 * 60000;
  const existing =
    (ticketId && st.desk.find((d) => d.ticketId === ticketId)) ||
    (e.type === "call_transcript_ready" || e.type === "ticket_updated" ? st.desk.find((d) => near(d) && d.channel !== "proactive") : undefined) ||
    (e.type.startsWith("charge") ? st.desk.find((d) => d.customerId === e.customerId && d.status === "waiting" && d.channel === "proactive" && d.topic.startsWith("Charging")) : undefined);
  let item: DeskItem | undefined;
  switch (e.type) {
    case "call_transcript_ready": {
      const lines = customerLines(str(p.transcript));
      const upset = UPSET.test(lines.join(" "));
      item = { id: "", customerId: e.customerId, customerName: name, channel: "phone", topic: lines[0]?.slice(0, 120) ?? "Phone call", at: e.occurredAt, eventId: e.id, ticketId, transcript: str(p.transcript), mood: upset ? "upset" : "neutral", priority: upset || f.retention ? "high" : "normal", status: "waiting" };
      break;
    }
    case "ticket_created": {
      const ch = str(p.channel);
      const text = str(p.message_text || p.note);
      item = {
        id: "",
        customerId: e.customerId,
        customerName: name,
        channel: ch === "phone" ? "phone" : ch === "chat" ? "chat" : ch === "email" ? "email" : "portal",
        topic: TICKET_TOPIC[str(p.category)] ?? str(p.category),
        detail: text || undefined,
        at: e.occurredAt,
        eventId: e.id,
        ticketId,
        mood: p.category === "complaint" || UPSET.test(text) ? "upset" : "neutral",
        priority: p.category === "complaint" || f.retention ? "high" : "normal",
        status: "waiting",
      };
      break;
    }
    case "ticket_updated":
      item = { id: "", customerId: e.customerId, customerName: name, channel: "phone", topic: /rückruf/i.test(str(p.note)) ? "Callback requested" : "Ticket updated", detail: str(p.note), at: e.occurredAt, eventId: e.id, ticketId, mood: "upset", priority: "high", status: "waiting" };
      break;
    case "contract_cancellation_received":
      item = { id: "", customerId: e.customerId, customerName: name, channel: "proactive", topic: `Cancellation received (${str(p.commodity)})`, detail: "Call to understand why before anything else. No sales mail.", at: e.occurredAt, eventId: e.id, mood: "neutral", priority: "high", status: "waiting" };
      break;
    case "charge_session_failed":
      if (!p.failure_reason && f.failedToday < 2) return undefined;
      item = { id: "", customerId: e.customerId, customerName: name, channel: "proactive", topic: "Charging failed again", detail: `${str(p.charge_type)}${p.failure_reason ? `, ${str(p.failure_reason).replace(/_/g, " ")}` : ""}${p.location_id ? ` at ${str(p.location_id)}` : ""}`, at: e.occurredAt, eventId: e.id, mood: "upset", priority: "normal", status: "waiting" };
      break;
    case "charge_session_completed":
      item = { id: "", customerId: e.customerId, customerName: name, channel: "proactive", topic: "Blocking fee coming", detail: `${str(p.blocking_minutes)} min at the charger; the roaming record arrived ${Math.round(e.lagMin / 60)} h late. Explain before the invoice does.`, at: e.occurredAt, eventId: e.id, mood: "neutral", priority: "normal", status: "waiting" };
      break;
    case "hems_device_offline":
      item = { id: "", customerId: e.customerId, customerName: name, channel: "proactive", topic: "HEMS gateway offline", detail: "Help reconnect; until then its solar data is missing, not zero.", at: e.occurredAt, eventId: e.id, mood: "neutral", priority: "normal", status: "waiting" };
      break;
  }
  if (!item) return undefined;
  if (existing) {
    // A transcript or update for a ticket already on the desk enriches it instead of adding a row.
    Object.assign(existing, { ...item, id: existing.id, ticketId: existing.ticketId ?? item.ticketId, channel: existing.channel === "proactive" ? item.channel : existing.channel, topic: e.type === "call_transcript_ready" ? existing.topic : item.topic, detail: item.detail ?? existing.detail, transcript: item.transcript ?? existing.transcript, mood: item.mood === "upset" ? "upset" : existing.mood, priority: item.priority === "high" ? "high" : existing.priority, at: existing.at, status: "waiting" });
    return existing;
  }
  item.id = newId("DSK");
  st.desk.unshift(item);
  return item;
}

const top = (r: Ranked): LiveAction | null => r.actions[0] ?? null;
const eur = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(0)} €`;

function headline(e: LiveEvent, b: Ranked, a: Ranked, cancelled: string[], created: string[], desk?: DeskItem): string {
  const parts: string[] = [];
  if (desk) parts.push(`service desk: ${desk.topic.length > 60 ? `${desk.topic.slice(0, 57)}…` : desk.topic}`);
  const closed = a.allowedChannels.length < b.allowedChannels.length;
  if (closed) parts.push(`${b.allowedChannels.filter((c) => !a.allowedChannels.includes(c)).map((c) => c.replace("_", " ")).join(", ")} closed`);
  if (a.profiling !== b.profiling) parts.push("nothing personalised any more");
  const newBlock = a.salesBlockers.filter((x) => !b.salesBlockers.includes(x));
  if (newBlock.length) parts.push(`sales blocked: ${newBlock.join(", ")}`);
  if (cancelled.length) parts.push(`${cancelled.length} queued message${cancelled.length > 1 ? "s" : ""} cancelled`);
  const tb = top(b);
  const ta = top(a);
  if (ta && ta.offerId !== tb?.offerId) parts.push(ta.type === "service" ? "service comes first now" : `${ta.product} now ranks first (${eur(ta.dclvEur)})`);
  else if (!ta && tb) parts.push("nothing worth offering now");
  if (created.length) parts.push(`${created.length} draft${created.length > 1 ? "s" : ""} for approval`);
  // With nothing left to offer, name what held the offers back so every decision carries its reason.
  const held = a.blocked[0]?.reason.split(":")[0];
  if (!parts.length || (desk && parts.length === 1)) parts.push(ta ? (ta.type === "service" ? "service still comes first" : `${ta.product} stays first`) : held ? `nothing to offer: ${held}` : "nothing to offer");
  return parts.join(" · ");
}

async function decide(e: LiveEvent, before: LiveFacts, f: LiveFacts) {
  const st = store();
  const r = await rawRecipient(e.customerId);
  const rb = rank(r.profile, before, e.ingestedAt);
  const ra = rank(r.profile, f, e.ingestedAt);
  const pendingBefore = ws.proposals.filter((p) => p.customerId === e.customerId && p.status === "pending").map((p) => p.id);
  const enforced = enforce(e.customerId, f, rb, ra, e.ingestedAt);
  const stream: StreamEvent = { id: e.id, type: e.type, at: e.occurredAt, customerId: e.customerId, payload: e.payload, duplicate: false, late: e.flags.includes("late") };
  const flows = await runFlowsForEvent(stream);
  st.created.push(...flows.created);
  // Flows may stop queued messages too (e.g. "consent withdrawn → stop the queue"): log them with the decision.
  const byFlows = pendingBefore.filter((id) => !enforced.includes(id) && ws.proposals.find((p) => p.id === id)?.status === "cancelled");
  if (byFlows.length) st.cancelled.push(...byFlows);
  const cancelled = [...enforced, ...byFlows];
  const desk = deskFor(e, f, r.identity.name);
  const rules = [...ra.rules];
  if (e.flags.includes("late")) rules.unshift({ rule: "Data freshness", effect: `arrived ${e.lagMin >= 120 ? `${Math.round(e.lagMin / 60)} h` : `${e.lagMin} min`} late from ${SOURCES[e.source]?.label ?? e.source}: decided again with the fact in its place` });
  // The billing batch arrives a night later; the portal form usually said it first.
  const known = e.type === "gas_meter_deregistration_received" && before.heatPumpAt ? before : null;
  if (known) rules.unshift({ rule: "Already known", effect: `the billing batch confirms what the ${known.heatPumpSource} said, ${hoursBetween(e.occurredAt, e.ingestedAt)} h after it happened: Kompass did not wait for it` });
  for (const h of flows.hits) rules.push({ rule: `Flow: ${h.automationName}`, effect: h.outcome });
  const d: LiveDecision = {
    id: newId("DEC"),
    eventId: e.id,
    eventType: e.type,
    eventLabel: e.label,
    at: e.ingestedAt,
    occurredAt: e.occurredAt,
    customerId: e.customerId,
    customerName: r.identity.name,
    headline: known ? `confirms the ${known.heatPumpSource}: ${top(ra)?.product ?? "the offer"} was ready ${hoursBetween(known.heatPumpAt!, e.ingestedAt)} h earlier` : headline(e, rb, ra, cancelled, flows.created, desk),
    rules,
    before: top(rb),
    after: top(ra),
    blocked: ra.blocked.slice(0, 6).map((b) => ({ product: b.product, reason: b.reason })),
    created: flows.created,
    cancelled,
    deskItemId: desk?.id,
  };
  st.decisions.unshift(d);
  if (st.decisions.length > 500) st.decisions.length = 500;
  log.info("live", `${e.customerId} ${e.type}: ${d.headline}`, { eventId: e.id, before: d.before?.offerId, after: d.after?.offerId, cancelled, created: flows.created });
}

async function apply(e: LiveEvent) {
  if (e.flags.includes("duplicate")) {
    log.debug("live", `duplicate ${e.id} dropped`);
    return;
  }
  if (!e.customerId) return;
  const f = factsOf(e.customerId);
  const before: LiveFacts = structuredClone(f);
  updateFacts(f, e);
  if (!e.signal) return;
  try {
    await decide(e, before, f);
  } catch (err) {
    log.error("live", `decision failed for ${e.type} of ${e.customerId}`, err);
  }
}

let morningPromise: Promise<void> | null = null;

async function morning() {
  const st = store();
  try {
    const res = await timed("live", "morning run", () => runMorningFlows(DAY), 30_000);
    st.created.push(...res.created);
    st.decisions.push({
      id: newId("DEC"),
      eventId: "schedule",
      eventType: "schedule",
      eventLabel: "Every morning: scheduled flows",
      at: START,
      occurredAt: START,
      customerId: "",
      customerName: "",
      headline: `Morning run: ${res.hits.length} customers checked · ${res.created.length} draft${res.created.length === 1 ? "" : "s"} for approval`,
      rules: [{ rule: "Trigger", effect: "a scheduled run selects customers (price guarantee ending, segments)" }],
      before: null,
      after: null,
      blocked: [],
      created: res.created,
      cancelled: [],
    });
    save();
  } catch (e) {
    log.error("live", "morning run failed", e);
  }
}

let busy: Promise<unknown> = Promise.resolve();

/** Moves the clock forward and processes every event that arrived until then. One call at a time. */
export function advance(to: string) {
  const run = busy.then(async () => {
    const st = store();
    const target = to > END() ? END() : to;
    const from = st.clock;
    if (target <= from) return delta(from, []);
    // Scheduled flows run at 00:00, before the first event of the day is applied.
    if (!st.morningRun) {
      st.morningRun = true;
      morningPromise = morning();
      await morningPromise;
    }
    const due = allEvents().filter((e) => e.ingestedAt > from && e.ingestedAt <= target);
    const decisionsBefore = st.decisions.length;
    for (const e of due) {
      st.clock = e.ingestedAt;
      await apply(e);
    }
    st.clock = target;
    save();
    log.debug("live", `clock ${from} → ${target}: ${due.length} events, ${st.decisions.length - decisionsBefore} decisions`);
    return delta(from, due);
  });
  busy = run.catch(() => undefined);
  return run;
}

function delta(from: string, due: LiveEvent[]) {
  const st = store();
  return {
    clock: st.clock,
    events: due,
    decisions: st.decisions.filter((d) => d.at > from && d.at <= st.clock),
    desk: st.desk,
    counts: counts(),
    morningRun: st.morningRun,
    next: liveState().next,
  };
}

function applied() {
  const clock = store().clock;
  return allEvents().filter((e) => e.ingestedAt <= clock);
}

function counts(): LiveCounts {
  const st = store();
  const a = applied();
  const live = a.filter((e) => !e.flags.includes("duplicate"));
  return {
    applied: a.length,
    total: allEvents().length,
    duplicates: a.length - live.length,
    late: live.filter((e) => e.flags.includes("late")).length,
    outOfOrder: live.filter((e) => e.flags.includes("out_of_order")).length,
    signals: live.filter((e) => e.signal).length,
    decisions: st.decisions.length,
    created: st.created.length,
    cancelled: st.cancelled.length,
  };
}

function freshness(): LiveFreshness[] {
  const by = new Map<string, LiveEvent[]>();
  for (const e of applied()) if (!e.flags.includes("duplicate")) by.set(e.source, [...(by.get(e.source) ?? []), e]);
  return [...by.entries()]
    .map(([source, evs]) => {
      const lags = evs.map((e) => e.lagMin).sort((x, y) => x - y);
      return { source, label: SOURCES[source]?.label ?? source, refresh: SOURCES[source]?.refresh ?? "", events: evs.length, medianLagMin: lags[Math.floor(lags.length / 2)] ?? 0, maxLagMin: lags.at(-1) ?? 0, late: evs.filter((e) => e.flags.includes("late")).length };
    })
    .sort((x, y) => y.maxLagMin - x.maxLagMin);
}

export function liveState(): LiveState {
  const st = store();
  const n = allEvents().find((e) => e.ingestedAt > st.clock && e.signal && !e.flags.includes("duplicate"));
  return {
    day: DAY,
    start: START,
    end: END(),
    clock: st.clock,
    morningRun: st.morningRun,
    counts: counts(),
    freshness: freshness(),
    events: applied(),
    decisions: st.decisions,
    desk: st.desk,
    feedback: st.feedback,
    next: n ? { at: n.ingestedAt, label: n.label, customerId: n.customerId } : null,
  };
}

/** Back to before the day: undo what the replay created and cancelled. */
export async function resetLive() {
  await busy;
  await morningPromise;
  const st = store();
  const created = new Set(st.created);
  const before = ws.proposals.length;
  // Drafts the replay made go (unless a person already decided them); what it stopped comes back.
  ws.proposals = ws.proposals.filter((p) => !(created.has(p.id) && (p.status === "pending" || p.status === "cancelled")));
  let restored = 0;
  for (const p of ws.proposals)
    if (st.cancelled.includes(p.id) && p.status === "cancelled") {
      p.status = "pending";
      p.cancelReason = undefined;
      restored++;
    }
  ws.live = newLiveStore();
  save();
  log.info("live", `reset: removed ${before - ws.proposals.length} proposals, restored ${restored}`);
  void warm();
  return liveState();
}

/** Loads the customers the day's signals concern, so the replay doesn't wait for the insights service. */
let warming: Promise<void> | null = null;
export function warm() {
  warming ??= (async () => {
    const ids = [...new Set(allEvents().filter((e) => e.signal && e.customerId).map((e) => e.customerId))];
    const t = Date.now();
    await mapLimit(ids, 6, (id) => rawRecipient(id).catch((err) => log.warn("live", `warm-up failed for ${id}`, err)));
    log.info("live", `warmed ${ids.length} customers in ${Date.now() - t} ms`);
  })().finally(() => {
    warming = null;
  });
  return warming;
}

// ---------- Service desk and feedback ----------

export function giveFeedback(b: { customerId: string; offerId: string; product: string; action: FeedbackAction; deskItemId?: string }): AgentFeedback {
  const st = store();
  const f = factsOf(b.customerId);
  const at = st.clock > SNAPSHOT_END ? st.clock : SNAPSHOT_END;
  const fb: AgentFeedback = { id: newId("FB"), at, customerId: b.customerId, offerId: b.offerId, product: b.product, action: b.action, deskItemId: b.deskItemId, source: "agent" };
  st.feedback.unshift(fb);
  applyFeedback(f, b.offerId, b.action, at);
  if (b.action === "upset") {
    // An upset customer gets no sales content: cancel what is queued.
    for (const p of ws.proposals)
      if (p.customerId === b.customerId && p.status === "pending" && p.offerId && p.offerId !== "P-SV-01") {
        p.status = "cancelled";
        p.cancelReason = "Agent reported the customer as upset: no sales for 30 days";
        st.cancelled.push(p.id);
      }
  }
  save();
  log.info("live", `feedback ${b.action} on ${b.offerId} for ${b.customerId}`, fb);
  return fb;
}

export async function updateDesk(id: string, patch: { status?: DeskItem["status"]; outcome?: string }) {
  const item = store().desk.find((d) => d.id === id);
  if (!item) return null;
  const wasWaiting = item.status === "waiting";
  if (patch.status) item.status = patch.status;
  if (patch.outcome != null) item.outcome = patch.outcome;
  log.info("live", `desk ${id} → ${item.status}${item.outcome ? ` (${item.outcome})` : ""}`);
  if (wasWaiting && item.status === "done" && /^solved$/i.test(item.outcome ?? "")) await solveCase(item);
  save();
  return item;
}

/** "Solved" on the desk clears what the stream flagged for that case, and Kompass decides again for the customer. */
async function solveCase(item: DeskItem) {
  const st = store();
  const f = factsOf(item.customerId);
  const before: LiveFacts = structuredClone(f);
  const topic = item.topic.toLowerCase();
  const done: string[] = [];
  if (f.complaint && /complaint/.test(topic)) {
    f.complaint = undefined;
    done.push("complaint solved");
  }
  if (f.callback && /callback/.test(topic)) {
    f.callback = false;
    done.push("customer called back");
  }
  if (f.blockingMinutes && /blocking/.test(topic)) {
    f.blockingMinutes = undefined;
    done.push("blocking fee explained");
  }
  if (f.hemsOffline && /hems/.test(topic)) {
    f.hemsOffline = false;
    done.push("HEMS gateway reconnected");
  }
  if (f.failedToday && /charging/.test(topic)) {
    f.failedToday = 0;
    done.push("charging problem fixed");
  }
  if (!done.length) return;
  const at = st.clock > SNAPSHOT_END ? st.clock : SNAPSHOT_END;
  const r = await rawRecipient(item.customerId);
  const rb = rank(r.profile, before, at);
  const ra = rank(r.profile, f, at);
  const parts = [...done];
  if (rb.salesBlockers.length && !ra.salesBlockers.length) parts.push("sales allowed again");
  const tb = top(rb);
  const ta = top(ra);
  if (ta && ta.offerId !== tb?.offerId) parts.push(ta.type === "service" ? "service comes first now" : `${ta.product} now ranks first (${eur(ta.dclvEur)})`);
  const d: LiveDecision = {
    id: newId("DEC"),
    eventId: item.eventId,
    eventType: "agent_solved",
    eventLabel: `Agent logged “${item.topic}” as solved`,
    at,
    occurredAt: at,
    customerId: item.customerId,
    customerName: item.customerName,
    headline: parts.join(" · "),
    rules: [{ rule: "Agent feedback", effect: `${done.join(", ")} on the service desk: the stream's flag is cleared` }, ...ra.rules],
    before: tb,
    after: ta,
    blocked: ra.blocked.slice(0, 6).map((b) => ({ product: b.product, reason: b.reason })),
    created: [],
    cancelled: [],
    deskItemId: item.id,
  };
  st.decisions.unshift(d);
  log.info("live", `${item.customerId} solved on the desk: ${d.headline}`, { deskItemId: item.id, before: tb?.offerId, after: ta?.offerId });
}

export async function liveCustomer(id: string): Promise<LiveCustomer> {
  const st = store();
  const r = await rawRecipient(id);
  const f = factsFor(id);
  const ranked = rank(r.profile, f);
  return {
    customerId: id,
    facts: f ?? null,
    actions: ranked.actions,
    blocked: ranked.blocked.map((b) => ({ product: b.product, reason: b.reason })),
    rules: ranked.rules,
    salesBlockers: ranked.salesBlockers,
    allowedChannels: ranked.allowedChannels,
    decisions: st.decisions.filter((d) => d.customerId === id),
    events: applied().filter((e) => e.customerId === id),
    desk: st.desk.filter((d) => d.customerId === id),
    feedback: st.feedback.filter((x) => x.customerId === id),
  };
}

export { emptyFacts, nameOf };
