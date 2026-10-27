// Automations: n8n-style flows that react to customer events. The runner replays the event
// stream (deduplicated, late events applied in order of occurrence), walks each enabled flow
// for the event's customer, and turns "send"/"task" steps into proposals for human approval.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Automation, Flow, FlowEdge, FlowNode, NodeDef, Proposal, RunReport, Settings } from "../../shared/types.ts";
import { evalShowIf, loadRecipient, renderEmail, SHOW_IF_FIELDS, toPlain } from "./blocks.ts";
import { mapLimit, searchCustomers } from "./upstream.ts";
import { log } from "./log.ts";
import { newId, save, ws } from "./workspace.ts";

const EVENTS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "event_stream_2026-10-01.jsonl");

interface RawEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  ingested_at?: string;
  customer_id?: string;
  payload?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface StreamEvent {
  id: string;
  type: string;
  at: string;
  customerId: string;
  payload: Record<string, unknown>;
  duplicate: boolean;
  late: boolean;
}

export function loadEvents(): StreamEvent[] {
  const seen = new Set<string>();
  return readFileSync(EVENTS_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawEvent)
    .map((e) => {
      const duplicate = seen.has(e.event_id);
      seen.add(e.event_id);
      const late = !!e.ingested_at && new Date(e.ingested_at).getTime() - new Date(e.occurred_at).getTime() > 60 * 60_000;
      return { id: e.event_id, type: e.event_type, at: e.occurred_at, customerId: String(e.customer_id ?? ""), payload: e.payload ?? {}, duplicate, late };
    });
}

// ---------- Node catalog ----------

export const TRIGGER_EVENTS: { key: string; label: string; hint?: string }[] = [
  { key: "schedule", label: "Every morning (schedule)", hint: "guarantee ends / segment" },
  { key: "gas_meter_deregistration_received", label: "Gas meter deregistered" },
  { key: "order_placed", label: "Shop order placed", hint: "filter by product name" },
  { key: "cart_abandoned", label: "Cart abandoned" },
  { key: "newsletter_clicked", label: "Newsletter link clicked", hint: "filter by link target" },
  { key: "newsletter_opened", label: "Newsletter opened" },
  { key: "charge_session_failed", label: "Charging failed" },
  { key: "contract_cancellation_received", label: "Cancellation received" },
  { key: "consent_changed", label: "Consent changed", hint: "e.g. withdrawn" },
  { key: "dunning_level_changed", label: "Dunning level changed" },
  { key: "mobile_data_threshold", label: "Mobile data limit reached" },
  { key: "ticket_created", label: "Service ticket created", hint: "filter by category" },
  { key: "ticket_updated", label: "Service ticket updated" },
  { key: "meter_reading_submitted", label: "Meter reading submitted" },
  { key: "hems_device_offline", label: "HEMS device offline" },
  { key: "page_viewed", label: "Portal page viewed", hint: "e.g. moving, tariff_overview" },
  { key: "portal_login", label: "Portal login" },
  { key: "agent_nba_feedback", label: "Agent feedback on a suggestion" },
];

