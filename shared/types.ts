// Types shared by the Kompass workspace server and the web app.
// Customer data, decisions and campaign plans come from the team's insights service
// (maingau-master/customer-intelligence/service); Kompass adds campaigns, email blocks,
// automations, settings and the assistant on top.

export type Tone = "du" | "sie";
/** Channel keys of the insights service, plus service contacts. */
export type Channel = "email" | "newsletter" | "portal_popup" | "sms" | "outbound_call" | "service_contact";

// ---------- Insights service (upstream) ----------

export interface BestAction {
  offer_id: string;
  product_name: string;
  action_type: "sales" | "upsell" | "retention" | "service" | "one_off" | string;
  dclv_eur: number;
  p_accept: number;
  channel: string | null;
  reason: string;
  blocked_by: string | null;
}

export interface CustomerSummary {
  customer_id: string;
  city: string | null;
  tenure_years: number | null;
  value_tier: string;
  clv_eur: number | null;
  churn_prob_12m: number | null;
  value_at_risk_eur: number | null;
  annual_margin_eur: number | null;
  active_business_lines: number;
  products: string[];
  segments: string[];
  personas: string[];
  pains: string[];
  churn_drivers: string[];
  tonality: Tone | null;
  contact_channel: string | null;
  profiling_allowed: boolean;
  service_case: boolean;
  sales_blockers: string[];
  best_action: BestAction | null;
  score: number | null;
}

export interface Saving {
  kind: string;
  customer_id: string;
  title: string;
  annual_saving_eur: number;
  one_off_saving_eur: number;
  investment_eur: number;
  payback_years: number | null;
  basis: "data" | "assumption";
  explanation: string;
  company_effect: string;
  related_offer: string | null;
}

export interface CustomerProfile {
  summary: CustomerSummary;
  contact_policy: {
    allowed_channels: string[];
    profiling_allowed: boolean;
    sales_allowed: boolean;
    sales_blockers: string[];
    salutation: string;
    tone_observed: boolean;
    language: string;
  };
  recommended_actions: BestAction[];
  suppressed_actions: BestAction[];
  savings: Saving[];
  pain_details: { pain: string; description: string; evidence?: string }[];
  features: Record<string, unknown>;
}

export interface TimelineItem {
  occurred_at: string;
  event_type: string;
  status: string | null;
  text: string;
  amount_eur: number | null;
}

/** Audience filter of the insights service (POST /customers/search, /campaigns/plan). */
export interface Audience {
  customer_ids?: string[];
  segments?: string[];
  segments_all?: string[];
  exclude_segments?: string[];
  personas?: string[];
  pains?: string[];
  value_tiers?: string[];
  holds?: string[];
  lacks?: string[];
  reachable_via?: string[];
  churn_drivers?: string[];
  min_churn?: number;
  max_churn?: number;
  min_clv?: number;
  max_clv?: number;
  profiling_allowed?: boolean;
  service_case?: boolean;
  has_positive_action?: boolean;
  best_action_in?: string[];
  eligible_for?: string[];
  tonality?: Tone;
  cities?: string[];
  guarantee_ends_within_days?: number;
  query?: string;
}

export interface Page<T> {
  total: number;
  limit: number;
  offset: number;
  items: T[];
}

export interface VocabItem {
  key: string;
  description: string;
}
export interface OfferInfo {
  offer_id: string;
  product_name: string;
  business_line: string;
  action_type: string;
  disabled: boolean;
}
export interface Vocabulary {
  segments: VocabItem[];
  personas: VocabItem[];
  pains: VocabItem[];
  channels: VocabItem[];
  value_tiers: VocabItem[];
  holdings: VocabItem[];
  churn_drivers: VocabItem[];
  saving_kinds: VocabItem[];
  offers: OfferInfo[];
}

// ---------- Kompass: customers ----------

