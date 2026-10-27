// Typed client for the Kompass workspace server (/api, proxied by Vite to :8787).
import type {
  AgentFeedback,
  DeskItem,
  FeedbackAction,
  LiveCustomer,
  LiveDecision,
  LiveEvent,
  LiveState,
  ChartResult,
  ChartSpec,
  FieldValue,
  SavedChart,
  SourceDef,
  AudienceCard,
  BestTimes,
  CampaignReview,
  Audience,
  Automation,
  BlockDef,
  BrandVoice,
  Campaign,
  CampaignPlan,
  CampaignResults,
  ChatContext,
  ChatEvent,
  ChatProposal,
  Command,
  CommandInput,
  Conversation,
  Customer360,
  CustomBlock,
  CustomerRow,
  EmailDoc,
  HomeData,
  NodeDef,
  Page,
  PlanRow,
  Proposal,
  RenderedEmail,
  RunReport,
  Settings,
  Terms,
  VariantStat,
  Vocabulary,
} from "../../../shared/types";
import type { UiResult } from "../../../shared/uiActions";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** "/api" in dev; "/kompass/api" when the build is served under a sub-path (vite `base`, see deploy/README.md). */
const API = `${import.meta.env.BASE_URL}api`;

/** Sends a browser-side problem to the server log (server/logs/kompass.log, scope "web:…"). Never throws. */
export function reportIssue(level: "error" | "warn" | "info", scope: string, msg: string, data?: unknown) {
  try {
    void fetch(`${API}/log`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level, scope, msg, data }), keepalive: true }).catch(() => undefined);
  } catch {
    /* logging must never break the page */
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    reportIssue("warn", "api", `${method} ${path}: network error`, { error: String(e) });
    throw new ApiError("Workspace server unreachable: is npm run dev running?", 0);
  }
  if (res.status >= 500) reportIssue("error", "api", `${method} ${path} → ${res.status}`, { page: location.pathname });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(res.ok ? "Invalid response" : `Server error ${res.status}`, res.status);
  }
  if (!res.ok) throw new ApiError((json as { error?: string })?.error ?? `Request failed (${res.status})`, res.status);
  return json as T;
}

const get = <T>(p: string) => req<T>("GET", p);
const post = <T>(p: string, b: unknown = {}) => req<T>("POST", p, b);
const put = <T>(p: string, b: unknown) => req<T>("PUT", p, b);
const del = (p: string) => req<void>("DELETE", p);
const patch = <T>(p: string, b: unknown) => req<T>("PATCH", p, b);

export interface Status {
  insights: { base: string; ok: boolean; error: string };
  llm: { configured: boolean; model: string };
  workspace: { campaigns: number; automations: number; pendingProposals: number };
}
export interface Template {
  id: string;
  name: string;
  description: string;
  email: EmailDoc;
  updatedAt: string;
}
export interface Recipient {
  customerId: string;
  name: string;
  tone: "du" | "sie";
  serviceCase: boolean;
  offer: string | null;
  valueTier: string;
}
export type NamedPlanRow = PlanRow & { name: string };
export type CampaignFull = Omit<Campaign, "plan"> & { plan?: Omit<CampaignPlan, "rows"> & { rows: NamedPlanRow[] } };
export type AutomationView = Automation & { summary: string };
export interface ShowIfField {
  field: string;
  label: string;
  kind: "bool" | "number" | "text" | "list";
}
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: number;
}

