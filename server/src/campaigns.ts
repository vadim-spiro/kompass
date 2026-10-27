// Campaigns: audience → plan (insights service gates + Kompass terms) → email → approval →
// launch (simulated delivery) → results against the control group.
import type { Audience, Campaign, CampaignPlan, CampaignResults, CampaignReview, EmailDoc, MessageChannel, PlanRow, PlanSummary, RenderedEmail, VariantStat } from "../../shared/types.ts";
import { dateDe, loadRecipient, renderEmail, SNAPSHOT, toPlain } from "./blocks.ts";
import { log, timed } from "./log.ts";
import { aggregate, ins, mapLimit, queryRows } from "./upstream.ts";
import { defaultDrafts, defaultEmail, newId, save, ws } from "./workspace.ts";

const now = () => new Date().toISOString();

// ---------- Wording ----------

/** One name per channel, the same list as the app (web/src/components/outreach/copy.ts). */
const CHANNEL_NAME: Record<string, string> = { email: "Email", newsletter: "Newsletter", portal_popup: "Portal pop-up", sms: "SMS", outbound_call: "Call", service_contact: "Call", call: "Call" };
const channelName = (k: string) => CHANNEL_NAME[k] ?? k.replace(/_/g, " ");
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("de-DE")} ${n === 1 ? one : many}`;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Why a customer is left out, in words. The insights service sends short keys ("dCLV below 0 €"). */
const SKIP_TEXT: Record<string, string> = {
  "no profiling consent": "No profiling consent",
  "no consented channel": "No channel they consented to",
  "service case": "Open problem: service comes first, no sales",
  "no positive value": "No positive expected CLV gain",
  "offer disabled": "Offer switched off",
};
function plainSkip(reason: string | null | undefined, c: Campaign): string {
  const one = (r: string) => {
    const k = r.trim().toLowerCase();
    const below = /^dclv below (-?[\d.]+) ?€$/.exec(k);
    if (below) return `Expected CLV gain below ${Number(below[1])} €`;
    if (k === "not eligible") return c.offerMode === "pinned" ? "Not eligible for the chosen offer" : c.offerMode === "service" ? "No open problem to solve" : "No offer fits";
    if (k === "over max_contacts") return `Over this campaign's limit of ${c.maxContacts.toLocaleString("de-DE")} contacts`;
    return SKIP_TEXT[k] ?? (r.charAt(0).toUpperCase() + r.slice(1)).replace(/_/g, " ");
  };
  const parts = (reason ?? "").split(/;\s*/).filter(Boolean).map(one);
  return parts.length ? parts.map((p, i) => (i ? lowerFirst(p) : p)).join(" and ") : "No offer fits";
}
/** What Kompass's own terms leave out (the engine's gates come first). */
const WHY = {
  noChannel: "No channel they consented to",
  notSelected: (ch: string) => `${channelName(ch)} not selected for this campaign`,
  switchedOff: (ch: string) => `${channelName(ch)} switched off in Settings`,
  quiet: (days: number) => `Complaint in the last ${plural(days, "day")}`,
  contactLimit: (n: number) => `Contact limit reached (${n} per 30 days)`,
  channelLimit: (ch: string, n: number) => `${channelName(ch)} limit reached (${n} per 30 days)`,
};
/** Which kind of exclusion a reason is, for the review's "left out" details. */
const skipKind = (reason: string) => (/^over this campaign/i.test(reason) ? "other" : /not selected|switched off|consent/i.test(reason) ? "channel" : /limit reached|complaint/i.test(reason) ? "limit" : "other");

/** A name nobody uses yet: "Price watchers", then "Price watchers (2)", "(3)". */
export function uniqueCampaignName(wanted: string, taken = ws.campaigns.map((x) => x.name)) {
  const want = wanted.trim() || "New campaign";
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (!used.has(want.toLowerCase())) return want;
  const base = want.replace(/ \(\d+\)$/, "");
  for (let n = 2; ; n++) if (!used.has(`${base} (${n})`.toLowerCase())) return `${base} (${n})`;
}