/** Synthetic identity. The mock data is anonymised, so names and addresses are generated per customer_id. */
export interface Identity {
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  street: string;
  postalCode: string;
  city: string;
  synthetic: true;
}

export interface CustomerRow extends CustomerSummary {
  identity: Identity;
}

export interface Problem {
  key: string;
  label: string;
  detail: string;
  severity: "high" | "medium" | "low";
  since?: string;
}

export interface Contract {
  kind: "energy" | "mobile" | "autostrom";
  id: string;
  title: string;
  status: string;
  detail: string;
  guaranteeUntil?: string | null;
  monthlyEur?: number | null;
}

export interface Customer360 {
  profile: CustomerProfile;
  identity: Identity;
  problems: Problem[];
  contracts: Contract[];
  orders: { product: string; category: string; status: string; month: string }[];
  timeline: TimelineItem[];
  kompass: { at: string; text: string }[];
  spend: { monthlyInstallmentsEur: number; shopEur: number; chargingEur: number };
}

// ---------- Email builder ----------

export type ShowIfOp = "is" | "is_not" | "gt" | "lt" | "contains" | "not_contains" | "exists" | "not_exists";
export interface ShowIf {
  field: string;
  op: ShowIfOp;
  value?: string | number | boolean;
}

export interface Block {
  id: string;
  /** Built-in type or "custom:<id>" for a block defined in Settings. */
  type: string;
  props: Record<string, unknown>;
  showIf?: ShowIf[];
}

export interface EmailDoc {
  subject: { du: string; sie: string };
  blocks: Block[];
}

export interface BlockDef {
  type: string;
  label: string;
  group: "smart" | "content" | "custom";
  description: string;
  icon: string;
  defaults: Record<string, unknown>;
  /** Where the block takes its data from, shown to the marketer. */
  source: string;
  /** Channels the block fits; all when missing. */
  channels?: string[];
}

export interface RenderedBlock {
  id: string;
  type: string;
  visible: boolean;
  hiddenReason?: string;
  title?: string;
  text: string;
  cta?: { label: string; url: string };
  /** Small hint for the marketer, e.g. "from ticket TK-200771". */
  source?: string;
}

export interface GuardrailCheck {
  check: string;
  passed: boolean;
  detail?: string;
}

export interface RenderedEmail {
  customerId: string;
  identity: Identity;
  tone: Tone;
  channel: string;
  reachable: boolean;
  subject: string;
  blocks: RenderedBlock[];
  checks: GuardrailCheck[];
  /** "service", "offer:P-EN-02" or "generic": what this recipient effectively receives. */
  variant: string;
  variantLabel: string;
}

export interface VariantStat {
  variant: string;
  label: string;
  count: number;
}

// ---------- Campaigns ----------

export type CampaignStatus = "draft" | "review" | "running" | "done";

export interface PlanRow {
  customer_id: string;
  status: "contact" | "control" | "skipped";
  action: BestAction | null;
  tonality: Tone | null;
  salutation: string | null;
  value_tier: string;
  churn_prob_12m: number | null;
  skip_reason: string | null;
}

export interface PlanSummary {
  audience: number;
  contacts: number;
  control: number;
  skipped: number;
  expected_dclv_eur: number;
  contact_cost_eur: number;
  by_offer: { key: string; contacts: number; expected_dclv_eur: number }[];
  by_channel: { key: string; contacts: number; expected_dclv_eur: number }[];
  by_tone: { key: string; contacts: number; expected_dclv_eur: number }[];
  skipped_by_reason: Record<string, number>;
}

export interface CampaignPlan {
  summary: PlanSummary;
  rows: PlanRow[];
  computedAt: string;
}

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
}