export function nodeCatalog(settings: Settings): NodeDef[] {
  const base: NodeDef[] = [
    { kind: "trigger", label: "When an event happens", group: "Triggers", icon: "zap", description: "Starts the flow for the customer of each matching event.", defaults: { event: "order_placed", contains: "" } },
    { kind: "condition", label: "If / else", group: "Logic", icon: "git-branch", description: "Branch on anything we know about the customer.", defaults: { field: "value_tier", op: "is", value: "high" } },
    { kind: "wait", label: "Wait", group: "Logic", icon: "clock", description: "Wait a number of days before the next step.", defaults: { days: 2 } },
    { kind: "split", label: "A/B split", group: "Logic", icon: "split", description: "Send half the customers down each path to test a variant.", defaults: { shareA: 0.5 } },
    { kind: "stop", label: "Stop", group: "Logic", icon: "octagon", description: "End the flow here.", defaults: {} },
    { kind: "ai_offer", label: "Pick best offer", group: "AI", icon: "sparkles", description: "The engine picks the offer with the highest expected CLV gain, or use a fixed offer.", defaults: { mode: "engine" } },
    { kind: "ai_write", label: "Write message with AI", group: "AI", icon: "wand", description: "AI writes the free-text parts of the template for this customer, inside the guardrails.", defaults: { instruction: "" } },
    { kind: "ai_classify", label: "Detect tone / mood", group: "AI", icon: "scan", description: "Checks Du/Sie and whether the customer is upset; upset customers get service, not offers.", defaults: { what: "mood" } },
    { kind: "send", label: "Send message", group: "Actions", icon: "send", description: "Email, portal pop-up or SMS from a template. 'Best' uses the consented channel the engine picks.", defaults: { channel: "best", templateId: "TPL-personal-offer" } },
    { kind: "task", label: "Create service task", group: "Actions", icon: "clipboard", description: "A task for the service team, e.g. a callback.", defaults: { team: "Kundenservice", text: "" } },
    { kind: "voucher", label: "Give voucher", group: "Actions", icon: "gift", description: "A uniform shop voucher (never a personalised price).", defaults: { valueEur: 5 } },
    { kind: "survey", label: "Send survey", group: "Actions", icon: "star", description: "1–5 satisfaction survey.", defaults: { templateId: "TPL-feedback" } },
    { kind: "notify", label: "Notify team", group: "Actions", icon: "bell", description: "A note to the marketing or service team.", defaults: { team: "Marketing", text: "" } },
    { kind: "cancel_queued", label: "Cancel queued messages", group: "Actions", icon: "ban", description: "Cancels this customer's pending messages, e.g. after a consent withdrawal.", defaults: {} },
    { kind: "gate", label: "Consent & exclusions", group: "Safety", icon: "shield", description: "Always on: consent per channel, profiling consent, no sales during dunning, open complaints or cancellations.", defaults: {} },
    { kind: "approval", label: "Human approval", group: "Safety", icon: "user-check", description: "Always on: messages wait for approval. Nothing is sent automatically.", defaults: { role: "Marketing" } },
  ];
  const cmds: NodeDef[] = settings.commands
    .filter((c) => !c.builtIn)
    .map((c) => ({ kind: "command", label: c.name, group: "Commands", icon: "terminal", description: c.description, defaults: { commandId: c.id }, commandId: c.id }));
  return [...base, ...cmds];
}

// ---------- Plain-language summary ----------

const triggerLabel = (n: FlowNode) => {
  if (n.config.event === "schedule")
    return n.config.schedule === "segment" ? `every morning, customers in segment ${n.config.segment}` : `every morning, price guarantee ends within ${n.config.days ?? 90} days`;
  const e = TRIGGER_EVENTS.find((x) => x.key === n.config.event)?.label ?? String(n.config.event ?? "an event");
  return n.config.contains ? `${e} (“${n.config.contains}”)` : e;
};

