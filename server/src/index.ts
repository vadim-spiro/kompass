// Kompass workspace server: the backend for the Kompass UI. Customer data, decisions and campaign
// plans come from the team's insights service (proxied under /api/insights); this server adds
// campaigns, the email builder, automations, settings and the assistant. Spec: api/openapi.yaml.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { Automation, Campaign, ChartSpec, ChatContext, CommandInput, CustomBlock, EmailDoc, HomeData, Proposal, SavedChart, Terms } from "../../shared/types.ts";
import type { UiResult } from "../../shared/uiActions.ts";
import { runTurn, newConversation, applyProposal, resolveUi } from "./agent.ts";
import { AnalyticsError, catalog, fieldValues, runChart } from "./analytics.ts";
import { writeLearnings } from "./ai.ts";
import { enforceSafety, nodeCatalog, runAutomations, summarizeFlow, TRIGGER_EVENTS } from "./automations.ts";
import { blockCatalog, loadRecipient, PLACEHOLDERS, renderEmail, SHOW_IF_FIELDS, toPlain } from "./blocks.ts";
import { cleanAudience, DRAFT_OF, importLegacyNewsletters, launchCampaign, newCampaign, pinnedOffers, planCampaign, reviewCampaign, variantStats } from "./campaigns.ts";
import { customer360, listCustomers } from "./customers.ts";
import { identityFor } from "./identity.ts";
import { audienceCards, bestTimes } from "./outreach.ts";
import { LlmError, llmConfig } from "./llm.ts";
import { checkFreeText } from "./copy.ts";
import { factsFor, liveBlockers, withdrawnChannels } from "./engine.ts";
import { advance, giveFeedback, liveCustomer, liveState, resetLive, updateDesk, warm } from "./live.ts";
import { log, type LogLevel } from "./log.ts";
import { connect, getVocabulary, ins, mapLimit, searchCustomers, UpstreamError, upstreamState } from "./upstream.ts";
import { newId, resetWorkspace, save, touch, ws } from "./workspace.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(here, "../../api/openapi.yaml");
const now = () => new Date().toISOString();

const api = new Hono();

api.onError((e, c) => {
  const where = `${c.req.method} ${c.req.path}`;
  if (e instanceof UpstreamError) {
    log.warn("http", `${where}: insights service ${e.status}`, { error: e.message, detail: e.detail });
    return c.json({ error: e.message, detail: e.detail }, e.status as 400);
  }
  if (e instanceof LlmError) {
    log.warn("http", `${where}: LLM unavailable`, e);
    return c.json({ error: e.message }, 503);
  }
  if (e instanceof AnalyticsError) {
    log.info("http", `${where}: ${e.message}`);
    return c.json({ error: e.message }, 400);
  }
  log.error("http", `${where} failed`, e);
  return c.json({ error: (e as Error).message }, 500);
});

// Failed and slow requests go to server/logs/kompass.log.
api.use(async (c, next) => {
  const t = Date.now();
  await next();
  const ms = Date.now() - t;
  const where = `${c.req.method} ${c.req.path}`;
  if (c.res.status >= 500) log.error("http", `${where} → ${c.res.status} in ${ms} ms`);
  else if (c.res.status >= 400 && c.req.path !== "/api/log") log.warn("http", `${where} → ${c.res.status} in ${ms} ms`);
  else if (ms > 4000 && !c.req.path.includes("/assistant")) log.warn("http", `${where} slow: ${ms} ms`);
});

const notFound = (c: Context, what: string) => c.json({ error: `${what} not found` }, 404);

// ---------- Status & insights pass-through ----------

api.get("/status", (c) =>
  c.json({
    insights: upstreamState,
    llm: { configured: llmConfig.configured, model: llmConfig.model },
    workspace: { campaigns: ws.campaigns.length, automations: ws.automations.length, pendingProposals: ws.proposals.filter((p) => p.status === "pending").length },
  }),
);
api.get("/openapi.yaml", (c) => c.body(readFileSync(SPEC_PATH, "utf8"), 200, { "Content-Type": "application/yaml" }));

// Read-only views of the insights service (performance tabs, overview, vocabulary).
api.get("/insights/*", async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/api\/insights/, "") + url.search;
  return c.json(await ins.get(path));
});
api.post("/insights/*", async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/api\/insights/, "") + url.search;
  return c.json(await ins.post(path, await c.req.json().catch(() => ({}))));
});
api.get("/vocabulary", async (c) => c.json(await getVocabulary()));

// ---------- Customers ----------

api.post("/customers/search", async (c) => c.json(await listCustomers(await c.req.json().catch(() => ({})))));
api.get("/customers/:id/360", async (c) => c.json(await customer360(c.req.param("id"))));

// ---------- Email builder ----------

api.get("/blocks", (c) => c.json({ blocks: blockCatalog(ws.settings), fields: SHOW_IF_FIELDS, placeholders: PLACEHOLDERS }));

