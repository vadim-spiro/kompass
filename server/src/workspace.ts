// The Kompass workspace: everything marketing creates (campaigns, email templates, automations,
// settings, proposals, conversations). Persisted to server/workspace.json and seeded on first run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentFeedback, Automation, Block, Campaign, ChartSpec, Conversation, DeskItem, DraftChannel, EmailDoc, Flow, FlowEdge, FlowNode, LiveDecision, LiveFacts, Proposal, RunReport, SavedChart, Settings } from "../../shared/types.ts";

// WORKSPACE_FILE moves it onto the data disk in the server deploy (deploy/README.md).
const FILE = process.env.WORKSPACE_FILE ?? join(dirname(fileURLToPath(import.meta.url)), "..", "workspace.json");

export interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  email: EmailDoc;
  updatedAt: string;
}

export interface SendLog {
  customerId: string;
  channel: string;
  at: string;
  campaignId: string;
}

export interface Workspace {
  version: number;
  settings: Settings;
  templates: EmailTemplate[];
  campaigns: Campaign[];
  automations: Automation[];
  proposals: Proposal[];
  conversations: Conversation[];
  sends: SendLog[];
  charts: SavedChart[];
  lastRun?: RunReport;
  /** The replay of the 01.10. event stream: clock, what it changed, and the service desk it fed. */
  live?: LiveStore;
}

export interface LiveStore {
  clock: string;
  morningRun: boolean;
  facts: Record<string, LiveFacts>;
  decisions: LiveDecision[];
  desk: DeskItem[];
  feedback: AgentFeedback[];
  /** Proposals the replay created, and pending ones it cancelled, so a restart can undo both. */
  created: string[];
  cancelled: string[];
}