export function describeNode(n: FlowNode, settings: Settings): string {
  const c = n.config;
  switch (n.kind) {
    case "trigger": {
      // A segment key reads better as words ("price_guarantee_ending" → "price guarantee ending").
      const seg = c.event === "schedule" && c.schedule === "segment" ? String(c.segment) : "";
      return `When: ${seg ? triggerLabel(n).replace(seg, seg.replace(/_/g, " ")) : triggerLabel(n)}`;
    }
    case "gate":
      return "Check consent & exclusions";
    case "approval":
      return "Wait for approval";
    case "condition": {
      const field = SHOW_IF_FIELDS.find((x) => x.field === c.field)?.label ?? String(c.field).replace(/_/g, " ");
      const op = ({ is: "is", is_not: "is not", gt: "is greater than", lt: "is less than", contains: "includes", not_contains: "does not include", exists: "is set", not_exists: "is not set" } as Record<string, string>)[String(c.op)] ?? String(c.op).replace(/_/g, " ");
      const value = typeof c.value === "boolean" ? (c.value ? "yes" : "no") : String(c.value ?? "");
      return `If “${field}” ${op} ${value}`.trim();
    }
    case "wait":
      return `Wait ${c.days} day${Number(c.days) === 1 ? "" : "s"}`;
    case "split":
      return `A/B split ${Math.round(Number(c.shareA ?? 0.5) * 100)} / ${100 - Math.round(Number(c.shareA ?? 0.5) * 100)}`;
    case "ai_offer":
      return c.mode === "pinned" ? "Fixed offer" : "Engine picks best offer";
    case "ai_write":
      return "AI writes the message";
    case "ai_classify":
      return "Detect tone and mood";
    case "send": {
      const t = ws.templates.find((x) => x.id === c.templateId);
      const via = ({ email: "email", newsletter: "newsletter", portal_popup: "portal pop-up", sms: "SMS", outbound_call: "call" } as Record<string, string>)[String(c.channel)] ?? String(c.channel).replace(/_/g, " ");
      return `Send ${c.channel === "best" ? "via best channel" : `as ${via}`}: ${t?.name ?? "email not found"}`;
    }
    case "task":
      return `Task for ${c.team}`;
    case "voucher":
      return `Give ${c.valueEur} € voucher`;
    case "survey":
      return "Send survey";
    case "notify":
      return `Notify ${c.team}`;
    case "cancel_queued":
      return "Cancel queued messages";
    case "command":
      return settings.commands.find((x) => x.id === c.commandId)?.name ?? "Command";
    case "stop":
      return "Stop";
  }
}

export function summarizeFlow(flow: Flow, settings: Settings): string {
  const t = flow.nodes.find((n) => n.kind === "trigger");
  if (!t) return "No trigger yet: drag a trigger onto the canvas.";
  const parts: string[] = [];
  let cur: FlowNode | undefined = t;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id) && parts.length < 12) {
    seen.add(cur.id);
    if (cur.kind !== "gate" && cur.kind !== "approval") parts.push(describeNode(cur, settings));
    const outs = flow.edges.filter((e) => e.source === cur!.id);
    const next: { target: string } | undefined = cur.kind === "condition" ? (outs.find((e) => e.sourceHandle === "yes") ?? outs[0]) : outs[0];
    if (cur.kind === "condition" && outs.length > 1) {
      const no = outs.find((e) => e.sourceHandle === "no");
      const noNode = no && flow.nodes.find((n) => n.id === no.target);
      if (noNode && noNode.kind !== "stop") parts.push(`(otherwise: ${describeNode(noNode, settings)})`);
    }
    cur = next ? flow.nodes.find((n) => n.id === next.target) : undefined;
  }
  return parts.join(" → ");
}

/** Gate and approval nodes must exist; re-adds them if a client removed them. */
export function enforceSafety(flow: Flow): Flow {
  const nodes = [...flow.nodes];
  const edges = [...flow.edges];
  const trigger = nodes.find((n) => n.kind === "trigger");
  if (trigger && !nodes.some((n) => n.kind === "gate")) {
    const g: FlowNode = { id: newId("n"), kind: "gate", position: { x: trigger.position.x, y: trigger.position.y + 130 }, config: {}, locked: true };
    for (const e of edges.filter((e) => e.source === trigger.id)) e.source = g.id;
    edges.push({ id: newId("e"), source: trigger.id, target: g.id });
    nodes.push(g);
  }
  const needsApproval = nodes.some((n) => ["send", "voucher", "survey", "command"].includes(n.kind));
  if (needsApproval && !nodes.some((n) => n.kind === "approval")) {
    const first = nodes.find((n) => ["send", "voucher", "survey", "command"].includes(n.kind))!;
    const a: FlowNode = { id: newId("n"), kind: "approval", position: { x: first.position.x, y: first.position.y - 110 }, config: { role: "Marketing" }, locked: true };
    for (const e of edges.filter((e) => e.target === first.id)) e.target = a.id;
    edges.push({ id: newId("e"), source: a.id, target: first.id });
    nodes.push(a);
  }
  for (const n of nodes) if (n.kind === "gate" || n.kind === "approval" || n.kind === "trigger") n.locked = true;
  return { nodes, edges };
}