api.post("/render", async (c) => {
  const b = await c.req.json<{ email: EmailDoc; customerId: string; channel?: string; campaignId?: string }>();
  const camp = b.campaignId ? ws.campaigns.find((x) => x.id === b.campaignId) : undefined;
  return c.json(await renderEmail(b.email, b.customerId, ws.settings, b.channel ?? "auto", { offerIds: pinnedOffers(camp) }));
});

/** One message for many recipients, each on their own channel: the builder's versions and checks in one request. */
api.post("/render/batch", async (c) => {
  const b = await c.req.json<{ email: EmailDoc; items: { customerId: string; channel?: string }[]; campaignId?: string }>();
  const camp = b.campaignId ? ws.campaigns.find((x) => x.id === b.campaignId) : undefined;
  const items = (b.items ?? []).slice(0, 80);
  let failed = 0;
  const out = await mapLimit(items, 6, (it) =>
    renderEmail(b.email, it.customerId, ws.settings, it.channel ?? "auto", { offerIds: pinnedOffers(camp) }).catch((e) => {
      failed++;
      log.warn("render", `batch: ${it.customerId} could not be rendered`, { error: (e as Error).message, channel: it.channel });
      return null;
    }),
  );
  log.debug("render", `batch of ${items.length}`, { failed, campaign: b.campaignId ?? null });
  return c.json(out);
});

/** Recipients to flip through in the preview: a campaign's contacts, or an audience sample. */
api.post("/recipients", async (c) => {
  const b = await c.req.json<{ campaignId?: string; audience?: Campaign["audience"]; limit?: number; channel?: string }>().catch(() => ({}) as Record<string, never>);
  const limit = Math.min(b.limit ?? 40, 200);
  const camp = b.campaignId ? ws.campaigns.find((x) => x.id === b.campaignId) : undefined;
  let ids: string[];
  // A channel's draft is previewed with the contacts the plan reaches on that channel.
  if (camp?.plan) ids = camp.plan.rows.filter((r) => r.status === "contact" && (!b.channel || DRAFT_OF[r.action?.channel ?? "email"] === b.channel)).map((r) => r.customer_id);
  else ids = (await searchCustomers({ audience: cleanAudience(camp?.audience ?? b.audience ?? {}), limit })).items.map((s) => s.customer_id);
  ids = ids.slice(0, limit);
  const out = await mapLimit(ids, 6, async (id) => {
    const r = await loadRecipient(id).catch(() => null);
    if (!r) return null;
    const s = r.profile.summary;
    return { customerId: id, name: r.identity.name, tone: r.tone, serviceCase: s.service_case, offer: s.best_action?.product_name ?? null, valueTier: s.value_tier };
  });
  return c.json(out.filter(Boolean));
});

/** Renders a batch of recipients and counts who sees which variant. */
api.post("/render/variants", async (c) => {
  const b = await c.req.json<{ email: EmailDoc; customerIds: string[]; channel?: string; campaignId?: string }>();
  const ids = b.customerIds.slice(0, 80);
  const offerIds = pinnedOffers(b.campaignId ? ws.campaigns.find((x) => x.id === b.campaignId) : undefined);
  const rendered = await mapLimit(ids, 6, (id) => renderEmail(b.email, id, ws.settings, b.channel ?? "auto", { offerIds }).catch(() => null));
  const counts = new Map<string, { variant: string; label: string; count: number }>();
  let failing = 0;
  const byCustomer: Record<string, string> = {};
  for (const r of rendered) {
    if (!r) continue;
    byCustomer[r.customerId] = r.variant;
    const k = counts.get(r.variant) ?? { variant: r.variant, label: r.variantLabel, count: 0 };
    k.count++;
    counts.set(r.variant, k);
    if (r.checks.some((x) => !x.passed)) failing++;
  }
  return c.json({ stats: [...counts.values()].sort((a, z) => z.count - a.count), sampled: rendered.filter(Boolean).length, failing, byCustomer });
});

// ---------- Templates ----------

api.get("/templates", (c) => c.json(ws.templates));
api.post("/templates", async (c) => {
  const b = await c.req.json<{ name: string; description?: string; email: EmailDoc }>();
  const t = { id: newId("TPL"), name: b.name || "Untitled template", description: b.description ?? "", email: b.email, updatedAt: now() };
  ws.templates.unshift(t);
  save();
  return c.json(t, 201);
});
api.put("/templates/:id", async (c) => {
  const t = ws.templates.find((x) => x.id === c.req.param("id"));
  if (!t) return notFound(c, "Template");
  const b = await c.req.json<{ name?: string; description?: string; email?: EmailDoc }>();
  Object.assign(t, { ...(b.name ? { name: b.name } : {}), ...(b.description != null ? { description: b.description } : {}), ...(b.email ? { email: b.email } : {}) });
  return c.json(touch(t));
});
api.delete("/templates/:id", (c) => {
  ws.templates = ws.templates.filter((x) => x.id !== c.req.param("id"));
  save();
  return c.body(null, 204);
});

// ---------- Campaigns ----------