export function newCampaign(input: Partial<Campaign> = {}): Campaign {
  const t = ws.settings.terms;
  const c: Campaign = {
    id: newId("CMP"),
    name: uniqueCampaignName(input.name ?? "New campaign"),
    goal: input.goal ?? "",
    status: "draft",
    source: "kompass",
    createdAt: now(),
    updatedAt: now(),
    audience: input.audience ?? {},
    audienceLabel: input.audienceLabel ?? "",
    offerMode: input.offerMode ?? "engine",
    offerIds: input.offerIds ?? [],
    actionTypes: input.actionTypes ?? [],
    channels: input.channels ?? ["email", "newsletter", "portal_popup", "sms"],
    minDclvEur: input.minDclvEur ?? t.minDclvEur,
    maxContacts: input.maxContacts ?? 500,
    controlShare: input.controlShare ?? t.holdoutShare,
    email: input.email ?? defaultEmail(),
    timing: input.timing ?? { mode: "asap" },
    drafts: input.drafts ?? defaultDrafts(),
    ...(input.audienceSource ? { audienceSource: input.audienceSource } : {}),
    followUp: input.followUp ?? null,
    approvals: [],
  };
  ws.campaigns.unshift(c);
  save();
  log.info("campaigns", `created ${c.id} "${c.name}"`, input.name && input.name !== c.name ? { askedFor: input.name } : undefined);
  return c;
}

/** Drops keys the insights service would reject (empty lists, empty strings). */
export function cleanAudience(a: Audience): Audience {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a ?? {})) {
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as Audience;
}

interface UpstreamPlan {
  summary: PlanSummary;
  rows: PlanRow[];
}

/** Customers contacted by Kompass in the last 30 days, per channel, for the contact-limit term. */
function recentContacts() {
  const since = Date.now() - 30 * 86400000;
  const total = new Map<string, number>();
  const perChannel = new Map<string, number>();
  for (const s of ws.sends) {
    if (new Date(s.at).getTime() < since) continue;
    total.set(s.customerId, (total.get(s.customerId) ?? 0) + 1);
    perChannel.set(`${s.customerId}|${s.channel}`, (perChannel.get(`${s.customerId}|${s.channel}`) ?? 0) + 1);
  }
  return { total, perChannel };
}

/** Customers who complained within the last `days` days before the data snapshot. */
async function recentComplainers(days: number) {
  if (!days) return new Set<string>();
  const since = new Date(SNAPSHOT.getTime() - days * 86400000).toISOString().slice(0, 10);
  const res = await queryRows<{ customer_id: string }>("service_tickets", ["customer_id"], [{ field: "category", value: "complaint" }, { field: "created_at", op: "gte", value: since }], 1000).catch((e) => {
    log.warn("campaigns", "recent complaints could not be loaded: the quiet days after a complaint are not applied to this plan", e);
    return { rows: [] };
  });
  return new Set(res.rows.map((r) => r.customer_id));
}