const now = () => new Date().toISOString();
let seq = Date.now() % 100000;
export const newId = (prefix: string) => `${prefix}-${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------- Seed: email blocks ----------

const b = (type: string, props: Record<string, unknown> = {}, showIf?: Block["showIf"]): Block => ({ id: newId("b"), type, props, ...(showIf ? { showIf } : {}) });

export function defaultEmail(): EmailDoc {
  return {
    subject: { sie: "Ein persönliches Update von MAINGAU", du: "Ein persönliches Update von MAINGAU" },
    blocks: [
      b("hero", { title: "Für Sie zusammengestellt", titleDu: "Für dich zusammengestellt", style: "green" }),
      b("greeting", {}),
      b("last_contact", { maxDays: 120 }),
      b("service_status", {}),
      b("offer", { mode: "engine" }),
      b("savings", { allowAssumptions: false }),
      b("guarantee", { withinDays: 120 }),
      b("footer", {}),
    ],
  };
}

/** Starting drafts for the other channels: a short pop-up, an SMS and a call script for the agent. */
export function defaultDrafts(): Record<DraftChannel, EmailDoc> {
  return {
    portal_popup: {
      subject: { sie: "", du: "" },
      blocks: [b("hero", { title: "Für Sie zusammengestellt", titleDu: "Für dich zusammengestellt", style: "green" }), b("service_status"), b("offer", { mode: "engine" }), b("savings", { allowAssumptions: false }), b("guarantee", { withinDays: 120 })],
    },
    sms: {
      subject: { sie: "", du: "" },
      blocks: [b("greeting"), b("service_status"), b("offer", { mode: "engine" }), b("guarantee", { withinDays: 120 }), b("text", { sie: "Ihre MAINGAU Energie", du: "Deine MAINGAU Energie" })],
    },
    call: {
      subject: { sie: "", du: "" },
      blocks: [
        b("greeting"),
        b("last_contact", { maxDays: 120 }),
        b("service_status"),
        b("guarantee", { withinDays: 120 }),
        b("offer", { mode: "engine" }),
        b("savings", { allowAssumptions: false }),
        b("objections"),
        b("text", { title: "Abschluss", sie: "Darf ich Ihnen die Details per E-Mail schicken? Dann können Sie in Ruhe entscheiden.", du: "Darf ich dir die Details per E-Mail schicken? Dann kannst du in Ruhe entscheiden." }),
      ],
    },
  };
}

function templates(): EmailTemplate[] {
  const t = (id: string, name: string, description: string, subject: EmailDoc["subject"], blocks: Block[]): EmailTemplate => ({
    id,
    name,
    description,
    email: { subject, blocks },
    updatedAt: now(),
  });
  return [
    t("TPL-personal-offer", "Persönliches Angebot", "Greeting, last contact, the engine's best offer, savings. Service version for customers with an open case.", { sie: "Etwas, das zu Ihnen passt", du: "Etwas, das zu dir passt" }, [
      b("greeting"),
      b("last_contact", { maxDays: 120 }),
      b("service_status"),
      b("offer", { mode: "engine" }),
      b("savings", { allowAssumptions: false }),
      b("footer"),
    ]),
    t("TPL-heat-pump", "Neue Heizung: StromWärme", "Life event: gas meter deregistered. Heat-pump tariff with the real saving.", { sie: "Ihre neue Heizung und der passende Strom", du: "Deine neue Heizung und der passende Strom" }, [
      b("greeting"),
      b("text", { sie: "wir haben gesehen, dass Ihr Gaszähler abgemeldet wurde. Viele unserer Kundinnen und Kunden heizen danach mit einer Wärmepumpe.", du: "wir haben gesehen, dass dein Gaszähler abgemeldet wurde. Viele heizen danach mit einer Wärmepumpe." }),
      b("offer", { mode: "pinned", offerId: "P-EN-03" }),
      b("savings", { allowAssumptions: true, kinds: ["heat_pump_tariff"] }),
      b("article", { topic: "auto" }),
      b("footer"),
    ]),
    t("TPL-wallbox", "Wallbox: Laden zu Hause und unterwegs", "Interest in a wallbox: home charging plus Autostrom on the road.", { sie: "Laden zu Hause und unterwegs", du: "Laden zu Hause und unterwegs" }, [
      b("greeting"),
      b("text", { sie: "Sie interessieren sich für eine Wallbox. Damit laden Sie zu Hause bequem und günstiger als an öffentlichen Säulen. Gern beraten wir Sie zur Installation.", du: "du interessierst dich für eine Wallbox. Damit lädst du zu Hause bequem und günstiger als an öffentlichen Säulen. Gern beraten wir dich zur Installation." }),
      b("offer", { mode: "pinned", offerId: "P-AS-01" }),
      b("article", { topic: "wallbox" }),
      b("footer"),
    ]),
    t("TPL-guarantee", "Preisgarantie endet", "Factual reminder before the price guarantee ends, with the renewal offer where eligible.", { sie: "Ihre Preisgarantie: alles Wichtige", du: "Deine Preisgarantie: alles Wichtige" }, [
      b("greeting"),
      b("guarantee", { withinDays: 120 }),
      b("service_status"),
      b("offer", { mode: "pinned", offerId: "P-EN-02" }),
      b("savings", { allowAssumptions: false }),
      b("footer"),
    ]),
    t("TPL-service-fix", "Service zuerst", "For customers with an open case: acknowledge, no offer.", { sie: "Ihr Anliegen ist bei uns angekommen", du: "Dein Anliegen ist bei uns angekommen" }, [
      b("greeting"),
      b("last_contact", { maxDays: 60 }),
      b("service_status"),
      b("text", { sie: "Wenn Sie Fragen haben, antworten Sie einfach auf diese E-Mail.", du: "Wenn du Fragen hast, antworte einfach auf diese E-Mail." }),
      b("footer"),
    ]),
    t("TPL-feedback", "Feedback mit Dankeschön", "Short survey after a resolved case, optional €5 shop voucher.", { sie: "Wie war Ihre Erfahrung mit uns?", du: "Wie war deine Erfahrung mit uns?" }, [
      b("greeting"),
      b("last_contact", { maxDays: 60 }),
      b("survey", { question: "Wie zufrieden waren Sie mit der Lösung?", questionDu: "Wie zufrieden warst du mit der Lösung?", voucher: true, voucherEur: 5 }),
      b("footer"),
    ]),
  ];
}

// ---------- Seed: automations (n8n-style flows) ----------

let nodeSeq = 0;
const node = (kind: FlowNode["kind"], x: number, y: number, config: Record<string, unknown> = {}, locked = false): FlowNode => ({
  id: `n${++nodeSeq}-${kind}`,
  kind,
  position: { x, y },
  config,
  ...(locked ? { locked: true } : {}),
});
const edge = (a: FlowNode, z: FlowNode, sourceHandle?: string): FlowEdge => ({ id: `e-${a.id}-${z.id}${sourceHandle ? `-${sourceHandle}` : ""}`, source: a.id, target: z.id, sourceHandle: sourceHandle ?? null });

/** Builds a flow; gate after the trigger and approval before the first send are always present. */
function linear(trigger: Record<string, unknown>, steps: [FlowNode["kind"], Record<string, unknown>][]): Flow {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let y = 0;
  const t = node("trigger", 0, y, trigger, true);
  const g = node("gate", 0, (y += 130), {}, true);
  nodes.push(t, g);
  edges.push(edge(t, g));
  let prev = g;
  let approvalAdded = false;
  for (const [kind, config] of steps) {
    if (!approvalAdded && ["send", "voucher", "survey"].includes(kind)) {
      const a = node("approval", 0, (y += 130), { role: "Marketing" }, true);
      nodes.push(a);
      edges.push(edge(prev, a));
      prev = a;
      approvalAdded = true;
    }
    const n = node(kind, 0, (y += 130), config);
    nodes.push(n);
    edges.push(edge(prev, n));
    prev = n;
  }
  return { nodes, edges };
}

function automations(): Automation[] {
  const a = (name: string, description: string, flow: Flow, enabled = true): Automation => ({
    id: newId("AUT"),
    name,
    description,
    enabled,
    flow,
    createdAt: now(),
    updatedAt: now(),
    stats: { hits: 0, proposals: 0 },
  });

  // Wallbox: with a branch, so the canvas shows a real flow.
  const wallbox = (() => {
    const t = node("trigger", 0, 0, { event: "cart_abandoned", contains: "Wallbox" }, true);
    const g = node("gate", 0, 130, {}, true);
    const c = node("condition", 0, 260, { field: "has_autostrom", op: "is", value: false });
    const w = node("wait", -190, 390, { days: 1 });
    const ap = node("approval", -190, 520, { role: "Marketing" }, true);
    const s = node("send", -190, 650, { channel: "best", templateId: "TPL-wallbox" });
    const st = node("stop", 190, 390, {});
    return { nodes: [t, g, c, w, ap, s, st], edges: [edge(t, g), edge(g, c), edge(c, w, "yes"), edge(w, ap), edge(ap, s), edge(c, st, "no")] };
  })();

  return [
    a(
      "Gaszähler abgemeldet → StromWärme",
      "A deregistered gas meter usually means a new heat pump. Offer the heat-pump tariff with the real saving.",
      linear({ event: "gas_meter_deregistration_received" }, [
        ["ai_offer", { mode: "pinned", offerId: "P-EN-03" }],
        ["send", { channel: "best", templateId: "TPL-heat-pump" }],
      ]),
    ),
    a("Wallbox im Warenkorb → Laden zu Hause", "Customer looked at a wallbox but has no Autostrom yet: advice on charging at home and on the road.", wallbox),
    a(
      "Preisgarantie endet → Erinnerung",
      "Every morning: customers whose price guarantee ends within 100 days get a factual reminder, with StromGarant where eligible.",
      linear({ event: "schedule", schedule: "guarantee_ends", days: 100 }, [["send", { channel: "best", templateId: "TPL-guarantee" }]]),
    ),
    a(
      "Fehlgeschlagenes Laden → Service-Fix",
      "Failed charging session: create a service task and refund billed failed sessions. No offer.",
      linear({ event: "charge_session_failed" }, [
        ["task", { team: "Autostrom-Service", text: "Ladevorgang fehlgeschlagen: prüfen, ggf. erstatten und Kunde informieren." }],
        ["send", { channel: "best", templateId: "TPL-service-fix" }],
      ]),
    ),
    a(
      "Newsletter-Klick Smart Living → Follow-up",
      "Someone clicks the smart-living story: follow up personally with the offer the engine rates best for them (highest expected CLV gain).",
      linear({ event: "newsletter_clicked", contains: "smart_living" }, [
        ["ai_offer", { mode: "engine" }],
        ["send", { channel: "best", templateId: "TPL-personal-offer" }],
      ]),
    ),
    a(
      "Kündigung eingegangen → Rückruf",
      "Cancellation received: a personal win-back call task for the service team, no automated sales mail.",
      linear({ event: "contract_cancellation_received" }, [["task", { team: "Kundenservice", text: "Kündigung eingegangen: Kunde persönlich anrufen, Grund verstehen, Lösung anbieten." }]]),
    ),
    a(
      "Einwilligung widerrufen → Warteschlange stoppen",
      "A withdrawn consent stops queued messages on that channel at once.",
      linear({ event: "consent_changed", contains: "withdrawn" }, [["cancel_queued", {}]]),
    ),
    a(
      "Warenkorb abgebrochen → Erinnerung im Portal",
      "Cart abandoned in the shop: a gentle portal reminder after one day, only with consent.",
      linear({ event: "cart_abandoned" }, [
        ["wait", { days: 1 }],
        ["send", { channel: "portal_popup", templateId: "TPL-personal-offer" }],
      ]),
      false,
    ),
  ];
}

// ---------- Seed: settings ----------

function settings(): Settings {
  return {
    terms: {
      contactLimit30d: 2,
      channelLimits30d: { sms: 1, outbound_call: 1, portal_popup: 2, email: 2, newsletter: 4 },
      quietDaysAfterComplaint: 14,
      holdoutShare: 0.1,
      channelsEnabled: { email: true, newsletter: true, portal_popup: true, sms: true, outbound_call: true },
      minDclvEur: 0,
      requireSecondApprover: true,
    },
    commands: [
      { id: "CMD-task", name: "Service-Aufgabe anlegen", kind: "task", channel: null, description: "Creates a task for the service team in the CRM.", costEur: 0, needsApproval: false, builtIn: true },
      { id: "CMD-callback", name: "Rückruf planen", kind: "task", channel: "outbound_call", description: "Schedules a personal call by the service team.", costEur: 6, needsApproval: true, builtIn: true },
      { id: "CMD-voucher", name: "5-€-Shop-Gutschein", kind: "voucher", channel: "email", description: "A uniform €5 shop voucher, e.g. as a thank-you for feedback. Not a personalised price.", costEur: 5, needsApproval: true, builtIn: true },
      { id: "CMD-survey", name: "Kurzumfrage senden", kind: "survey", channel: "email", description: "Sends the 1–5 satisfaction survey.", costEur: 0.01, needsApproval: true, builtIn: true },
      { id: "CMD-notify", name: "Team benachrichtigen", kind: "notify", channel: null, description: "Posts a note to the marketing or service team.", costEur: 0, needsApproval: false, builtIn: true },
    ],
    customBlocks: [
      {
        id: "app-tip",
        name: "App-Tipp",
        description: "Shown to customers without the MAINGAU app: how to submit meter readings in the app.",
        sie: "Tipp: Mit der MAINGAU App melden Sie Ihren Zählerstand in Sekunden und sehen Ihren Verbrauch jederzeit.",
        du: "Tipp: Mit der MAINGAU App meldest du deinen Zählerstand in Sekunden und siehst deinen Verbrauch jederzeit.",
        showIf: [{ field: "app_installed", op: "is", value: false }],
      },
    ],
    voice: {
      avoidWords: ["nur heute", "letzte Chance", "sofort zugreifen", "Schnäppchen"],
      signOff: { sie: "Viele Grüße\nIhr MAINGAU Team", du: "Viele Grüße\nDein MAINGAU Team" },
      notes: "Klar, freundlich, ohne Druck. Erst helfen, dann anbieten. Keine Preise versprechen, die nicht im Katalog stehen.",
    },
  };
}

// ---------- Analytics: starter charts, phrased as the questions marketing asks ----------

function charts(): SavedChart[] {
  const at = now();
  const q = (id: string, title: string, spec: ChartSpec): SavedChart => ({ id: `CH-${id}`, title, spec, origin: "starter", createdAt: at, updatedAt: at });
  return [
    q("tone", "Du or Sie: who converts better?", { source: "offers", x: "tone", measures: ["conversion_rate"], filters: [{ field: "control_group", values: ["false"] }] }),
    q("channel-uplift", "Which channel beats its control group?", { source: "offers", x: "channel", measures: ["uplift"] }),
    q("best-hour", "Best hour to send an offer", { source: "offers", x: "hour", measures: ["response_rate"] }),
    q("ticket-reasons", "Why customers contact service, by month", { source: "tickets", x: "month", split: "category", measures: ["count"], chart: "stacked" }),
    q("charging-failures", "Why charging fails", { source: "charging", x: "failure_reason", measures: ["count"], filters: [{ field: "status", values: ["failed"] }] }),
    q("newsletter-topic", "Which newsletter topic gets clicks?", { source: "newsletter", x: "topic", split: "tone", measures: ["click_rate"] }),
  ];
}

// ---------- Store ----------

function seed(): Workspace {
  return { version: 1, settings: settings(), templates: templates(), campaigns: [], automations: automations(), proposals: [], conversations: [], sends: [], charts: charts() };
}

function load(): Workspace {
  if (existsSync(FILE)) {
    try {
      const ws = JSON.parse(readFileSync(FILE, "utf8")) as Workspace;
      if (ws.version === 1) {
        // Drafts from before the multi-channel step get their own pop-up, SMS and call script.
        for (const c of ws.campaigns) if (c.source === "kompass" && c.status === "draft" && !c.drafts) c.drafts = defaultDrafts();
        ws.charts ??= charts();
        return ws;
      }
    } catch {
      // fall through to a fresh seed
    }
  }
  return seed();
}

export const ws: Workspace = load();

let timer: NodeJS.Timeout | null = null;
/** Persists the workspace (debounced). Call after every mutation. */
export function save() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    writeFileSync(FILE, JSON.stringify(ws, null, 1));
    timer = null;
  }, 300);
}

/** Resets the workspace to the seed (keeps nothing). */
export function resetWorkspace() {
  const fresh = seed();
  for (const k of Object.keys(ws) as (keyof Workspace)[]) delete (ws as Partial<Workspace>)[k];
  Object.assign(ws, fresh);
  save();
}

export function touch<T extends { updatedAt: string }>(x: T) {
  x.updatedAt = now();
  save();
  return x;
}