/** List view: the plan without its per-customer rows. */
const lite = (c: Campaign) => ({ ...c, plan: c.plan ? { ...c.plan, rows: [] } : undefined });
const findCampaign = (id: string) => ws.campaigns.find((x) => x.id === id);

api.get("/campaigns", (c) => c.json(ws.campaigns.map(lite)));
api.post("/campaigns", async (c) => {
  const b = await c.req.json<Partial<Campaign> & { templateId?: string }>().catch(() => ({}) as Partial<Campaign> & { templateId?: string });
  const tpl = b.templateId ? ws.templates.find((t) => t.id === b.templateId) : undefined;
  const camp = newCampaign({ ...b, audience: cleanAudience(b.audience ?? {}), email: b.email ?? (tpl ? structuredClone(tpl.email) : undefined) });
  return c.json(camp, 201);
});
api.get("/campaigns/:id", (c) => {
  const camp = findCampaign(c.req.param("id"));
  if (!camp) return notFound(c, "Campaign");
  return c.json({ ...camp, plan: camp.plan ? { ...camp.plan, rows: camp.plan.rows.map((r) => ({ ...r, name: identityFor(r.customer_id).name })) } : undefined });
});
api.put("/campaigns/:id", async (c) => {
  const camp = findCampaign(c.req.param("id"));
  if (!camp) return notFound(c, "Campaign");
  if (camp.status === "running" || camp.status === "done") return c.json({ error: "A launched campaign cannot be edited. Duplicate it instead." }, 409);
  const b = await c.req.json<Partial<Campaign>>();
  const editable = ["name", "goal", "audience", "audienceLabel", "audienceSource", "offerMode", "offerIds", "actionTypes", "channels", "minDclvEur", "maxContacts", "controlShare", "email", "drafts", "timing", "reminder", "followUp"] as const;
  const replan = ["audience", "offerMode", "offerIds", "actionTypes", "channels", "minDclvEur", "maxContacts", "controlShare"];
  let changedPlan = false;
  for (const k of editable) {
    if (!(k in b)) continue;
    const v = k === "audience" ? cleanAudience(b.audience ?? {}) : b[k];
    if (replan.includes(k) && JSON.stringify(v) !== JSON.stringify(camp[k])) changedPlan = true;
    (camp as unknown as Record<string, unknown>)[k] = v;
  }
  if (changedPlan) camp.plan = undefined;
  // Any change after approval needs a fresh approval.
  if (camp.approvals.length && (changedPlan || "email" in b || "drafts" in b || "timing" in b)) {
    camp.approvals = [];
    camp.status = "draft";
  }
  return c.json(lite(touch(camp)));
});
api.delete("/campaigns/:id", (c) => {
  ws.campaigns = ws.campaigns.filter((x) => x.id !== c.req.param("id"));
  save();
  return c.body(null, 204);
});
api.post("/campaigns/:id/duplicate", (c) => {
  const camp = findCampaign(c.req.param("id"));
  if (!camp) return notFound(c, "Campaign");
  const copy = newCampaign({ ...structuredClone(camp), name: `${camp.name} (copy)` });
  return c.json(copy, 201);
});
api.post("/campaigns/:id/plan", async (c) => {
  const camp = findCampaign(c.req.param("id"));
  if (!camp) return notFound(c, "Campaign");
  const plan = await planCampaign(camp);
  return c.json({ ...plan, rows: plan.rows.map((r) => ({ ...r, name: identityFor(r.customer_id).name })) });
});
api.get("/campaigns/:id/variants", async (c) => {
  const camp = findCampaign(c.req.param("id"));
  if (!camp) return notFound(c, "Campaign");
  return c.json(await variantStats(camp, Number(c.req.query("sample") ?? 60)));
});
api.get("/campaigns/:id/best-times", async (c) => {
  const camp = findCampaign(c.req.param("id"));
  if (!camp) return notFound(c, "Campaign");
  const { byCustomer: _byCustomer, ...times } = await bestTimes(camp);
  return c.json(times);
});
api.get("/campaigns/:id/review", async (c) => {
  const camp = findCampaign(c.req.param("id"));
  if (!camp) return notFound(c, "Campaign");
  const slots = camp.timing?.mode === "best" ? (await bestTimes(camp)).slots : undefined;
  return c.json(await reviewCampaign(camp, slots));
});
api.get("/outreach/audiences", async (c) => c.json(await audienceCards()));
api.post("/campaigns/:id/submit", (c) => {
  const camp = findCampaign(c.req.param("id"));
  if (!camp) return notFound(c, "Campaign");
  if (camp.status === "draft") camp.status = "review";
  return c.json(lite(touch(camp)));
});
api.post("/campaigns/:id/approve", async (c) => {
  const camp = findCampaign(c.req.param("id"));
  if (!camp) return notFound(c, "Campaign");
  const b = await c.req.json<{ by: string; role: string }>().catch(() => ({ by: "You", role: "Marketing" }));
  if (!camp.plan) return c.json({ error: "Plan the audience before approving" }, 409);
  if (!camp.approvals.some((a) => a.by === b.by)) camp.approvals.push({ by: b.by, role: b.role, at: now() });
  if (camp.status === "draft") camp.status = "review";
  return c.json(lite(touch(camp)));
});
api.post("/campaigns/:id/launch", async (c) => {
  const camp = findCampaign(c.req.param("id"));
  if (!camp) return notFound(c, "Campaign");
  const needed = ws.settings.terms.requireSecondApprover ? 2 : 1;
  if (camp.approvals.length < needed) return c.json({ error: `Needs ${needed} approval${needed > 1 ? "s" : ""} before launch (has ${camp.approvals.length})` }, 409);
  if (camp.status === "running" || camp.status === "done") return c.json({ error: "Already launched" }, 409);
  const results = await launchCampaign(camp);
  return c.json({ campaign: lite(camp), results });
});
api.post("/campaigns/:id/finish", (c) => {
  const camp = findCampaign(c.req.param("id"));
  if (!camp) return notFound(c, "Campaign");
  if (camp.status === "running") camp.status = "done";
  return c.json(lite(touch(camp)));
});
api.post("/campaigns/:id/learnings", async (c) => {
  const camp = findCampaign(c.req.param("id"));
  if (!camp?.results) return notFound(c, "Campaign results");
  camp.results.learnings = await writeLearnings(camp.name, camp.results);
  touch(camp);
  return c.json({ learnings: camp.results.learnings });
});