export async function planCampaign(c: Campaign): Promise<CampaignPlan> {
  const t = ws.settings.terms;
  const body = {
    name: c.id,
    audience: cleanAudience(c.audience),
    offer_ids: c.offerMode === "pinned" ? c.offerIds : [],
    // Pinned offers already say what to sell; an extra type filter could rule them out (e.g. a shop item vs "sales").
    action_types: c.offerMode === "service" ? ["service"] : c.offerMode === "pinned" && c.offerIds.length ? [] : c.actionTypes,
    min_dclv_eur: Math.max(c.minDclvEur, t.minDclvEur),
    max_contacts: c.maxContacts,
    control_share: c.controlShare,
  };
  const up = await timed("campaigns", `plan for ${c.id} (insights service)`, () => ins.post<UpstreamPlan>("/campaigns/plan", body, { timeoutMs: 60_000 }), 5000);

  // Kompass terms on top of the engine's gates: channels chosen for this campaign, channels
  // switched off in Settings, quiet days after a complaint, and contact limits over 30 days.
  const { total, perChannel } = recentContacts();
  const quiet = await recentComplainers(t.quietDaysAfterComplaint);
  const rows = up.rows.map((r) => {
    if (r.status === "skipped") return { ...r, skip_reason: plainSkip(r.skip_reason, c) };
    if (r.status !== "contact" || !r.action) return r;
    const ch = r.action.channel ?? "";
    let reason: string | null = null;
    if (!ch) reason = WHY.noChannel;
    // A service contact is the service team calling about an open problem: the channel switches do not apply.
    else if (ch !== "service_contact" && !c.channels.includes(ch)) reason = WHY.notSelected(ch);
    else if (quiet.has(r.customer_id) && r.action.action_type !== "service") reason = WHY.quiet(t.quietDaysAfterComplaint);
    else if (t.channelsEnabled[ch] === false) reason = WHY.switchedOff(ch);
    else if ((total.get(r.customer_id) ?? 0) >= t.contactLimit30d) reason = WHY.contactLimit(t.contactLimit30d);
    else if ((perChannel.get(`${r.customer_id}|${ch}`) ?? 0) >= (t.channelLimits30d[ch] ?? 99)) reason = WHY.channelLimit(ch, t.channelLimits30d[ch] ?? 99);
    if (!reason) return r;
    return { ...r, status: "skipped" as const, skip_reason: reason };
  });
  const contacts = rows.filter((r) => r.status === "contact");
  const group = (key: (r: PlanRow) => string) => {
    const m = new Map<string, { key: string; contacts: number; expected_dclv_eur: number }>();
    for (const r of contacts) {
      const k = key(r);
      const g = m.get(k) ?? { key: k, contacts: 0, expected_dclv_eur: 0 };
      g.contacts++;
      g.expected_dclv_eur = Math.round((g.expected_dclv_eur + (r.action?.dclv_eur ?? 0)) * 100) / 100;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.expected_dclv_eur - a.expected_dclv_eur);
  };
  // Counted from the final rows, so the reasons always add up to the number left out.
  const skippedRows = rows.filter((r) => r.status === "skipped");
  const skippedCount = new Map<string, number>();
  for (const r of skippedRows) skippedCount.set(r.skip_reason ?? "No offer fits", (skippedCount.get(r.skip_reason ?? "No offer fits") ?? 0) + 1);
  const summary: PlanSummary = {
    ...up.summary,
    contacts: contacts.length,
    skipped: skippedRows.length,
    expected_dclv_eur: Math.round(contacts.reduce((s, r) => s + (r.action?.dclv_eur ?? 0), 0) * 100) / 100,
    // The service only returns the total cost; it scales to the contacts that remain after Kompass's own terms.
    contact_cost_eur: Math.round(up.summary.contact_cost_eur * (contacts.length / Math.max(1, up.summary.contacts)) * 100) / 100,
    by_offer: group((r) => r.action?.product_name ?? r.action?.offer_id ?? "?"),
    by_channel: group((r) => r.action?.channel ?? "?"),
    by_tone: group((r) => (r.tonality === "du" ? "Du" : "Sie")),
    skipped_by_reason: Object.fromEntries([...skippedCount].sort((a, b) => b[1] - a[1])),
  };
  const plan = { summary, rows, computedAt: now() };
  c.plan = plan;
  c.updatedAt = now();
  log.info("campaigns", `planned ${c.id}: ${summary.contacts} contacts, ${summary.control} control, ${summary.skipped} left out of ${summary.audience}`, { offerMode: c.offerMode, channels: c.channels, reasons: summary.skipped_by_reason });
  save();
  return plan;
}