export interface CampaignResults {
  simulated: boolean;
  funnel: FunnelStep[];
  treated: { n: number; conversions: number; rate: number };
  control: { n: number; conversions: number; rate: number };
  upliftPp: number;
  ci95: [number, number];
  verdict: string;
  realisedDclvEur: number;
  byOffer: { key: string; contacts: number; conversions: number }[];
  byTone: { key: string; contacts: number; opens: number; clicks: number; conversions: number }[];
  orders: { product: string; count: number }[];
  portalVisits: number;
  assumptions: string[];
  learnings?: string;
}

export interface Approval {
  by: string;
  role: string;
  at: string;
}

export type DraftChannel = "portal_popup" | "sms" | "call";

export interface CampaignTiming {
  /** asap = when approved, fixed = at a date and time, best = each customer's most active time of day. */
  mode: "asap" | "fixed" | "best";
  at?: string;
}

export type AudienceGroup = "risk" | "pains" | "guarantee" | "savings" | "offers";

/** A ready-made audience for step 1 of the guided outreach, built from the insights service's analyses. */
export interface AudienceCard {
  id: string;
  group: AudienceGroup;
  title: string;
  description: string;
  customers: number;
  /** Customers with at least one consented channel, when known. */
  reachable?: number;
  /** The headline figure: value at risk, yearly saving or expected CLV gain. */
  metric: { label: string; eur: number };
  churnAvg?: number;
  audience: Audience;
  offerMode?: "engine" | "service";
  goal: string;
  basis?: "data" | "assumption";
}

export type TimeSlot = "morning" | "midday" | "afternoon" | "evening";

export interface BestTimes {
  customers: number;
  /** Customers with enough own activity (3+ signals) for a personal slot. */
  withSignals: number;
  /** Activity per hour of day (0–23) across the audience. */
  hours: number[];
  slots: { key: TimeSlot; label: string; hours: string; sendAt: string; customers: number }[];
  headline: string;
}

export type MessageChannel = "email" | DraftChannel;

/** Step 3 of the guided outreach: what goes out, when, and whether every guardrail holds. */
export interface CampaignReview {
  channels: {
    key: MessageChannel;
    contacts: number;
    /** Distinct versions in the rendered sample (service, offer X, information only). */
    versions: string[];
    hasDraft: boolean;
    sample?: { customerId: string; name: string; tone: Tone; subject: string; text: string };
    smsChars?: number;
  }[];
  schedule: { at: string; label: string; customers: number }[];
  checks: { key: string; label: string; ok: boolean; detail?: string; fix?: "footer" | "control" | "message" }[];
  approvalsNeeded: number;
}

export interface Campaign {
  id: string;
  name: string;
  goal: string;
  status: CampaignStatus;
  source: "kompass" | "legacy_newsletter";
  createdAt: string;
  updatedAt: string;
  audience: Audience;
  audienceLabel: string;
  /** engine = best offer per customer, pinned = specific offers, service = service message only. */
  offerMode: "engine" | "pinned" | "service";
  offerIds: string[];
  actionTypes: string[];
  channels: string[];
  minDclvEur: number;
  maxContacts: number;
  controlShare: number;
  email: EmailDoc;
  /** Drafts for the other channels; e-mail and newsletter use `email`. */
  drafts?: Partial<Record<DraftChannel, EmailDoc>>;
  timing?: CampaignTiming;
  /** The ready-made audience card this campaign started from. */
  audienceSource?: { cardId: string; title: string };
  /** Optional reminder on another channel for everyone who did not react. */
  reminder?: { on: boolean; days: number; channel: string };
  followUp: Flow | null;
  approvals: Approval[];
  plan?: CampaignPlan;
  launchedAt?: string;
  results?: CampaignResults;
}

// ---------- Automations ----------

export type NodeKind =
  | "trigger"
  | "gate"
  | "condition"
  | "wait"
  | "split"
  | "ai_offer"
  | "ai_write"
  | "ai_classify"
  | "send"
  | "task"
  | "voucher"
  | "survey"
  | "notify"
  | "cancel_queued"
  | "approval"
  | "command"
  | "stop";