// ---------- Automations ----------

const withSummary = (a: Automation) => ({ ...a, summary: summarizeFlow(a.flow, ws.settings) });
const findAutomation = (id: string) => ws.automations.find((x) => x.id === id);

api.get("/automations", (c) => c.json(ws.automations.map(withSummary)));
api.get("/automations/nodes", (c) => c.json({ nodes: nodeCatalog(ws.settings), triggers: TRIGGER_EVENTS, fields: SHOW_IF_FIELDS, templates: ws.templates.map((t) => ({ id: t.id, name: t.name })) }));
api.get("/automations/last-run", (c) => c.json(ws.lastRun ?? null));
api.post("/automations/run", async (c) => {
  const b: { reset?: boolean; automationId?: string } = await c.req.json().catch(() => ({}));
  return c.json(await runAutomations({ reset: b.reset ?? true, automationId: b.automationId }));
});
api.post("/automations", async (c) => {
  const b = await c.req.json<Partial<Automation>>().catch(() => ({}) as Partial<Automation>);
  const trigger = { id: newId("n"), kind: "trigger" as const, position: { x: 0, y: 0 }, config: { event: "order_placed", contains: "" }, locked: true };
  const a: Automation = {
    id: newId("AUT"),
    name: b.name ?? "New automation",
    description: b.description ?? "",
    enabled: false,
    flow: enforceSafety(b.flow ?? { nodes: [trigger], edges: [] }),
    createdAt: now(),
    updatedAt: now(),
    stats: { hits: 0, proposals: 0 },
  };
  ws.automations.unshift(a);
  save();
  return c.json(withSummary(a), 201);
});
api.get("/automations/:id", (c) => {
  const a = findAutomation(c.req.param("id"));
  return a ? c.json(withSummary(a)) : notFound(c, "Automation");
});
api.put("/automations/:id", async (c) => {
  const a = findAutomation(c.req.param("id"));
  if (!a) return notFound(c, "Automation");
  const b = await c.req.json<Partial<Automation>>();
  if (b.name != null) a.name = b.name;
  if (b.description != null) a.description = b.description;
  if (b.enabled != null) a.enabled = b.enabled;
  if (b.flow) a.flow = enforceSafety(b.flow);
  return c.json(withSummary(touch(a)));
});
api.delete("/automations/:id", (c) => {
  ws.automations = ws.automations.filter((x) => x.id !== c.req.param("id"));
  save();
  return c.body(null, 204);
});

// ---------- Approvals (proposals from automations) ----------