export const api = {
  status: () => get<Status>("/status"),
  home: () => get<HomeData>("/home"),
  vocabulary: () => get<Vocabulary>("/vocabulary"),
  insights: <T>(path: string) => get<T>(`/insights${path}`),

  customers: (body: { audience?: Audience; q?: string; sort?: string; desc?: boolean; limit?: number; offset?: number }) => post<Page<CustomerRow>>("/customers/search", body),
  customer360: (id: string) => get<Customer360>(`/customers/${id}/360`),

  blocks: () => get<{ blocks: BlockDef[]; fields: ShowIfField[]; placeholders: string[] }>("/blocks"),
  /** With a campaign, its chosen offers ("a specific offer") fill the offer blocks. */
  render: (email: EmailDoc, customerId: string, channel?: string, campaignId?: string) => post<RenderedEmail>("/render", { email, customerId, channel, campaignId }),
  /** The same message for many recipients in one request; a recipient that fails comes back as null. */
  renderBatch: (email: EmailDoc, items: { customerId: string; channel?: string }[], campaignId?: string) =>
    post<(RenderedEmail | null)[]>("/render/batch", { email, items, campaignId }),
  recipients: (body: { campaignId?: string; audience?: Audience; limit?: number; channel?: string }) => post<Recipient[]>("/recipients", body),
  variants: (email: EmailDoc, customerIds: string[], channel?: string, campaignId?: string) =>
    post<{ stats: VariantStat[]; sampled: number; failing: number; byCustomer: Record<string, string> }>("/render/variants", { email, customerIds, channel, campaignId }),

  templates: () => get<Template[]>("/templates"),
  createTemplate: (body: { name: string; description?: string; email: EmailDoc }) => post<Template>("/templates", body),
  updateTemplate: (id: string, body: Partial<Template>) => put<Template>(`/templates/${id}`, body),
  deleteTemplate: (id: string) => del(`/templates/${id}`),

  campaigns: () => get<Campaign[]>("/campaigns"),
  campaign: (id: string) => get<CampaignFull>(`/campaigns/${id}`),
  createCampaign: (body: Partial<Campaign> & { templateId?: string }) => post<Campaign>("/campaigns", body),
  updateCampaign: (id: string, body: Partial<Campaign>) => put<Campaign>(`/campaigns/${id}`, body),
  deleteCampaign: (id: string) => del(`/campaigns/${id}`),
  duplicateCampaign: (id: string) => post<Campaign>(`/campaigns/${id}/duplicate`),
  planCampaign: (id: string) => post<Omit<CampaignPlan, "rows"> & { rows: NamedPlanRow[] }>(`/campaigns/${id}/plan`),
  campaignReview: (id: string) => get<CampaignReview>(`/campaigns/${id}/review`),
  bestTimes: (id: string) => get<BestTimes>(`/campaigns/${id}/best-times`),
  outreachAudiences: () => get<AudienceCard[]>("/outreach/audiences"),
  campaignVariants: (id: string) => get<{ stats: VariantStat[]; sampled: number; total: number }>(`/campaigns/${id}/variants`),
  submitCampaign: (id: string) => post<Campaign>(`/campaigns/${id}/submit`),
  approveCampaign: (id: string, by: string, role: string) => post<Campaign>(`/campaigns/${id}/approve`, { by, role }),
  launchCampaign: (id: string) => post<{ campaign: Campaign; results: CampaignResults }>(`/campaigns/${id}/launch`),
  finishCampaign: (id: string) => post<Campaign>(`/campaigns/${id}/finish`),
  learnings: (id: string) => post<{ learnings: string }>(`/campaigns/${id}/learnings`),

  automations: () => get<AutomationView[]>("/automations"),
  automation: (id: string) => get<AutomationView>(`/automations/${id}`),
  createAutomation: (body: Partial<Automation>) => post<AutomationView>("/automations", body),
  updateAutomation: (id: string, body: Partial<Automation>) => put<AutomationView>(`/automations/${id}`, body),
  deleteAutomation: (id: string) => del(`/automations/${id}`),
  nodeCatalog: () => get<{ nodes: NodeDef[]; triggers: { key: string; label: string; hint?: string }[]; fields: ShowIfField[]; templates: { id: string; name: string }[] }>("/automations/nodes"),
  runAutomations: (automationId?: string) => post<RunReport>("/automations/run", { reset: true, automationId }),
  lastRun: () => get<RunReport | null>("/automations/last-run"),

  proposals: (status?: string) => get<Proposal[]>(`/proposals${status ? `?status=${status}` : ""}`),
  createProposal: (body: { customerId: string; kind: "message" | "task"; templateId?: string; channel?: string; team?: string; text?: string; subject?: string }) => post<Proposal>("/proposals", body),
  approveProposal: (id: string) => post<Proposal>(`/proposals/${id}/approve`),
  rejectProposal: (id: string) => post<Proposal>(`/proposals/${id}/reject`),
  bulkProposals: (body: { ids?: string[]; sourceId?: string; approve: boolean }) => post<{ updated: number; cancelled: { id: string; reason: string }[] }>("/proposals/bulk", body),
  editProposal: (id: string, body: { subject?: string; body?: string; tone?: "du" | "sie" }) => patch<Proposal>(`/proposals/${id}`, body),

  live: () => get<LiveState>("/live"),
  liveAdvance: (body: { to?: string; minutes?: number }) => post<{ clock: string; events: LiveEvent[]; decisions: LiveDecision[]; desk: DeskItem[]; counts: LiveState["counts"]; morningRun: boolean; next: LiveState["next"] }>("/live/advance", body),
  liveReset: () => post<LiveState>("/live/reset"),
  liveCustomer: (id: string) => get<LiveCustomer>(`/live/customers/${id}`),
  liveFeedback: (body: { customerId: string; offerId: string; product: string; action: FeedbackAction; deskItemId?: string }) => post<AgentFeedback>("/live/feedback", body),
  updateDesk: (id: string, body: { status?: DeskItem["status"]; outcome?: string }) => post<DeskItem>(`/live/desk/${id}`, body),

  settings: () => get<Settings>("/settings"),
  updateTerms: (t: Partial<Terms>) => put<Terms>("/settings/terms", t),
  addCommand: (c: CommandInput) => post<Command>("/settings/commands", c),
  updateCommand: (id: string, c: CommandInput) => put<Command>(`/settings/commands/${id}`, c),
  deleteCommand: (id: string) => del(`/settings/commands/${id}`),
  addBlock: (b: Omit<CustomBlock, "id">) => post<CustomBlock>("/settings/blocks", b),
  updateBlock: (id: string, b: Partial<CustomBlock>) => put<CustomBlock>(`/settings/blocks/${id}`, b),
  deleteBlock: (id: string) => del(`/settings/blocks/${id}`),
  updateVoice: (v: Partial<BrandVoice>) => put<BrandVoice>("/settings/voice", v),
  resetWorkspace: () => post<{ ok: boolean }>("/workspace/reset"),

  conversations: () => get<ConversationMeta[]>("/assistant/conversations"),
  conversation: (id: string) => get<Conversation>(`/assistant/conversations/${id}`),
  createConversation: () => post<Conversation>("/assistant/conversations"),
  deleteConversation: (id: string) => del(`/assistant/conversations/${id}`),
  proposalAction: (convId: string, callId: string, action: "apply" | "discard") => post<ChatProposal>(`/assistant/conversations/${convId}/proposals/${callId}/${action}`),
  uiResult: (callId: string, result: UiResult) => post<{ ok: boolean }>(`/assistant/ui-result/${callId}`, result),
  analyticsCatalog: () => get<SourceDef[]>("/analytics/catalog"),
  runChart: (spec: ChartSpec) => post<ChartResult>("/analytics/run", spec),
  fieldValues: (source: string, field: string) => post<FieldValue[]>("/analytics/values", { source, field }),
  charts: () => get<SavedChart[]>("/analytics/charts"),
  chart: (id: string) => get<SavedChart>(`/analytics/charts/${id}`),
  createChart: (body: { title: string; spec: ChartSpec; origin?: SavedChart["origin"] }) => post<SavedChart>("/analytics/charts", body),
  updateChart: (id: string, body: Partial<Pick<SavedChart, "title" | "spec">>) => patch<SavedChart>(`/analytics/charts/${id}`, body),
  deleteChart: (id: string) => del(`/analytics/charts/${id}`),
};