// ---------- Runner ----------

function matches(trigger: FlowNode, e: StreamEvent) {
  if (trigger.config.event === "schedule" || trigger.config.event !== e.type) return false;
  const needle = String(trigger.config.contains ?? "").trim().toLowerCase();
  if (!needle) return true;
  return JSON.stringify(e.payload).toLowerCase().includes(needle);
}

const CONSENT_CHANNEL: Record<string, string[]> = {
  marketing_email: ["email"],
  newsletter_email: ["newsletter", "email"],
  marketing_sms: ["sms"],
  marketing_phone: ["outbound_call"],
  portal_app_personalisation: ["portal_popup"],
  profiling_analytics: ["email", "newsletter", "portal_popup", "sms", "outbound_call"],
};

/** A person already approved or rejected this step for this event in an earlier run. */
const decided = (p: Proposal) =>
  ws.proposals.some((x) => x.source.id === p.source.id && x.customerId === p.customerId && x.eventAt === p.eventAt && x.kind === p.kind && (x.status === "approved" || x.status === "rejected"));

async function walk(a: Automation, e: StreamEvent, report: RunReport) {
  const flow = a.flow;
  const trigger = flow.nodes.find((n) => n.kind === "trigger")!;
  const r = await loadRecipient(e.customerId);
  const s = r.profile.summary;
  const name = r.identity.name;
  const hit = (outcome: string) => report.hits.push({ automationId: a.id, automationName: a.name, customerId: e.customerId, customerName: name, event: e.type, at: e.at, outcome });
  let cur: FlowNode | undefined = trigger;
  let offer = s.best_action && s.best_action.action_type !== "service" ? s.best_action : null;
  let waitDays = 0;
  const outcomes: string[] = [];
  const seen = new Set<string>();

  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const c: Record<string, unknown> = cur.config;
    let handle: string | null = null;
    switch (cur.kind) {
      case "gate":
        break;
      case "condition": {
        const ok: boolean = evalShowIf([{ field: String(c.field), op: c.op as never, value: c.value as never }], r.f).ok;
        handle = ok ? "yes" : "no";
        break;
      }
      case "split":
        handle = parseInt(e.customerId.replace(/\D/g, "").slice(-2), 10) / 100 < Number(c.shareA ?? 0.5) ? "a" : "b";
        break;
      case "wait":
        waitDays += Number(c.days ?? 0);
        break;
      case "ai_offer": {
        const pinned = c.mode === "pinned" ? String(c.offerId) : null;
        offer = pinned ? ([...r.profile.recommended_actions, ...r.profile.suppressed_actions].find((x) => x.offer_id === pinned) ?? null) : (r.profile.recommended_actions.find((x) => x.action_type !== "service") ?? null);
        break;
      }
      case "ai_classify":
        if (s.pains.includes("upset") || s.service_case) outcomes.push("customer upset or in a service case: service first");
        break;
      case "cancel_queued": {
        const consent = String(e.payload.consent_type ?? "");
        const chans = CONSENT_CHANNEL[consent] ?? [];
        let n = 0;
        for (const p of ws.proposals) {
          if (p.customerId === e.customerId && p.status === "pending" && (chans.length === 0 || chans.includes(p.channel) || p.channel === "best")) {
            p.status = "cancelled";
            p.cancelReason = `Consent ${consent || "changed"} withdrawn at ${e.at.slice(0, 16).replace("T", " ")}`;
            n++;
          }
        }
        report.cancelled += n;
        outcomes.push(n ? `cancelled ${n} queued message${n > 1 ? "s" : ""}` : "no queued messages to cancel");
        break;
      }
      case "send":
      case "survey":
      case "voucher": {
        const tplId = String(c.templateId ?? (cur.kind === "survey" ? "TPL-feedback" : "TPL-personal-offer"));
        const tpl = ws.templates.find((t) => t.id === tplId) ?? ws.templates[0];
        const isSales = offer && offer.action_type !== "service";
        if (isSales && !r.profile.contact_policy.sales_allowed && !tpl.email.blocks.some((b) => b.type === "service_status")) {
          outcomes.push(`blocked: ${s.sales_blockers.join(", ") || "sales not allowed"}`);
          cur = undefined;
          continue;
        }
        const want = String(c.channel ?? "best");
        const allowed = r.profile.contact_policy.allowed_channels;
        const enabled = (ch: string) => ws.settings.terms.channelsEnabled[ch] !== false;
        // "Best" is the engine's channel; if Settings switched it off, the next consented channel that is still on.
        const best = s.contact_channel ?? allowed[0] ?? "";
        const channel = want !== "best" ? want : enabled(best) ? best : (allowed.find(enabled) ?? best);
        if (!channel || !allowed.includes(channel)) {
          outcomes.push(`no consent for ${want === "best" ? "any marketing channel" : channel}`);
          cur = undefined;
          continue;
        }
        if (!enabled(channel)) {
          log.debug("automations", `${a.name}: ${channel} is switched off in Settings`, { event: e.type, customer: e.customerId, channel });
          outcomes.push(`${channel.replace("_", " ")} switched off in Settings`);
          cur = undefined;
          continue;
        }
        // Contact limit from Settings: messages sent in the last 30 days plus those already queued.
        const limit = ws.settings.terms.contactLimit30d;
        const since = Date.now() - 30 * 86400000;
        const used =
          ws.sends.filter((x) => x.customerId === e.customerId && new Date(x.at).getTime() >= since).length +
          ws.proposals.filter((x) => x.customerId === e.customerId && x.status === "pending" && x.kind !== "task" && x.kind !== "notify").length;
        if (used >= limit) {
          outcomes.push(`contact limit reached (${limit} per 30 days)`);
          cur = undefined;
          continue;
        }
        // The same count on this channel alone, against the per-channel limit from Settings.
        const channelLimit = ws.settings.terms.channelLimits30d[channel];
        if (channelLimit != null) {
          const onChannel =
            ws.sends.filter((x) => x.customerId === e.customerId && x.channel === channel && new Date(x.at).getTime() >= since).length +
            ws.proposals.filter((x) => x.customerId === e.customerId && x.channel === channel && x.status === "pending" && x.kind !== "task" && x.kind !== "notify").length;
          if (onChannel >= channelLimit) {
            log.debug("automations", `${a.name}: ${e.customerId} is at the ${channel} limit`, { event: e.type, channel, used: onChannel, limit: channelLimit });
            outcomes.push(`contact limit reached for ${channel.replace("_", " ")} (${channelLimit} per 30 days)`);
            cur = undefined;
            continue;
          }
        }
        const rendered = await renderEmail(tpl.email, e.customerId, ws.settings, channel, { signal: e.type === "schedule" ? undefined : e.type });
        const substance = rendered.blocks.filter((b) => b.visible && !["greeting", "footer", "hero", "divider", "button"].includes(b.type));
        if (substance.length === 0) {
          outcomes.push("nothing relevant to say: stay silent");
          cur = undefined;
          continue;
        }
        const p: Proposal = {
          id: newId("PRP"),
          source: { kind: "automation", id: a.id, name: a.name },
          customerId: e.customerId,
          customerName: name,
          trigger: e.type,
          eventAt: e.at,
          kind: cur.kind === "send" ? "message" : cur.kind,
          offerId: rendered.variant.startsWith("offer:") ? rendered.variant.slice(6) : undefined,
          productName: rendered.variant.startsWith("offer:") ? rendered.variantLabel.replace("Offer: ", "") : undefined,
          channel,
          tone: rendered.tone,
          subject: rendered.subject,
          body: toPlain(rendered, channel === "sms" ? 300 : channel === "portal_popup" ? 260 : undefined),
          reason: offer && rendered.variant === `offer:${offer.offer_id}` ? offer.reason : rendered.variant.startsWith("offer:") ? `${rendered.variantLabel.replace("Offer: ", "")} after ${e.type.replace(/_/g, " ")}` : rendered.variant === "service" ? `Service first: ${s.sales_blockers.join(", ") || "open case"}` : `Triggered by ${e.type}`,
          dclvEur: offer?.dclv_eur,
          sendAfterDays: waitDays || undefined,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        if (decided(p)) {
          outcomes.push("already decided in an earlier run");
          break;
        }
        ws.proposals.unshift(p);
        report.proposalsCreated++;
        a.stats.proposals++;
        outcomes.push(`${rendered.variantLabel} via ${channel.replace("_", " ")}${waitDays ? ` after ${waitDays} d` : ""}`);
        break;
      }
      case "task":
      case "notify":
      case "command": {
        const cmd = cur.kind === "command" ? ws.settings.commands.find((x) => x.id === c.commandId) : null;
        const p: Proposal = {
          id: newId("PRP"),
          source: { kind: "automation", id: a.id, name: a.name },
          customerId: e.customerId,
          customerName: name,
          trigger: e.type,
          eventAt: e.at,
          kind: cmd ? cmd.kind : cur.kind === "task" ? "task" : "notify",
          channel: cmd?.channel ?? "internal",
          tone: r.tone,
          subject: cmd ? cmd.name : `${cur.kind === "task" ? "Aufgabe" : "Hinweis"} für ${c.team}`,
          body: String(cmd?.template?.[r.tone] ?? c.text ?? cmd?.description ?? ""),
          reason: `${a.name}: ${e.type.replace(/_/g, " ")}`,
          sendAfterDays: waitDays || undefined,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        if (decided(p)) {
          outcomes.push("already decided in an earlier run");
          break;
        }
        ws.proposals.unshift(p);
        report.proposalsCreated++;
        a.stats.proposals++;
        outcomes.push(cmd ? cmd.name : `task for ${c.team}`);
        break;
      }
      case "stop":
        cur = undefined;
        continue;
    }
    const outs = flow.edges.filter((x) => x.source === cur!.id);
    const next: FlowEdge | undefined = handle ? (outs.find((x) => x.sourceHandle === handle) ?? (handle === "yes" || handle === "a" ? outs.find((x) => !x.sourceHandle) : undefined)) : outs[0];
    if (handle && !next) outcomes.push(`condition “${handle}” path is empty`);
    cur = next ? flow.nodes.find((n) => n.id === next.target) : undefined;
  }
  a.stats.hits++;
  hit(outcomes.join("; ") || "no action");
}

const emptyReport = (): RunReport => ({ ranAt: new Date().toISOString(), events: 0, duplicates: 0, late: 0, hits: [], proposalsCreated: 0, cancelled: 0 });

function failed(report: RunReport, a: Automation, e: StreamEvent, err: unknown) {
  log.error("automations", `${a.name} failed on ${e.type} for ${e.customerId}`, err);
  report.hits.push({ automationId: a.id, automationName: a.name, customerId: e.customerId, customerName: e.customerId, event: e.type, at: e.at, outcome: `error: ${(err as Error).message}` });
}

/** Scheduled flows ("every morning") for the start of the replayed day. */
export async function runScheduledFlows(autos: Automation[], dayStart: string, report: RunReport) {
  for (const a of autos) {
    const t = a.flow.nodes.find((n) => n.kind === "trigger");
    if (t?.config.event !== "schedule") continue;
    const audience = t.config.schedule === "segment" ? { segments: [String(t.config.segment)] } : { guarantee_ends_within_days: Number(t.config.days ?? 90) };
    const page = await searchCustomers({ audience, limit: 500, sort: "customer_id", desc: false });
    await mapLimit(page.items, 6, async (cst) => {
      const e: StreamEvent = { id: `sched-${a.id}-${cst.customer_id}`, type: "schedule", at: `${dayStart} 00:00:00`, customerId: cst.customer_id, payload: {}, duplicate: false, late: false };
      try {
        await walk(a, e, report);
      } catch (err) {
        failed(report, a, e, err);
      }
    });
  }
}

/** The enabled flows triggered by one event. The live replay calls this as each event arrives. */
export async function runFlowsForEvent(e: StreamEvent, report = emptyReport()) {
  const before = new Set(ws.proposals.map((p) => p.id));
  for (const a of ws.automations.filter((x) => x.enabled)) {
    const t = a.flow.nodes.find((n) => n.kind === "trigger");
    if (!t || !matches(t, e)) continue;
    try {
      await walk(a, e, report);
    } catch (err) {
      failed(report, a, e, err);
    }
  }
  save();
  return { created: ws.proposals.filter((p) => !before.has(p.id)).map((p) => p.id), hits: report.hits };
}

/** How often each outcome happened, for the log. */
function outcomeCounts(report: RunReport) {
  const out: Record<string, number> = {};
  for (const h of report.hits) for (const o of h.outcome.split("; ")) out[o.replace(/\d+ queued/, "N queued")] = (out[o.replace(/\d+ queued/, "N queued")] ?? 0) + 1;
  return out;
}

export async function runMorningFlows(dayStart: string) {
  const report = emptyReport();
  const before = new Set(ws.proposals.map((p) => p.id));
  await runScheduledFlows(ws.automations.filter((a) => a.enabled), dayStart, report);
  save();
  log.info("automations", `morning run: ${report.hits.length} checked`, outcomeCounts(report));
  return { created: ws.proposals.filter((p) => !before.has(p.id)).map((p) => p.id), hits: report.hits };
}

export async function runAutomations(opts: { reset?: boolean; automationId?: string } = {}): Promise<RunReport> {
  // A re-run replaces the open proposals of the automations it runs; approved and rejected ones stay.
  if (opts.reset)
    ws.proposals = ws.proposals.filter((p) => p.source.kind !== "automation" || p.status === "approved" || p.status === "rejected" || (opts.automationId != null && p.source.id !== opts.automationId));
  const events = loadEvents();
  const unique = events.filter((e) => !e.duplicate).sort((a, b) => a.at.localeCompare(b.at));
  const report: RunReport = {
    ...emptyReport(),
    events: events.length,
    duplicates: events.filter((e) => e.duplicate).length,
    late: events.filter((e) => e.late && !e.duplicate).length,
  };
  const autos = ws.automations.filter((a) => a.enabled && (!opts.automationId || a.id === opts.automationId));
  for (const a of autos) a.stats = { hits: 0, proposals: 0, lastRunAt: report.ranAt };

  // Scheduled flows run first ("every morning" at the start of the replayed day).
  await runScheduledFlows(autos, unique[0]?.at.slice(0, 10) ?? "2026-10-01", report);

  for (const e of unique) {
    if (!e.customerId) continue;
    for (const a of autos) {
      const t = a.flow.nodes.find((n) => n.kind === "trigger");
      if (!t || !matches(t, e)) continue;
      try {
        await walk(a, e, report);
      } catch (err) {
        failed(report, a, e, err);
      }
    }
  }
  ws.lastRun = report;
  save();
  log.info("automations", `run: ${report.hits.length} hits, ${report.proposalsCreated} proposals, ${report.cancelled} cancelled`);
  return report;
}