api.get("/proposals", (c) => {
  const status = c.req.query("status");
  return c.json(ws.proposals.filter((p) => !status || p.status === status));
});
/** A message or task for one customer, started from Customer 360. It waits for approval like any other. */
api.post("/proposals", async (c) => {
  const b = await c.req.json<{ customerId: string; kind: "message" | "task"; templateId?: string; channel?: string; team?: string; text?: string; subject?: string }>();
  const r = await loadRecipient(b.customerId);
  const base = {
    id: newId("PRP"),
    source: { kind: "manual" as const, id: "manual", name: "Started from Customer 360" },
    customerId: b.customerId,
    customerName: r.identity.name,
    trigger: "manual",
    eventAt: now(),
    tone: r.tone,
    status: "pending" as const,
    createdAt: now(),
  };
  if (b.kind === "task") {
    const p: Proposal = { ...base, kind: "task", channel: "internal", subject: `Aufgabe für ${b.team || "Kundenservice"}`, body: b.text ?? "", reason: "Created by a marketer" };
    ws.proposals.unshift(p);
    save();
    return c.json(p, 201);
  }
  // A 1:1 text written by Kompass (or a person): checked against consent and the copy guardrails.
  if (!b.templateId && b.text?.trim()) {
    const text = b.text.trim();
    const doc: EmailDoc = { subject: { sie: b.subject ?? "Nachricht von MAINGAU", du: b.subject ?? "Nachricht von MAINGAU" }, blocks: [{ id: newId("b"), type: "text", props: { sie: text, du: text } }] };
    const e = await renderEmail(doc, b.customerId, ws.settings, b.channel ?? "auto");
    if (!e.reachable) return c.json({ error: `No consent for ${e.channel.replace("_", " ")}` }, 409);
    const failed = checkFreeText(text, r.tone, { allowNumbers: true, avoidWords: ws.settings.voice.avoidWords }).filter((x) => !x.passed);
    if (failed.length) return c.json({ error: `Guardrails: ${failed.map((x) => `${x.check} (${x.detail})`).join("; ")}` }, 422);
    const p: Proposal = { ...base, kind: "message", channel: e.channel, subject: e.channel === "email" ? (b.subject ?? "Nachricht von MAINGAU") : "", body: text, reason: "Drafted by Kompass" };
    ws.proposals.unshift(p);
    save();
    return c.json(p, 201);
  }
  const tpl = ws.templates.find((t) => t.id === b.templateId);
  if (!tpl) return c.json({ error: "Choose an email" }, 400);
  const e = await renderEmail(tpl.email, b.customerId, ws.settings, b.channel ?? "auto");
  if (!e.reachable) return c.json({ error: `No consent for ${e.channel.replace("_", " ")}` }, 409);
  const p: Proposal = {
    ...base,
    kind: "message",
    channel: e.channel,
    subject: e.subject,
    body: toPlain(e, e.channel === "sms" ? 300 : e.channel === "portal_popup" ? 260 : undefined),
    offerId: e.variant.startsWith("offer:") ? e.variant.slice(6) : undefined,
    productName: e.variant.startsWith("offer:") ? e.variantLabel.replace("Offer: ", "") : undefined,
    reason: `${tpl.name}: ${e.variantLabel}`,
  };
  ws.proposals.unshift(p);
  save();
  return c.json(p, 201);
});

const APPROVER = "Marketing (you)";
const contacts = (p: Proposal) => p.kind === "message" || p.kind === "survey" || p.kind === "voucher";

/** What changed since the proposal was made: consent and exclusions are checked again at the moment of approval. */
function stillAllowed(p: Proposal): string | null {
  const f = factsFor(p.customerId);
  if (!f || !contacts(p)) return null;
  if (withdrawnChannels(f).has(p.channel)) return `Consent for ${p.channel.replace("_", " ")} was withdrawn after this was proposed`;
  const sales = !!p.offerId && p.offerId !== "P-SV-01";
  if (sales && f.withdrawn.includes("profiling_analytics")) return "Profiling consent was withdrawn: no personalised offers";
  const blockers = liveBlockers(f);
  if (sales && blockers.length) return `Sales are blocked now: ${blockers.join(", ")}`;
  return null;
}

function decide(id: string, approve: boolean) {
  const p = ws.proposals.find((x) => x.id === id);
  if (!p || p.status !== "pending") return null;
  if (approve) {
    const stop = stillAllowed(p);
    if (stop) {
      p.status = "cancelled";
      p.cancelReason = stop;
      log.info("approvals", `${p.id} for ${p.customerId} cancelled at approval: ${stop}`);
      return p;
    }
  }
  p.status = approve ? "approved" : "rejected";
  p.decidedBy = APPROVER;
  p.decidedAt = now();
  // An approved message counts against the contact limits (it is queued; the prototype sends nothing).
  if (approve && contacts(p)) ws.sends.push({ customerId: p.customerId, channel: p.channel, at: now(), campaignId: p.source.id });
  log.info("approvals", `${p.id} ${p.status} (${p.kind} via ${p.channel} for ${p.customerId})`);
  return p;
}
api.post("/proposals/:id/approve", (c) => {
  const p = decide(c.req.param("id"), true);
  save();
  if (p?.status === "cancelled") return c.json({ ...p, error: p.cancelReason }, 409);
  return p ? c.json(p) : notFound(c, "Pending proposal");
});
api.post("/proposals/:id/reject", (c) => {
  const p = decide(c.req.param("id"), false);
  save();
  return p ? c.json(p) : notFound(c, "Pending proposal");
});
api.post("/proposals/bulk", async (c) => {
  const b = await c.req.json<{ ids?: string[]; sourceId?: string; approve: boolean }>();
  const ids = b.ids ?? ws.proposals.filter((p) => p.status === "pending" && p.source.id === b.sourceId).map((p) => p.id);
  const done = ids.map((id) => decide(id, b.approve)).filter((p): p is Proposal => !!p);
  save();
  const cancelled = done.filter((p) => p.status === "cancelled");
  return c.json({ updated: done.length - cancelled.length, cancelled: cancelled.map((p) => ({ id: p.id, reason: p.cancelReason })) });
});
// A person fixes the text before approving; the checks run again on what they wrote.
api.patch("/proposals/:id", async (c) => {
  const p = ws.proposals.find((x) => x.id === c.req.param("id"));
  if (!p || p.status !== "pending") return notFound(c, "Pending proposal");
  const b = await c.req.json<{ subject?: string; body?: string; tone?: Proposal["tone"] }>();
  if (b.subject != null) p.subject = b.subject.slice(0, 200);
  if (b.body != null) p.body = b.body.slice(0, 4000);
  if (b.tone === "du" || b.tone === "sie") p.tone = b.tone;
  const serviceOnly = !p.offerId || p.offerId === "P-SV-01";
  p.checks = checkFreeText(`${p.subject ?? ""}\n${p.body ?? ""}`, p.tone, { serviceOnly, allowNumbers: true, avoidWords: ws.settings.voice.avoidWords });
  if (p.channel === "sms") p.checks.push({ check: "SMS fits in 2 segments (306 characters)", passed: (p.body ?? "").length <= 306, detail: `${(p.body ?? "").length} characters` });
  p.editedAt = now();
  save();
  log.info("approvals", `${p.id} edited`, { failed: p.checks.filter((x) => !x.passed).map((x) => x.check) });
  return c.json(p);
});