/** Which draft a plan channel uses: email and newsletter share one, calls and service contacts get the call script. */
export const DRAFT_OF: Record<string, MessageChannel> = { email: "email", newsletter: "email", portal_popup: "portal_popup", sms: "sms", outbound_call: "call", service_contact: "call" };
export function draftFor(c: Campaign, channel: string): EmailDoc {
  const k = DRAFT_OF[channel] ?? "email";
  return k === "email" ? c.email : (c.drafts?.[k] ?? c.email);
}
/** The offers a campaign was narrowed to ("a specific offer"): its offer blocks show these, not the engine's overall pick. */
export const pinnedOffers = (c: Campaign | undefined) => (c?.offerMode === "pinned" && c.offerIds.length ? c.offerIds : undefined);

/**
 * How many recipients are looked at per draft: the message preview in step 2 flips through the same
 * number (web/src/components/outreach/copy.ts), so both steps count the same versions and guardrails.
 */
export const PREVIEW_SAMPLE = 40;

/** Renders the first contacts of a draft the way the plan sends them (each on their own channel). */
async function renderSample(c: Campaign, rows: PlanRow[], limit = PREVIEW_SAMPLE) {
  const take = rows.slice(0, limit);
  let failures = 0;
  let firstError: unknown;
  const out = await mapLimit(take, 8, (r) =>
    renderEmail(draftFor(c, r.action?.channel ?? "email"), r.customer_id, ws.settings, r.action?.channel ?? "email", { offerIds: pinnedOffers(c) }).catch((e) => {
      failures++;
      firstError ??= e;
      return null;
    }),
  );
  if (failures) log.warn("campaigns", `${c.id}: ${failures} of ${take.length} previews could not be rendered`, firstError);
  return out.filter((e): e is RenderedEmail => !!e);
}