/** ?demo=1 marks this tab as a recorded demo: the assistant plays its fixed scripts (server/src/demo.ts). */
const DEMO = (() => {
  try {
    if (new URLSearchParams(location.search).get("demo") === "1") sessionStorage.setItem("kompass.demo", "1");
    return sessionStorage.getItem("kompass.demo") === "1";
  } catch {
    return false;
  }
})();

/** Sends one assistant message and streams its events (server-sent events over a POST). */
export async function sendChat(convId: string, text: string, context: ChatContext, onEvent: (e: ChatEvent) => void, signal?: AbortSignal) {
  const res = await fetch(`${API}/assistant/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, context: DEMO ? { ...context, demo: true } : context }),
    signal,
  });
  if (!res.ok || !res.body) throw new ApiError(`Assistant unavailable (${res.status})`, res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // The server pings every 10 s; silence for 40 s means it went away mid-answer.
  let last = Date.now();
  let lost = false;
  const watchdog = setInterval(() => {
    if (Date.now() - last > 40_000) {
      lost = true;
      void reader.cancel();
    }
  }, 5_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      last = Date.now();
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (data) onEvent(JSON.parse(data) as ChatEvent);
      }
    }
  } finally {
    clearInterval(watchdog);
  }
  if (lost) throw new ApiError("Lost the connection to the workspace server. Your message is saved; ask again.", 0);
}