// ---------- Live: the 01.10. event stream on a clock ----------

api.get("/live", (c) => c.json(liveState()));
api.post("/live/advance", async (c) => {
  const b = await c.req.json<{ to?: string; minutes?: number }>().catch(() => ({}) as { to?: string; minutes?: number });
  const st = liveState();
  let to = b.to;
  if (!to && b.minutes) {
    const d = new Date(new Date(st.clock.replace(" ", "T") + "Z").getTime() + b.minutes * 60000).toISOString();
    to = `${d.slice(0, 10)} ${d.slice(11, 19)}`;
  }
  if (!to) return c.json({ error: "Say where to move the clock (to or minutes)" }, 400);
  return c.json(await advance(to));
});
api.post("/live/reset", async (c) => c.json(await resetLive()));
api.get("/live/customers/:id", async (c) => c.json(await liveCustomer(c.req.param("id"))));
api.post("/live/feedback", async (c) => {
  const b = await c.req.json<Parameters<typeof giveFeedback>[0]>();
  if (!b.customerId || !b.action) return c.json({ error: "Feedback needs a customer and an action" }, 400);
  return c.json(giveFeedback(b), 201);
});
api.post("/live/desk/:id", async (c) => {
  const item = await updateDesk(c.req.param("id"), await c.req.json());
  return item ? c.json(item) : notFound(c, "Desk item");
});

// ---------- Debug log ----------

api.get("/logs", (c) => {
  const q = c.req.query();
  return c.json(log.recent({ level: q.level as LogLevel | undefined, scope: q.scope, limit: q.limit ? Number(q.limit) : undefined }));
});
// The browser reports its errors here (window errors, failed API calls).
api.post("/log", async (c) => {
  const b = await c.req.json<{ level?: LogLevel; scope?: string; msg?: string; data?: unknown }>().catch(() => null);
  if (!b?.msg) return c.json({ ok: false }, 400);
  const level: LogLevel = b.level === "error" || b.level === "warn" || b.level === "info" ? b.level : "debug";
  log[level](`web:${(b.scope ?? "app").slice(0, 40)}`, b.msg.slice(0, 1000), b.data);
  return c.json({ ok: true });
});

// ---------- Settings ----------