export interface FlowNode {
  id: string;
  kind: NodeKind;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  locked?: boolean;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** "yes" / "no" for conditions, "a" / "b" for splits. */
  sourceHandle?: string | null;
}

export interface Flow {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  flow: Flow;
  createdAt: string;
  updatedAt: string;
  stats: { hits: number; proposals: number; lastRunAt?: string };
}

export interface NodeDef {
  kind: NodeKind;
  label: string;
  group: "Triggers" | "Logic" | "AI" | "Actions" | "Commands" | "Safety";
  description: string;
  icon: string;
  defaults: Record<string, unknown>;
  /** For "command" nodes: the command id. */
  commandId?: string;
}

export interface Proposal {
  id: string;
  source: { kind: "automation" | "campaign" | "manual"; id: string; name: string };
  customerId: string;
  customerName: string;
  trigger: string;
  eventAt: string;
  kind: "message" | "task" | "voucher" | "survey" | "notify";
  offerId?: string;
  productName?: string;
  channel: string;
  tone: Tone;
  subject?: string;
  body?: string;
  reason: string;
  dclvEur?: number;
  sendAfterDays?: number;
  status: "pending" | "approved" | "rejected" | "cancelled";
  cancelReason?: string;
  createdAt: string;
  /** Who decided and when (the decision log). */
  decidedBy?: string;
  decidedAt?: string;
  /** Set when a person changed the text before approving. */
  editedAt?: string;
  /** Checks run on the text when it was last edited or approved. */
  checks?: GuardrailCheck[];
}

export interface RunReport {
  ranAt: string;
  events: number;
  duplicates: number;
  late: number;
  hits: { automationId: string; automationName: string; customerId: string; customerName: string; event: string; at: string; outcome: string }[];
  proposalsCreated: number;
  cancelled: number;
}

// ---------- Settings ----------

export interface Terms {
  contactLimit30d: number;
  channelLimits30d: Record<string, number>;
  quietDaysAfterComplaint: number;
  holdoutShare: number;
  channelsEnabled: Record<string, boolean>;
  minDclvEur: number;
  requireSecondApprover: boolean;
}

export interface Command {
  id: string;
  name: string;
  kind: "message" | "task" | "voucher" | "survey" | "notify";
  channel: string | null;
  description: string;
  costEur: number;
  needsApproval: boolean;
  template?: { du: string; sie: string };
  builtIn: boolean;
}

export type CommandInput = Partial<Omit<Command, "id" | "builtIn">>;

export interface CustomBlock {
  id: string;
  name: string;
  description: string;
  du: string;
  sie: string;
  showIf: ShowIf[];
}

export interface BrandVoice {
  avoidWords: string[];
  signOff: { du: string; sie: string };
  notes: string;
}

export interface Settings {
  terms: Terms;
  commands: Command[];
  customBlocks: CustomBlock[];
  voice: BrandVoice;
}

// ---------- Assistant ----------

export interface ChatProposal {
  kind: "create_campaign" | "update_campaign" | "create_automation" | "add_command" | "add_block" | "update_terms" | "save_chart" | "open_view";
  title: string;
  description: string;
  payload: Record<string, unknown>;
  status: "pending" | "applied" | "discarded";
  appliedRef?: string;
}

export interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Plain-language step, e.g. "Finding customers". */
  label?: string;
  summary: string;
  ok: boolean;
  proposal?: ChatProposal;
  /** Carried out on screen by the bubble (a UI action), not by the server. */
  ui?: boolean;
  /** Small payload for a rich card in the bubble. */
  display?: ToolDisplay;
}

export type ToolDisplay =
  | { kind: "customers"; total: number; rows: { id: string; name?: string; why?: string; valueAtRiskEur?: number; churn?: number; tone?: string }[] }
  | { kind: "plan"; contacts: number; control: number; skipped: number; expectedDclvEur: number; byChannel: { key: string; contacts: number }[] }
  | { kind: "chart"; spec: Record<string, unknown>; result: unknown };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ChatToolCall[];
  createdAt: string;
  model?: string;
  /** User messages: what was on screen when it was asked, so "this customer" keeps its meaning in the history. */
  focus?: string;
}