/** Recipients per version, most common first (service / offer X / information only). */
function countVersions(rendered: RenderedEmail[]): VariantStat[] {
  const m = new Map<string, VariantStat>();
  for (const e of rendered) {
    const v = m.get(e.variant) ?? { variant: e.variant, label: e.variantLabel, count: 0 };
    v.count++;
    m.set(e.variant, v);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

/** How many recipients get which version of the email (service / offer X / info only). */
export async function variantStats(c: Campaign, sample = PREVIEW_SAMPLE): Promise<{ stats: VariantStat[]; sampled: number; total: number }> {
  const plan = c.plan ?? (await planCampaign(c));
  const contacts = plan.rows.filter((r) => r.status === "contact");
  const rendered = await renderSample(c, contacts, sample);
  return { stats: countVersions(rendered), sampled: rendered.length, total: contacts.length };
}

// ---------- Review (step 3 of the guided outreach) ----------

// An SMS may take two messages. The same numbers drive the preview in step 2 and the guardrail in blocks.ts (320).
const SMS_SEGMENT = 160;
const SMS_LIMIT = SMS_SEGMENT * 2;
/** The SMS as the preview counts it: the visible blocks' text, joined by a space (not the plain-text export). */
const smsPlain = (e: RenderedEmail) =>
  e.blocks
    .filter((b) => b.visible)
    .map((b) => b.text)
    .filter(Boolean)
    .join(" ");
/** The review's extra detail per channel, beyond the shared type: how many were checked and which checks failed. */
type ReviewChannel = CampaignReview["channels"][number] & { sampled: number; variants: VariantStat[]; failing: { check: string; count: number }[] };
const isConsentCheck = (check: string) => check.startsWith("Consent");
/** The guardrail on the SMS length (blocks.ts); the review shows it as its own check. */
const isSmsLimitCheck = (check: string) => check.startsWith("SMS fits in");
/** The next working day, for schedules that start "tomorrow". */
function nextWorkday() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

export async function reviewCampaign(c: Campaign, slots?: { sendAt: string; customers: number }[]): Promise<CampaignReview & { channels: ReviewChannel[] }> {
  const plan = c.plan ?? (await planCampaign(c));
  const s = plan.summary;
  const t = ws.settings.terms;
  const contacts = plan.rows.filter((r) => r.status === "contact");
  const byDraft = new Map<MessageChannel, PlanRow[]>();
  for (const r of contacts) {
    const k = DRAFT_OF[r.action?.channel ?? "email"] ?? "email";
    byDraft.set(k, [...(byDraft.get(k) ?? []), r]);
  }

  // Each draft is checked on its first contacts, the same ones the preview in step 2 shows.
  const failed = new Map<string, { channel: string; count: number; of: number }[]>();
  const channels: ReviewChannel[] = [];
  for (const [key, rows] of [...byDraft.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const rendered = await renderSample(c, rows);
    const bad = new Map<string, number>();
    for (const e of rendered) for (const ch of e.checks) if (!ch.passed && !isConsentCheck(ch.check)) bad.set(ch.check, (bad.get(ch.check) ?? 0) + 1);
    for (const [check, count] of bad) if (!isSmsLimitCheck(check)) failed.set(check, [...(failed.get(check) ?? []), { channel: channelName(key), count, of: rendered.length }]);
    const first = rendered[0];
    const variants = countVersions(rendered);
    // An SMS card shows the text the phone shows.
    const text = first ? (key === "sms" ? smsPlain(first) : toPlain(first)) : "";
    channels.push({
      key,
      contacts: rows.length,
      sampled: rendered.length,
      versions: variants.map((v) => v.label),
      variants,
      failing: [...bad].map(([check, count]) => ({ check, count })),
      hasDraft: key === "email" || !!c.drafts?.[key],
      sample: first ? { customerId: first.customerId, name: `${first.identity.firstName} ${first.identity.lastName}`, tone: first.tone, subject: first.subject, text: text.slice(0, key === "sms" ? SMS_LIMIT : 220) } : undefined,
      ...(key === "sms" ? { smsChars: Math.max(0, ...rendered.map((e) => smsPlain(e).length)) } : {}),
    });
  }

  // When it goes out: one date style (28.10.2026, 09:00), as everywhere in the app.
  const timing = c.timing ?? { mode: "asap" };
  let schedule: CampaignReview["schedule"];
  if (timing.mode === "fixed" && timing.at) {
    schedule = [{ at: timing.at, label: `${dateDe(new Date(timing.at))}, ${timing.at.slice(11, 16)}`, customers: s.contacts }];
  } else if (timing.mode === "best" && slots) {
    const day = nextWorkday();
    schedule = slots.filter((x) => x.customers).map((x) => ({ at: `${day.toISOString().slice(0, 10)}T${x.sendAt}`, label: `${dateDe(day)}, ${x.sendAt}`, customers: x.customers }));
  } else schedule = [{ at: "", label: "Right after you press Send", customers: s.contacts }];

  const leftOut = (kind: string) => Object.entries(s.skipped_by_reason).reduce((n, [k, v]) => (skipKind(k) === kind ? n + v : n), 0);
  const noChannel = leftOut("channel");
  const protectedN = leftOut("limit");
  const serviceFirst = contacts.filter((r) => r.action?.action_type === "service").length;
  const email = byDraft.get("email")?.length ?? 0;
  const sms = channels.find((x) => x.key === "sms");
  const missing = channels.filter((x) => !x.hasDraft).map((x) => x.key);
  const checks: CampaignReview["checks"] = [
    { key: "consent", label: "Only channels each customer consented to, checked again at send time", ok: true, detail: noChannel ? `${plural(noChannel, "customer")} left out for missing consent or channel` : undefined },
    { key: "service", label: "Service before sales", ok: true, detail: serviceFirst ? `${plural(serviceFirst, "customer")} with an open problem ${serviceFirst === 1 ? "gets" : "get"} service, not an offer` : "Nobody in this audience has an open problem" },
    {
      key: "pressure",
      label: `Contact limits: at most ${plural(t.contactLimit30d, "message")} in 30 days, ${plural(t.quietDaysAfterComplaint, "quiet day")} after a complaint`,
      ok: true,
      detail: protectedN ? `${plural(protectedN, "customer")} left out to protect them` : undefined,
    },
    s.control >= 15
      ? { key: "control", label: `Control group of ${s.control} to measure the effect`, ok: true }
      : { key: "control", label: `Control group of ${s.control} is too small for a reliable result`, ok: false, fix: "control" as const },
  ];
  if (email) checks.push(c.email.blocks.some((b) => b.type === "footer") ? { key: "footer", label: "Every email has the unsubscribe footer", ok: true } : { key: "footer", label: "The email has no unsubscribe footer", ok: false, fix: "footer" });
  if (sms?.smsChars != null)
    checks.push(
      sms.smsChars <= SMS_LIMIT
        ? { key: "sms", label: `SMS fits in ${sms.smsChars <= SMS_SEGMENT ? "one message" : "two messages"}: the longest has ${sms.smsChars} of ${SMS_LIMIT} characters`, ok: true }
        : { key: "sms", label: `SMS is too long: the longest has ${sms.smsChars} characters, the limit is ${SMS_LIMIT} (two messages)`, ok: false, fix: "message" },
    );
  if (missing.length) checks.push({ key: "drafts", label: `No own text yet for ${missing.map(channelName).join(", ")}: the email text is used`, ok: false, fix: "message" });
  checks.push(
    failed.size
      ? {
          key: "brand",
          label: "Some texts fail the brand checks",
          ok: false,
          detail: [...failed]
            .slice(0, 3)
            .map(([check, by]) => `${check} (${by.map((x) => `${x.channel}: ${x.count} of ${x.of}`).join(", ")})`)
            .join(" · "),
          fix: "message",
        }
      : { key: "brand", label: "Texts pass the brand checks: right tone, no price pressure", ok: true },
  );
  return { channels, schedule, checks, approvalsNeeded: t.requireSecondApprover ? 2 : 1 };
}

// ---------- Launch (simulated delivery) ----------

function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// Engagement benchmarks from the mock data (newsletter funnel, human opens only).
const BENCH: Record<string, { deliver: number; open: number; click: number }> = {
  email: { deliver: 0.985, open: 0.236, click: 0.046 / 0.236 },
  newsletter: { deliver: 0.985, open: 0.236, click: 0.046 / 0.236 },
  portal_popup: { deliver: 0.62, open: 1, click: 0.08 },
  sms: { deliver: 0.97, open: 0.9, click: 0.06 },
  outbound_call: { deliver: 0.55, open: 1, click: 0.3 },
  service_contact: { deliver: 0.9, open: 1, click: 0.5 },
};
// Legacy action history: control converted at 2.02 % vs 3.41 % treated, so without a contact a
// customer converts at about 59 % of the contacted rate.
const CONTROL_FACTOR = 2.02 / 3.41;

export const launchCampaign = (c: Campaign) => timed("campaigns", `launch of ${c.id}`, () => runLaunch(c), 8000);

async function runLaunch(c: Campaign): Promise<CampaignResults> {
  const plan = await planCampaign(c); // consent and limits are re-checked at send time
  const rand = rng(c.id);
  const contacts = plan.rows.filter((r) => r.status === "contact" && r.action);
  const control = plan.rows.filter((r) => r.status === "control");
  log.info("campaigns", `launching ${c.id} "${c.name}" (approved by ${c.approvals.map((a) => a.by).join(", ") || "nobody"})`, { contacts: contacts.length, control: control.length, timing: c.timing?.mode ?? "asap" });
  // Recipients without consent for their channel at send time are dropped (live re-check).
  let recheckFailed = 0;
  const live = await mapLimit(contacts, 8, async (r) => {
    try {
      const rec = await loadRecipient(r.customer_id);
      const ch = r.action!.channel ?? "";
      return ch === "service_contact" || rec.profile.contact_policy.allowed_channels.includes(ch) ? r : null;
    } catch {
      recheckFailed++;
      return r;
    }
  });
  const sendable = live.filter((r): r is PlanRow => !!r);
  if (sendable.length < contacts.length) log.warn("campaigns", `${c.id}: ${contacts.length - sendable.length} of ${contacts.length} contacts dropped at send time, consent changed since the plan`);
  if (recheckFailed) log.warn("campaigns", `${c.id}: the consent re-check could not load ${recheckFailed} customers, they stay in the plan`);

  let delivered = 0,
    opens = 0,
    clicks = 0,
    conv = 0,
    unsub = 0,
    portal = 0,
    dclv = 0;
  const byOffer = new Map<string, { key: string; contacts: number; conversions: number }>();
  const byTone = new Map<string, { key: string; contacts: number; opens: number; clicks: number; conversions: number }>();
  const orders = new Map<string, number>();
  for (const r of sendable) {
    const a = r.action!;
    const ch = a.channel ?? "email";
    const bm = BENCH[ch] ?? BENCH.email;
    const o = byOffer.get(a.product_name) ?? { key: a.product_name, contacts: 0, conversions: 0 };
    const tk = r.tonality === "du" ? "Du" : "Sie";
    const t = byTone.get(tk) ?? { key: tk, contacts: 0, opens: 0, clicks: 0, conversions: 0 };
    o.contacts++;
    t.contacts++;
    ws.sends.push({ customerId: r.customer_id, channel: ch, at: now(), campaignId: c.id });
    if (rand() < bm.deliver) {
      delivered++;
      if (rand() < bm.open) {
        opens++;
        t.opens++;
        if (rand() < bm.click) {
          clicks++;
          t.clicks++;
          portal++;
        }
      }
      if (rand() < a.p_accept) {
        conv++;
        o.conversions++;
        t.conversions++;
        dclv += a.dclv_eur / Math.max(a.p_accept, 0.01);
        if (a.action_type !== "service") orders.set(a.product_name, (orders.get(a.product_name) ?? 0) + 1);
      } else if ((ch === "email" || ch === "newsletter") && rand() < 0.009) unsub++;
    }
    byOffer.set(o.key, o);
    byTone.set(tk, t);
  }
  let controlConv = 0;
  for (const r of control) {
    const p = (r.action?.p_accept ?? 0.03) * CONTROL_FACTOR;
    if (rand() < p) controlConv++;
  }
  const tr = sendable.length ? conv / sendable.length : 0;
  const cr = control.length ? controlConv / control.length : 0;
  const up = tr - cr;
  const se = Math.sqrt((tr * (1 - tr)) / Math.max(sendable.length, 1) + (cr * (1 - cr)) / Math.max(control.length, 1));
  const ci: [number, number] = [up - 1.96 * se, up + 1.96 * se];
  const verdict =
    control.length < 15 || sendable.length < 30 ? "Too few customers for a reliable verdict" : ci[0] > 0 ? "Works: contacted customers converted more than the control group" : ci[1] < 0 ? "Hurts: contacted customers converted less" : "No proven effect yet";

  const results: CampaignResults = {
    simulated: true,
    funnel: [
      { key: "planned", label: "In audience", count: plan.summary.audience },
      { key: "sent", label: "Sent (after consent re-check)", count: sendable.length },
      { key: "delivered", label: "Delivered / shown", count: delivered },
      { key: "opened", label: "Opened (human opens only)", count: opens },
      { key: "clicked", label: "Clicked", count: clicks },
      { key: "converted", label: "Converted", count: conv },
    ],
    treated: { n: sendable.length, conversions: conv, rate: tr },
    control: { n: control.length, conversions: controlConv, rate: cr },
    upliftPp: up * 100,
    ci95: [ci[0] * 100, ci[1] * 100],
    verdict,
    realisedDclvEur: Math.round(dclv),
    byOffer: [...byOffer.values()].sort((a, b) => b.contacts - a.contacts),
    byTone: [...byTone.values()],
    orders: [...orders.entries()].map(([product, count]) => ({ product, count })).sort((a, b) => b.count - a.count),
    portalVisits: portal,
    assumptions: [
      "Simulated: nothing is sent from the prototype.",
      "Each contact converts with the engine's acceptance rate for its offer, channel and tone.",
      "Opens and clicks follow the mock data's newsletter funnel (human opens 23.6 %, clicks 4.6 %).",
      "Control customers convert at 59 % of the contacted rate (legacy history: 2.02 % vs 3.41 %).",
      `Unsubscribes: ${unsub} (0.9 % of non-converting email recipients, as in the newsletter data).`,
    ],
  };
  c.results = results;
  c.status = "running";
  c.launchedAt = now();
  c.updatedAt = now();
  save();
  log.info("campaigns", `launched ${c.id}: ${sendable.length} sent (simulated), ${delivered} delivered, ${conv} converted, ${control.length} held out`, { uplift_pp: Math.round(results.upliftPp * 100) / 100, verdict });
  return results;
}

// ---------- Past newsletters (real stats from the mock data) ----------

interface NlRow {
  campaign_id: string;
  subject_line: string;
  product_focus: string;
  month: string;
  deliveries: number;
  human_open_rate: number;
  click_rate: number;
  conversions: number;
  unsubscribes: number;
}

export async function importLegacyNewsletters() {
  if (ws.campaigns.some((c) => c.source === "legacy_newsletter")) return;
  const res = await timed("campaigns", "import of past newsletters", () =>
    aggregate<NlRow>({
      dataset: "newsletter",
      dimensions: ["campaign_id", "subject_line", "product_focus"],
      measures: ["deliveries", "human_open_rate", "click_rate", "conversions", "unsubscribes"],
      sort: [{ field: "campaign_id" }],
      limit: 50,
    }),
  );
  const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
  res.rows.forEach((r, i) => {
    const sent = r.deliveries;
    const opens = Math.round(sent * r.human_open_rate);
    const clicks = Math.round(sent * r.click_rate);
    const at = `${months[Math.min(i * 0.7, months.length - 1) | 0]}-15T09:00:00`;
    ws.campaigns.push({
      id: r.campaign_id,
      name: r.subject_line,
      goal: `Newsletter (${r.product_focus})`,
      status: "done",
      source: "legacy_newsletter",
      createdAt: at,
      updatedAt: at,
      launchedAt: at,
      audience: {},
      audienceLabel: "All newsletter subscribers (no targeting)",
      offerMode: "engine",
      offerIds: [],
      actionTypes: [],
      channels: ["newsletter"],
      minDclvEur: 0,
      maxContacts: sent,
      controlShare: 0,
      email: { subject: { sie: r.subject_line, du: r.subject_line }, blocks: [] },
      followUp: null,
      approvals: [],
      results: {
        simulated: false,
        funnel: [
          { key: "sent", label: "Sent", count: sent },
          { key: "opened", label: "Opened (human opens only)", count: opens },
          { key: "clicked", label: "Clicked", count: clicks },
          { key: "converted", label: "Converted within 7 days", count: r.conversions },
          { key: "unsubscribed", label: "Unsubscribed", count: r.unsubscribes },
        ],
        treated: { n: sent, conversions: r.conversions, rate: sent ? r.conversions / sent : 0 },
        control: { n: 0, conversions: 0, rate: 0 },
        upliftPp: 0,
        ci95: [0, 0],
        verdict: "No control group: the effect cannot be measured",
        realisedDclvEur: 0,
        byOffer: [],
        byTone: [],
        orders: [],
        portalVisits: 0,
        assumptions: ["Real numbers from the newsletter data. Machine opens (Apple Mail Privacy Protection) are excluded."],
      },
    });
  });
  save();
  log.info("campaigns", `imported ${res.rows.length} past newsletters`);
}