api.get("/settings", (c) => c.json(ws.settings));
api.put("/settings/terms", async (c) => {
  const b = await c.req.json<Partial<Terms>>();
  const t = ws.settings.terms;
  if (b.contactLimit30d != null) t.contactLimit30d = Math.max(0, Math.round(b.contactLimit30d));
  if (b.quietDaysAfterComplaint != null) t.quietDaysAfterComplaint = Math.max(0, Math.round(b.quietDaysAfterComplaint));
  if (b.holdoutShare != null) t.holdoutShare = Math.max(0.05, Math.min(0.5, b.holdoutShare));
  if (b.minDclvEur != null) t.minDclvEur = b.minDclvEur;
  if (b.requireSecondApprover != null) t.requireSecondApprover = b.requireSecondApprover;
  if (b.channelLimits30d) Object.assign(t.channelLimits30d, b.channelLimits30d);
  if (b.channelsEnabled) Object.assign(t.channelsEnabled, b.channelsEnabled);
  save();
  return c.json(t);
});
api.post("/settings/commands", async (c) => {
  const b = await c.req.json<CommandInput>();
  if (!b.name?.trim()) return c.json({ error: "A command needs a name" }, 400);
  const cmd = { id: newId("CMD"), name: b.name.trim(), kind: b.kind ?? "task", channel: b.channel ?? null, description: b.description ?? "", costEur: Number(b.costEur ?? 0), needsApproval: b.needsApproval ?? true, template: b.template, builtIn: false };
  ws.settings.commands.push(cmd);
  save();
  return c.json(cmd, 201);
});
api.put("/settings/commands/:id", async (c) => {
  const cmd = ws.settings.commands.find((x) => x.id === c.req.param("id"));
  if (!cmd) return notFound(c, "Command");
  const b = await c.req.json<CommandInput>();
  Object.assign(cmd, { ...b, id: cmd.id, builtIn: cmd.builtIn });
  save();
  return c.json(cmd);
});
api.delete("/settings/commands/:id", (c) => {
  const cmd = ws.settings.commands.find((x) => x.id === c.req.param("id"));
  if (cmd?.builtIn) return c.json({ error: "Built-in commands cannot be deleted" }, 409);
  ws.settings.commands = ws.settings.commands.filter((x) => x.id !== c.req.param("id"));
  save();
  return c.body(null, 204);
});
api.post("/settings/blocks", async (c) => {
  const b = await c.req.json<Omit<CustomBlock, "id">>();
  if (!b.name?.trim()) return c.json({ error: "A block needs a name" }, 400);
  const blk: CustomBlock = { id: newId("blk"), name: b.name.trim(), description: b.description ?? "", sie: b.sie ?? "", du: b.du ?? "", showIf: b.showIf ?? [] };
  ws.settings.customBlocks.push(blk);
  save();
  return c.json(blk, 201);
});
api.put("/settings/blocks/:id", async (c) => {
  const blk = ws.settings.customBlocks.find((x) => x.id === c.req.param("id"));
  if (!blk) return notFound(c, "Block");
  Object.assign(blk, { ...(await c.req.json<Partial<CustomBlock>>()), id: blk.id });
  save();
  return c.json(blk);
});
api.delete("/settings/blocks/:id", (c) => {
  ws.settings.customBlocks = ws.settings.customBlocks.filter((x) => x.id !== c.req.param("id"));
  save();
  return c.body(null, 204);
});
api.put("/settings/voice", async (c) => {
  Object.assign(ws.settings.voice, await c.req.json());
  save();
  return c.json(ws.settings.voice);
});
api.post("/workspace/reset", async (c) => {
  resetWorkspace();
  log.info("workspace", "reset");
  await importLegacyNewsletters().catch(() => undefined);
  return c.json({ ok: true });
});

// ---------- Analytics ----------

api.get("/analytics/catalog", (c) => c.json(catalog()));
api.post("/analytics/run", async (c) => c.json(await runChart(await c.req.json<ChartSpec>())));
api.post("/analytics/values", async (c) => {
  const b = await c.req.json<{ source: string; field: string }>();
  return c.json(await fieldValues(b.source, b.field));
});
api.get("/analytics/charts", (c) => c.json(ws.charts));
api.get("/analytics/charts/:id", (c) => {
  const ch = ws.charts.find((x) => x.id === c.req.param("id"));
  return ch ? c.json(ch) : c.json({ error: "Chart not found" }, 404);
});
api.post("/analytics/charts", async (c) => {
  const b = await c.req.json<{ title: string; spec: ChartSpec; origin?: SavedChart["origin"] }>();
  if (!b.spec?.source) return c.json({ error: "A chart needs a data source" }, 400);
  const at = new Date().toISOString();
  const ch: SavedChart = { id: newId("CH"), title: b.title?.trim() || "Untitled chart", spec: b.spec, origin: b.origin ?? "user", createdAt: at, updatedAt: at };
  ws.charts.unshift(ch);
  save();
  return c.json(ch, 201);
});
api.patch("/analytics/charts/:id", async (c) => {
  const ch = ws.charts.find((x) => x.id === c.req.param("id"));
  if (!ch) return c.json({ error: "Chart not found" }, 404);
  const b = await c.req.json<Partial<Pick<SavedChart, "title" | "spec">>>();
  if (b.title !== undefined) ch.title = b.title;
  if (b.spec) ch.spec = b.spec;
  return c.json(touch(ch));
});
api.delete("/analytics/charts/:id", (c) => {
  ws.charts = ws.charts.filter((x) => x.id !== c.req.param("id"));
  save();
  return c.body(null, 204);
});

// ---------- Assistant ----------