export interface ChatContext {
  view?: string;
  customerId?: string;
  campaignId?: string;
  automationId?: string;
  /** What the page reports about itself (see shared/uiActions.ts). */
  screen?: { view: string; title: string; data?: Record<string, unknown> };
  /** Recorded demo (web: ?demo=1): known requests play a fixed script instead of the slow model (server/src/demo.ts). */
  demo?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

/** Server-sent events of POST /api/assistant/conversations/:id/messages. */
export type ChatEvent =
  | { type: "user"; message: ChatMessage }
  | { type: "step"; call: ChatToolCall; phase: "start" | "end" }
  /** Carry out a UI action on screen, then POST the result to /api/assistant/ui-result/:id. */
  | { type: "ui"; call: { id: string; name: string; args: Record<string, unknown> } }
  /** Streamed answer text; reset when the round turns out to call tools after all. */
  | { type: "delta"; text: string }
  | { type: "delta_reset" }
  | { type: "message"; message: ChatMessage }
  | { type: "error"; error: string };

// ---------- Home ----------

export interface HomeData {
  pendingProposals: number;
  campaignsInReview: Campaign[];
  running: Campaign[];
  recentHits: RunReport["hits"];
  kpis: { customers: number; valueAtRiskEur: number; serviceCases: number; customersWithAction: number; opportunityEur: number; savingsEur: number };
  topPains: { key: string; label: string; customers: number; valueAtRiskEur: number }[];
}

// ---------- Analytics ----------

export type ChartKind = "auto" | "bar" | "stacked" | "line" | "table" | "kpi";
export type MeasureFormat = "int" | "pct" | "eur" | "num" | "pp";
/** Only include rows whose field has one of these values (raw keys as strings), or lies in min..max. */
export interface ChartFilter {
  field: string;
  values?: string[];
  min?: number;
  max?: number;
}
export interface ChartSpec {
  source: string;
  x?: string;
  split?: string;
  measures: string[];
  filters?: ChartFilter[];
  chart?: ChartKind;
  limit?: number;
  title?: string;
}
export interface FieldDef {
  key: string;
  label: string;
  group: "own" | "customer" | "time";
  numeric?: boolean;
}
export interface MeasureDef {
  key: string;
  label: string;
  format: MeasureFormat;
  description: string;
}
export interface SourceDef {
  key: string;
  label: string;
  description: string;
  fields: FieldDef[];
  measures: MeasureDef[];
}
export interface ChartRow {
  x: string;
  split?: string;
  values: Record<string, number | null>;
  n: number;
}
export interface ChartResult {
  title: string;
  sentence: string;
  chart: Exclude<ChartKind, "auto">;
  source: string;
  x?: FieldDef;
  split?: FieldDef;
  measures: MeasureDef[];
  categories: string[];
  series: string[];
  rows: ChartRow[];
  /** Per category across the split (only with a split), for the table's total column. */
  xTotals?: ChartRow[];
  totals: Record<string, number | null>;
  n: number;
  insight: string;
  warnings: string[];
}
export interface FieldValue {
  value: string;
  label: string;
  n: number;
}
export interface SavedChart {
  id: string;
  title: string;
  spec: ChartSpec;
  origin: "starter" | "user" | "kompass";
  createdAt: string;
  updatedAt: string;
}

// ---------- Live: the 01.10. event stream, replayed on a clock ----------

export type LiveFlag = "duplicate" | "late" | "out_of_order" | "device_offline";

export interface LiveEvent {
  id: string;
  type: string;
  /** Plain-language line, e.g. "Left “Wallbox 11 kW” in the shop cart". */
  label: string;
  source: string;
  customerId: string;
  occurredAt: string;
  ingestedAt: string;
  /** Minutes between occurring and reaching Kompass. */
  lagMin: number;
  /** Signals make Kompass decide again; activity only updates what it knows. */
  signal: boolean;
  flags: LiveFlag[];
  payload: Record<string, unknown>;
}

export interface LiveAction {
  offerId: string;
  product: string;
  type: string;
  dclvEur: number;
  pAccept: number;
  channel: string | null;
  tone: Tone;
  reason: string;
}

export interface LiveRule {
  rule: string;
  effect: string;
}

/** One logged decision: the event, the rules that fired, the scores before and after, and what changed. */
export interface LiveDecision {
  id: string;
  eventId: string;
  eventType: string;
  eventLabel: string;
  at: string;
  occurredAt: string;
  customerId: string;
  customerName: string;
  headline: string;
  rules: LiveRule[];
  before: LiveAction | null;
  after: LiveAction | null;
  blocked: { product: string; reason: string }[];
  created: string[];
  cancelled: string[];
  deskItemId?: string;
}

export interface DeskItem {
  id: string;
  customerId: string;
  customerName: string;
  channel: "phone" | "chat" | "email" | "portal" | "proactive";
  topic: string;
  detail?: string;
  at: string;
  eventId: string;
  ticketId?: string;
  transcript?: string;
  mood: "upset" | "neutral";
  priority: "high" | "normal";
  status: "waiting" | "done";
  outcome?: string;
}

export type FeedbackAction = "mentioned" | "not_relevant" | "upset" | "has_it";

export interface AgentFeedback {
  id: string;
  at: string;
  customerId: string;
  offerId: string;
  product: string;
  action: FeedbackAction;
  deskItemId?: string;
  source: "agent" | "stream";
}

/** What arrived after the 30.09. snapshot and overrides it. */
export interface LiveFacts {
  withdrawn: string[];
  dunningLevel?: number;
  complaint?: string;
  callback?: boolean;
  cancellation?: string;
  failedToday: number;
  cart?: string;
  ordered?: string[];
  clicked?: string;
  dataThresholdPct?: number;
  heatPump?: string;
  /** Where Kompass first learnt about the heat pump move, e.g. "portal ticket at 11:31". */
  heatPumpSource?: string;
  heatPumpAt?: string;
  hemsOffline?: boolean;
  upsetUntil?: string;
  /** Said on a call or in a ticket that the price guarantee ends and they compare offers. */
  retention?: string;
  blockingMinutes?: number;
  dismissed: string[];
  hasIt: string[];
  lastActiveAt?: string;
  events: number;
}

export interface LiveFreshness {
  source: string;
  label: string;
  refresh: string;
  events: number;
  medianLagMin: number;
  maxLagMin: number;
  late: number;
}

export interface LiveCounts {
  applied: number;
  total: number;
  duplicates: number;
  late: number;
  outOfOrder: number;
  signals: number;
  decisions: number;
  created: number;
  cancelled: number;
}

export interface LiveState {
  day: string;
  start: string;
  end: string;
  clock: string;
  morningRun: boolean;
  counts: LiveCounts;
  freshness: LiveFreshness[];
  events: LiveEvent[];
  decisions: LiveDecision[];
  desk: DeskItem[];
  feedback: AgentFeedback[];
  /** The next event that will make Kompass decide, for “skip to the next decision”. */
  next: { at: string; label: string; customerId: string } | null;
}

/** One customer as Kompass sees them right now, with the live facts applied. */
export interface LiveCustomer {
  customerId: string;
  facts: LiveFacts | null;
  actions: LiveAction[];
  blocked: { product: string; reason: string }[];
  rules: LiveRule[];
  salesBlockers: string[];
  allowedChannels: string[];
  decisions: LiveDecision[];
  events: LiveEvent[];
  desk: DeskItem[];
  feedback: AgentFeedback[];
}