api.get("/assistant/conversations", (c) =>
  c.json(ws.conversations.map((x) => ({ id: x.id, title: x.title, createdAt: x.createdAt, updatedAt: x.updatedAt, messages: x.messages.length }))),
);
api.post("/assistant/conversations", (c) => c.json(newConversation(), 201));
api.get("/assistant/conversations/:id", (c) => {
  const conv = ws.conversations.find((x) => x.id === c.req.param("id"));
  return conv ? c.json(conv) : notFound(c, "Conversation");
});
api.delete("/assistant/conversations/:id", (c) => {
  ws.conversations = ws.conversations.filter((x) => x.id !== c.req.param("id"));
  save();
  return c.body(null, 204);
});
api.post("/assistant/conversations/:id/messages", async (c) => {
  const conv = ws.conversations.find((x) => x.id === c.req.param("id"));
  if (!conv) return notFound(c, "Conversation");
  const b = await c.req.json<{ text: string; context?: ChatContext }>();
  if (!b.text?.trim()) return c.json({ error: "Empty message" }, 400);
  return streamSSE(c, async (stream) => {
    // Keep-alive comments let the client tell a slow model from a dead server.
    const ping = setInterval(() => void stream.write(": ping\n\n").catch(() => undefined), 10_000);
    // Stop button / closed tab: stop the turn instead of finishing it for nobody.
    const ctrl = new AbortController();
    stream.onAbort(() => ctrl.abort());
    try {
      await runTurn(conv, b.text.trim(), b.context ?? {}, (e) => stream.writeSSE({ event: e.type, data: JSON.stringify(e) }), ctrl.signal);
    } finally {
      clearInterval(ping);
    }
  });
});
api.post("/assistant/ui-result/:callId", async (c) => {
  const r = await c.req.json<UiResult>();
  return resolveUi(c.req.param("callId"), { ok: !!r.ok, message: String(r.message ?? "").slice(0, 500), screen: r.screen }) ? c.json({ ok: true }) : c.json({ error: "No action is waiting for this result" }, 404);
});
api.post("/assistant/conversations/:id/proposals/:callId/:action{apply|discard}", async (c) => {
  const conv = ws.conversations.find((x) => x.id === c.req.param("id"));
  const call = conv?.messages.flatMap((m) => m.toolCalls ?? []).find((t) => t.id === c.req.param("callId"));
  const p = call?.proposal;
  if (!p) return notFound(c, "Proposal");
  if (p.status !== "pending") return c.json({ error: `Already ${p.status}` }, 409);
  if (c.req.param("action") === "apply") {
    p.appliedRef = await applyProposal(p);
    p.status = "applied";
  } else p.status = "discarded";
  save();
  return c.json(p);
});

// ---------- Home ----------

api.get("/home", async (c) => {
  const [ov, pains, vocab] = await Promise.all([
    ins.get<{ customers: number; value_at_risk_eur: number; service_case_customers: number; customers_with_action: number; nba_opportunity_eur: number; customer_savings_eur: number }>("/overview"),
    ins.get<{ pain: string; customers: number; value_at_risk_eur: number }[]>("/pains"),
    getVocabulary().catch(() => null),
  ]);
  const label = (k: string) => vocab?.pains.find((p) => p.key === k)?.description ?? k;
  const data: HomeData = {
    pendingProposals: ws.proposals.filter((p) => p.status === "pending").length,
    campaignsInReview: ws.campaigns.filter((x) => x.status === "review").map(lite) as Campaign[],
    running: ws.campaigns.filter((x) => x.status === "running").map(lite) as Campaign[],
    // From the live stream when it runs (newest first), else from the last "run all at once".
    recentHits: ws.live?.decisions.length
      ? ws.live.decisions
          .flatMap((d) => d.rules.filter((r) => r.rule.startsWith("Flow: ")).map((r) => ({ automationId: "", automationName: r.rule.slice(6), customerId: d.customerId, customerName: d.customerName, event: d.eventType, at: d.at, outcome: r.effect })))
          .slice(0, 12)
      : (ws.lastRun?.hits.filter((h) => !h.outcome.startsWith("error")).slice(-12).reverse() ?? []),
    kpis: {
      customers: ov.customers,
      valueAtRiskEur: ov.value_at_risk_eur,
      serviceCases: ov.service_case_customers,
      customersWithAction: ov.customers_with_action,
      opportunityEur: ov.nba_opportunity_eur,
      savingsEur: ov.customer_savings_eur,
    },
    topPains: [...pains].sort((a, b) => b.value_at_risk_eur - a.value_at_risk_eur).slice(0, 5).map((p) => ({ key: p.pain, label: label(p.pain), customers: p.customers, valueAtRiskEur: p.value_at_risk_eur })),
  };
  return c.json(data);
});

// ---------- Server ----------

const app = new Hono();
app.use("/api/*", cors());
app.route("/api", api);
// The desktop build serves the web app from the same port (SERVE_WEB = path to web/dist).
const webDir = process.env.SERVE_WEB;
if (webDir && existsSync(join(webDir, "index.html"))) {
  const index = readFileSync(join(webDir, "index.html"), "utf8");
  app.use("/*", serveStatic({ root: relative(process.cwd(), webDir) }));
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(index)));
} else app.get("/", (c) => c.redirect("/api/status"));

const port = Number(process.env.ENGINE_PORT ?? 8787);
const url = await connect();
console.log(url ? `[kompass] insights service: ${url}` : `[kompass] ${upstreamState.error}`);
console.log(`[kompass] LLM ${llmConfig.configured ? `configured (${llmConfig.model})` : "not configured"}`);
if (url) await importLegacyNewsletters().catch((e) => console.warn(`[kompass] newsletters not imported: ${(e as Error).message}`));
serve({ fetch: app.fetch, port }, () => {
  console.log(`[kompass] workspace server on http://localhost:${port}/api`);
  log.info("server", `started on ${port}`, { insights: !!url, llm: llmConfig.configured });
  if (url) void warm();
});
