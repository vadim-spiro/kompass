// One campaign as a guided outreach: 1 Who & when → 2 Message → 3 Review & send, then Results.
import clsx from "clsx";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, ChevronRight, Copy, SlidersHorizontal, Sparkles, Trash2, type LucideIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Audience, AudienceCard, AudienceGroup, BestTimes, Block, Campaign, CampaignTiming, EmailDoc, MessageChannel, Settings, Vocabulary } from "../../../shared/types";
import { api, reportIssue, type CampaignFull, type Template } from "../api/client";
import { AudienceBuilder, describeAudience } from "../components/AudienceBuilder";
import { EmailBuilder, RENDER_CHANNEL } from "../components/EmailBuilder";
import { AnimatePresence, EASE, motion, spring, StepTransition } from "../components/motion";
import { AudienceGallery, GROUPS } from "../components/outreach/AudienceGallery";
import { AudiencePanel, channelCounts, channelGroups } from "../components/outreach/AudiencePanel";
import { defaultSendAt, OfferChoice, TimingChoice } from "../components/outreach/Choices";
import { smsText } from "../components/outreach/ChannelPreviews";
import { approvalsNeeded, campaignStatus, channelName, fmtWhen, isConsentCheck, isDefaultName, offerLabel, plainNote, plainReason, plural, skipList, SMS_LIMIT, uniqueName, withoutCount } from "../components/outreach/copy";
import { MESSAGE_CHANNELS, ReviewSend } from "../components/outreach/ReviewSend";
import { Badge, Button, ErrorNote, Figure, Input, PageBar, Select, Skeleton } from "../components/ui";
import { askKompass } from "../lib/ask";
import { loadBlocks, useBlocks, useVocabulary } from "../lib/catalog";
import { fmtDelta, fmtInt, fmtPct, fmtPp } from "../lib/format";
import { useScreen } from "../lib/screen";
import { emitDataChanged } from "../lib/useAsync";

type Step = "who" | "message" | "review" | "results";
type Plan = NonNullable<CampaignFull["plan"]>;
const STEPS: { key: Step; label: string }[] = [
  { key: "who", label: "Who & when" },
  { key: "message", label: "Message" },
  { key: "review", label: "Review & send" },
];
const ORDER: Step[] = ["who", "message", "review", "results"];
// Links from before the three-step flow.
const OLD_STEPS: Record<string, Step> = { audience: "who", offer: "who", email: "message", followup: "message", launch: "review" };
const REPLAN = ["audience", "offerMode", "offerIds", "actionTypes", "channels", "minDclvEur", "maxContacts", "controlShare"];
const CHANNELS = ["email", "newsletter", "portal_popup", "sms", "outbound_call"];
const CHANNEL_ALIASES: Record<string, string> = { call: "outbound_call", phone: "outbound_call", popup: "portal_popup", portal: "portal_popup", mail: "email" };

/** What the plan looks like now, in one line for the bubble. The reasons add up to the number left out. */
function planNote(p?: Plan) {
  if (!p) return "The plan could not be computed.";
  const s = p.summary;
  const ch = channelGroups(p)
    .map((x) => `${channelName(x.key)} ${x.contacts}`)
    .join(", ");
  const why = skipList(s, 3)
    .map(([r, n]) => `${r} ${n}`)
    .join(", ");
  return `${plural(s.contacts, "customer")} ${s.contacts === 1 ? "gets" : "get"} a message (${ch || "no channel"}), ${s.control} control, ${s.skipped} left out${why ? ` (${why})` : ""}. Expected CLV gain ${Math.round(s.expected_dclv_eur)} €.`;
}

/** Which draft a plan channel uses (as on the server): email and newsletter share one, calls and service contacts get the call script. */
const DRAFT_OF: Record<string, MessageChannel> = { email: "email", newsletter: "email", portal_popup: "portal_popup", sms: "sms", outbound_call: "call", service_contact: "call" };
const MSG_ORDER: MessageChannel[] = ["email", "portal_popup", "sms", "call"];
const toMsg = (v: unknown): MessageChannel | null => {
  const k = String(v ?? "");
  return (MSG_ORDER as string[]).includes(k) ? (k as MessageChannel) : (DRAFT_OF[k] ?? null);
};
const draftOf = (c: CampaignFull, ch: MessageChannel): EmailDoc => (ch === "email" ? c.email : (c.drafts?.[ch] ?? c.email));
const draftPatch = (c: CampaignFull, ch: MessageChannel, doc: EmailDoc): Partial<Campaign> => (ch === "email" ? { email: doc } : { drafts: { ...c.drafts, [ch]: doc } });
/** The channel the plan picked for each planned contact (customer id → channel). */
const channelOfContacts = (plan?: Plan) => Object.fromEntries((plan?.rows ?? []).filter((r) => r.status === "contact" && r.action?.channel).map((r) => [r.customer_id, r.action!.channel!]));
/** Channels with contacts in the plan, with how many get each draft. */
function messageTabs(c: CampaignFull, current: MessageChannel) {
  const n = new Map<MessageChannel, number>();
  for (const ch of c.plan?.summary.by_channel ?? []) {
    const k = DRAFT_OF[ch.key] ?? "email";
    n.set(k, (n.get(k) ?? 0) + ch.contacts);
  }
  return MSG_ORDER.filter((k) => n.get(k) || k === current || (!n.size && k === "email")).map((key) => ({ key, contacts: n.get(key) ?? 0 }));
}
let blockSeq = 0;
const nid = () => `b-${Date.now().toString(36)}${(blockSeq++).toString(36)}`;

export function CampaignEditorPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const vocab = useVocabulary();
  const [c, setC] = useState<CampaignFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [saved, setSaved] = useState(true);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cards, setCards] = useState<AudienceCard[] | null>(null);
  const [group, setGroup] = useState<AudienceGroup>("risk");
  const [best, setBest] = useState<BestTimes | null | "loading">(null);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [msgTab, setMsgTab] = useState<MessageChannel>("email");
  const [previewId, setPreviewId] = useState<string>();
  /** Names of the other campaigns, so a new default name can be made unique. */
  const [names, setNames] = useState<string[]>([]);
  const pending = useRef<Partial<Campaign>>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const prevStep = useRef<Step>("who");

  const replan = useCallback(async () => {
    setPlanning(true);
    try {
      const plan = await api.planCampaign(id);
      setC((prev) => (prev ? { ...prev, plan } : prev));
      return plan;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlanning(false);
    }
  }, [id]);

  useEffect(() => {
    api.campaign(id).then((camp) => {
      setC(camp);
      if (!camp.plan && camp.source === "kompass" && camp.status === "draft" && Object.keys(camp.audience).length) void replan();
    }, (e) => setError(e.message));
    api.settings().then(setSettings, (e) => reportIssue("warn", "campaign-editor", "settings could not be loaded", { error: String(e) }));
    api.campaigns().then((list) => setNames(list.filter((x) => x.id !== id).map((x) => x.name)), () => undefined);
  }, [id, replan]);
  useEffect(() => {
    api.outreachAudiences().then(setCards, (e) => setError(e.message));
  }, []);
  // Open the tab of the card this campaign started from.
  const cardId = c?.audienceSource?.cardId;
  useEffect(() => {
    const g = cards?.find((x) => x.id === cardId)?.group;
    if (g) setGroup(g);
  }, [cards, cardId]);
  // Best send times follow the plan.
  const planAt = c?.plan?.computedAt;
  const bestMode = c?.timing?.mode === "best";
  useEffect(() => {
    if (!bestMode || !planAt) return;
    let live = true;
    setBest((b) => b ?? "loading");
    api.bestTimes(id).then(
      (b) => live && setBest(b),
      () => live && setBest(null),
    );
    return () => {
      live = false;
    };
  }, [id, bestMode, planAt]);

  const launched = c?.status === "running" || c?.status === "done";
  const locked = !c || launched || c.source === "legacy_newsletter";
  const raw = sp.get("step") ?? "";
  // A campaign in review opens where it is approved and sent.
  const step: Step = (ORDER.includes(raw as Step) ? (raw as Step) : OLD_STEPS[raw]) || (launched ? "results" : c?.status === "review" ? "review" : "who");
  const stepN = ORDER.indexOf(step) + 1;
  const dir = ORDER.indexOf(step) >= ORDER.indexOf(prevStep.current) ? 1 : -1;
  useEffect(() => {
    prevStep.current = step;
  }, [step]);
  const go = (s: Step) => setSp({ step: s }, { replace: true });

  /** Local edit now, debounced save, re-plan when the audience or offer changed. */
  const edit = (patch: Partial<Campaign>) => {
    if (locked) return;
    setC((prev) => (prev ? ({ ...prev, ...patch, ...(prev.approvals.length && Object.keys(patch).some((k) => REPLAN.includes(k) || k === "email" || k === "drafts" || k === "timing") ? { approvals: [], status: "draft" } : {}) } as CampaignFull) : prev));
    pending.current = { ...pending.current, ...patch };
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const body = pending.current;
      pending.current = {};
      try {
        await api.updateCampaign(id, body);
        setSaved(true);
        if (Object.keys(body).some((k) => REPLAN.includes(k))) await replan();
      } catch (e) {
        setError((e as Error).message);
      }
    }, 700);
  };
  /** Saves at once and waits for the new plan: the bubble reports what changed. */
  const commit = async (patch: Partial<Campaign>) => {
    if (locked) throw new Error("This campaign is launched and read-only. Duplicate it to change anything.");
    edit(patch);
    clearTimeout(timer.current);
    const body = pending.current;
    pending.current = {};
    await api.updateCampaign(id, body);
    setSaved(true);
    return Object.keys(body).some((k) => REPLAN.includes(k)) ? await replan() : undefined;
  };
  const pickPatch = (card: AudienceCard): Partial<Campaign> => ({
    audience: card.audience,
    audienceLabel: card.title,
    audienceSource: { cardId: card.id, title: card.title },
    ...(c && (!c.goal || c.goal === cards?.find((x) => x.id === c.audienceSource?.cardId)?.goal) ? { goal: card.goal } : {}),
    // A name that came from the previous card follows the new card, kept unique ("Price watchers (2)").
    ...(c && (isDefaultName(c.name) || withoutCount(c.name) === c.audienceSource?.title) ? { name: uniqueName(card.title, names) } : {}),
    ...(c && c.offerMode !== "pinned" ? { offerMode: card.offerMode ?? "engine" } : {}),
  });

  /** One block from the bubble's description, with the catalog's defaults. */
  const makeBlock = async (ch: MessageChannel, x: { type?: unknown; sie?: unknown; du?: unknown; title?: unknown }): Promise<Block | null> => {
    const cat = await loadBlocks();
    const def = cat.blocks.find((d) => d.type === String(x.type) && (!d.channels || d.channels.includes(ch)));
    if (!def) return null;
    const props: Record<string, unknown> = structuredClone(def.defaults);
    const sie = x.sie != null ? String(x.sie) : undefined;
    const du = x.du != null ? String(x.du) : undefined;
    if (def.type === "text") Object.assign(props, { sie: sie ?? du ?? "", du: du ?? sie ?? "", ...(x.title ? { title: String(x.title) } : {}) });
    if (def.type === "hero" && (sie || x.title)) Object.assign(props, { title: sie ?? String(x.title), titleDu: du ?? sie ?? String(x.title) });
    if (def.type === "button" && (x.title || sie)) props.label = String(x.title ?? sie);
    return { id: nid(), type: def.type, props };
  };
  /** Renders a draft for the channel's first contact and says whether every guardrail holds. */
  const checkDraft = async (ch: MessageChannel, doc: EmailDoc) => {
    const rs = await api.recipients({ campaignId: id, channel: ch, limit: 1 }).catch(() => []);
    if (!rs.length) return "";
    // The way the plan sends to this customer: a newsletter contact has no email consent, and that is no failed guardrail.
    const e = await api.render(doc, rs[0].customerId, channelOfContacts(c?.plan)[rs[0].customerId] ?? RENDER_CHANNEL[ch], id).catch(() => null);
    if (!e) return "";
    const failed = e.checks.filter((x) => !x.passed && !isConsentCheck(x.check));
    const len = ch === "sms" ? ` The SMS for ${e.identity.firstName} has ${smsText(e).length} of ${SMS_LIMIT} characters.` : "";
    return failed.length
      ? `Guardrails failed for ${e.identity.name}: ${failed.map((f) => `${f.check}${f.detail ? ` (${f.detail})` : ""}`).join("; ")}. Fix the text.${len}`
      : `All guardrails pass for ${e.identity.name} (${e.variantLabel}).${len}`;
  };
  const openDraft = (a: Record<string, unknown>) => {
    if (step !== "message") go("message");
    const ch = toMsg(a.channel);
    if (ch) setMsgTab(ch);
  };
  const needDraft = (a: Record<string, unknown>) => {
    const ch = toMsg(a.channel);
    if (!ch) throw new Error("channel must be email, portal_popup, sms or call.");
    if (!c) throw new Error("The campaign is still loading.");
    return { ch, doc: draftOf(c, ch), label: MESSAGE_CHANNELS[ch].editor };
  };

  const s = c?.plan?.summary;
  const { customer_ids: ids, ...filters } = c?.audience ?? {};
  useScreen(
    "campaign",
    {
      view: "campaign",
      title: c ? `Campaign · Step ${Math.min(stepN, 3)} · ${s ? plural(s.contacts, "contact") : planning ? "planning" : "no audience yet"}` : "Campaign",
      data: c
        ? {
            id: c.id,
            name: c.name,
            status: c.status,
            step: step === "results" ? "results" : stepN,
            goal: c.goal,
            audience: Object.keys(c.audience).length ? { card: c.audienceSource?.cardId, label: c.audienceLabel || describeAudience(c.audience, vocab), filters: { ...filters, ...(ids ? { customer_ids: plural(ids.length, "customer") } : {}) } } : "none yet",
            offer: c.offerMode === "pinned" ? { mode: "pinned", offers: c.offerIds } : c.offerMode,
            timing: c.timing ?? { mode: "asap" },
            channels: c.channels,
            plan: s
              ? {
                  contacts: s.contacts,
                  control: s.control,
                  left_out: s.skipped,
                  left_out_why: Object.entries(s.skipped_by_reason)
                    .sort((a, z) => z[1] - a[1])
                    .slice(0, 4)
                    .map(([why, n]) => `${why} (${n})`),
                  by_channel: Object.fromEntries(channelGroups(c.plan).map((x) => [x.key, x.contacts])),
                  top_offers: s.by_offer.slice(0, 3).map((o) => `${offerLabel(o.key)} (${o.contacts})`),
                  expected_dclv_eur: Math.round(s.expected_dclv_eur),
                }
              : undefined,
            message_tabs: c && step === "message" ? messageTabs(c, msgTab).map((t) => `${t.key} (${t.contacts})`) : undefined,
            open_tab: step === "message" ? msgTab : undefined,
            drafts:
              step === "message" || step === "review"
                ? Object.fromEntries(
                    MSG_ORDER.map((ch) => {
                      const d = draftOf(c, ch);
                      return [
                        ch,
                        {
                          ...(ch === "email" ? { subject: d.subject } : {}),
                          blocks: d.blocks.map((b) => (b.type === "text" ? `${b.id} text: ${String(b.props.sie ?? "").slice(0, 50)}` : `${b.id} ${b.type}`)),
                        },
                      ];
                    }),
                  )
                : undefined,
            cards:
              step === "who" && cards
                ? Object.fromEntries(
                    GROUPS.map((g) => [
                      g.label,
                      cards
                        .filter((x) => x.group === g.key)
                        .slice(0, 8)
                        .map((x) => `${x.id} = ${x.title} (${x.customers})`),
                    ]),
                  )
                : undefined,
          }
        : undefined,
    },
    {
      pick_audience: {
        prepare: (a) => {
          if (step !== "who") go("who");
          const card = cards?.find((x) => x.id === a.card_id);
          if (card) setGroup(card.group);
        },
        target: (a) => `audience-card:${a.card_id}`,
        run: async (a) => {
          const card = cards?.find((x) => x.id === a.card_id);
          if (!card) throw new Error(`There is no audience card "${a.card_id}". Use an id from the screen's cards.`);
          const plan = await commit(pickPatch(card));
          return `Picked "${card.title}". ${planNote(plan)}`;
        },
      },
      refine_audience: {
        prepare: () => {
          if (step !== "who") go("who");
          setTuneOpen(true);
        },
        target: () => "audience-refine",
        run: async (a) => {
          if (!c) throw new Error("The campaign is still loading.");
          const extra = (a.audience ?? {}) as Audience;
          const label = String(a.label || `${c.audienceLabel || describeAudience(c.audience, vocab)} · ${describeAudience(extra, vocab)}`);
          const plan = await commit({ audience: { ...c.audience, ...extra }, audienceLabel: label });
          return `Audience is now "${label}". ${planNote(plan)}`;
        },
      },
      set_offer_mode: {
        prepare: () => {
          if (step !== "who") go("who");
        },
        target: () => "offer-mode",
        run: async (a) => {
          if (!c) throw new Error("The campaign is still loading.");
          const mode = String(a.mode) as Campaign["offerMode"];
          if (!["engine", "pinned", "service"].includes(mode)) throw new Error("mode must be engine, pinned or service.");
          let offerIds = c.offerIds;
          if (mode === "pinned") {
            const want = String(a.offer_id ?? "").toLowerCase();
            const o = vocab?.offers.find((x) => !x.disabled && (x.offer_id.toLowerCase() === want || x.product_name.toLowerCase() === want));
            if (!o)
              throw new Error(
                `Unknown offer "${a.offer_id}". Offers: ${(vocab?.offers ?? [])
                  .filter((x) => !x.disabled)
                  .map((x) => x.product_name)
                  .join(", ")}`,
              );
            offerIds = [o.offer_id];
          }
          const plan = await commit({ offerMode: mode, offerIds });
          const top = plan?.summary.by_offer
            .slice(0, 3)
            .map((o) => `${offerLabel(o.key)} ${o.contacts}`)
            .join(", ");
          const named = offerIds.map((oid) => vocab?.offers.find((x) => x.offer_id === oid)?.product_name ?? "the chosen offer");
          return `Offer: ${mode === "engine" ? "best offer per customer" : mode === "service" ? "service only" : named.join(", ")}. ${planNote(plan)}${top ? ` Offers going out: ${top}.` : ""}`;
        },
      },
      set_timing: {
        prepare: () => {
          if (step !== "who") go("who");
        },
        target: () => "timing",
        run: async (a) => {
          const mode = String(a.mode) as CampaignTiming["mode"];
          if (!["asap", "fixed", "best"].includes(mode)) throw new Error("mode must be asap, fixed or best.");
          let at: string | undefined;
          if (mode === "fixed") {
            at = a.at ? String(a.at).slice(0, 16) : defaultSendAt();
            if (Number.isNaN(new Date(at).getTime())) throw new Error("at must be a date and time like 2026-10-29T09:00.");
          }
          await commit({ timing: { mode, ...(at ? { at } : {}) } });
          if (mode === "best") {
            setBest("loading");
            const b = await api.bestTimes(id);
            setBest(b);
            return `Each customer gets the message at their best time. ${b.headline}. Slots: ${b.slots.map((x) => `${x.sendAt} → ${x.customers}`).join(", ")}.`;
          }
          return mode === "asap" ? "Sends right after the user presses Send." : `Sends on ${fmtWhen(at)}.`;
        },
      },
      set_channels: {
        prepare: () => {
          if (step !== "who") go("who");
        },
        target: () => "channels",
        run: async (a) => {
          const asked = (Array.isArray(a.channels) ? a.channels : []).map((x) => CHANNEL_ALIASES[String(x)] ?? String(x)).filter((x) => CHANNELS.includes(x));
          const off = asked.filter((ch) => settings?.terms.channelsEnabled[ch] === false);
          const chs = [...new Set(asked.filter((ch) => !off.includes(ch)))];
          if (!chs.length) throw new Error(`Give at least one channel that is switched on: ${CHANNELS.join(", ")}.`);
          const plan = await commit({ channels: chs });
          return `Channels: ${chs.map(channelName).join(", ")}${off.length ? ` (${off.map(channelName).join(", ")} is switched off in Settings)` : ""}. ${planNote(plan)}`;
        },
      },
      draft_channel: {
        prepare: openDraft,
        target: (a) => `channel-tab:${toMsg(a.channel)}`,
        run: async (a) => {
          const { ch, doc: prev, label } = needDraft(a);
          const blocks: Block[] = [];
          const skipped: string[] = [];
          for (const raw of Array.isArray(a.blocks) ? a.blocks : []) {
            const b = await makeBlock(ch, raw as Record<string, unknown>);
            if (b) blocks.push(b);
            else skipped.push(String((raw as { type?: unknown }).type));
          }
          if (!blocks.length) throw new Error(`No usable blocks for the ${label}.${skipped.length ? ` Not available here: ${skipped.join(", ")}.` : ""}`);
          if (ch === "email" && !blocks.some((b) => b.type === "footer")) blocks.push({ id: nid(), type: "footer", props: {} });
          const subject = ch === "email" ? { sie: String(a.subject_sie || prev.subject.sie), du: String(a.subject_du || a.subject_sie || prev.subject.du) } : prev.subject;
          const doc: EmailDoc = { subject, blocks };
          await commit(draftPatch(c!, ch, doc));
          return `${label} written: ${blocks.map((b) => b.type).join(", ")}.${skipped.length ? ` Left out (not for this channel): ${skipped.join(", ")}.` : ""} ${await checkDraft(ch, doc)}`;
        },
      },
      set_block_text: {
        prepare: openDraft,
        target: (a) => `block:${a.block_id}`,
        run: async (a) => {
          const { ch, doc, label } = needDraft(a);
          const blk = doc.blocks.find((b) => b.id === a.block_id);
          if (!blk) throw new Error(`No block ${a.block_id} in the ${label}. Blocks: ${doc.blocks.map((b) => `${b.id} ${b.type}`).join(", ")}`);
          if (!["text", "hero", "button"].includes(blk.type)) throw new Error(`${blk.type} is a smart block: it fills itself per customer. Add a text block instead.`);
          const sie = String(a.sie ?? "");
          const du = String(a.du ?? a.sie ?? "");
          const props = blk.type === "text" ? { ...blk.props, sie, du } : blk.type === "hero" ? { ...blk.props, title: sie, titleDu: du } : { ...blk.props, label: sie };
          const next = { ...doc, blocks: doc.blocks.map((b) => (b.id === blk.id ? { ...b, props } : b)) };
          await commit(draftPatch(c!, ch, next));
          return `Rewritten. ${await checkDraft(ch, next)}`;
        },
      },
      add_block: {
        prepare: openDraft,
        target: (a) => `channel-tab:${toMsg(a.channel)}`,
        run: async (a) => {
          const { ch, doc, label } = needDraft(a);
          const b = await makeBlock(ch, a);
          if (!b) throw new Error(`A ${a.type} block is not available in the ${label}.`);
          const blocks = [...doc.blocks];
          const after = blocks.findIndex((x) => x.id === a.after);
          const footer = blocks.findIndex((x) => x.type === "footer");
          blocks.splice(after >= 0 ? after + 1 : footer >= 0 ? footer : blocks.length, 0, b);
          const next = { ...doc, blocks };
          await commit(draftPatch(c!, ch, next));
          return `Added ${b.type} (${b.id}) to the ${label}. ${await checkDraft(ch, next)}`;
        },
      },
      remove_block: {
        prepare: openDraft,
        target: (a) => `block:${a.block_id}`,
        run: async (a) => {
          const { ch, doc, label } = needDraft(a);
          if (!doc.blocks.some((b) => b.id === a.block_id)) throw new Error(`No block ${a.block_id} in the ${label}.`);
          const next = { ...doc, blocks: doc.blocks.filter((b) => b.id !== a.block_id) };
          await commit(draftPatch(c!, ch, next));
          return `Removed. The ${label} now has ${next.blocks.map((b) => b.type).join(", ")}.`;
        },
      },
      preview_customer: {
        prepare: (a) => openDraft({ channel: a.channel ?? msgTab }),
        target: () => "message-preview",
        run: async (a) => {
          const ch = toMsg(a.channel) ?? msgTab;
          const cid = String(a.customer_id ?? "");
          if (!/^MG-\d+$/.test(cid)) throw new Error("customer_id looks like MG-100123.");
          setPreviewId(cid);
          const e = await api.render(draftOf(c!, ch), cid, RENDER_CHANNEL[ch], id).catch(() => null);
          return e ? `The preview shows ${e.identity.name}: ${e.variantLabel}, ${e.blocks.filter((b) => b.visible).length} visible blocks.` : `The preview shows ${cid}.`;
        },
      },
      go_to_step: {
        target: (a) => `step-${a.step}`,
        run: async (a) => {
          const n = Number(a.step);
          const to = n === 1 ? "who" : n === 2 ? "message" : n === 3 ? "review" : null;
          if (!to) throw new Error("step must be 1, 2 or 3.");
          if (launched) throw new Error("This campaign is already launched.");
          go(to);
          return n === 3 ? "The review is on screen. Sending is up to the user: tell them it is ready for their review." : `Step ${n} is on screen.`;
        },
      },
    },
  );

  if (!c) return <>{error ? <ErrorNote error={error} className="m-6" /> : <Skeleton className="m-6 h-96" />}</>;

  const done: Record<Step, boolean> = {
    who: !!s && s.contacts > 0,
    message: !!s && s.contacts > 0 && c.email.blocks.length >= 2 && !!c.email.subject.sie,
    review: !!c.launchedAt,
    results: c.status === "done",
  };

  const status = campaignStatus(c, approvalsNeeded(settings));

  return (
    <>
      <PageBar
        title={
          <span className="flex items-center gap-2">
            <Link to="/campaigns" className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700" aria-label="Back to campaigns">
              <ArrowLeft size={16} />
            </Link>
            <input
              value={c.name}
              disabled={locked}
              onChange={(e) => edit({ name: e.target.value })}
              style={{ width: `${Math.max(10, c.name.length + 2)}ch` }}
              className="no-drag min-w-0 max-w-[520px] rounded px-1 font-semibold hover:bg-ink-100 focus:bg-white focus:outline-none focus:ring-2 focus:ring-navy-100 disabled:hover:bg-transparent"
            />
            {c.source === "legacy_newsletter" ? <Badge tint="neutral">Past newsletter</Badge> : <Badge tint={status.tint}>{status.label}</Badge>}
          </span>
        }
        actions={
          <>
            {!locked && <span className="flex items-center gap-1 text-[12px] text-ink-400">{saved ? <><Check size={13} /> Saved</> : "Saving…"}</span>}
            {c.source === "kompass" && (
              <Button
                size="sm"
                variant="ghost"
                icon={Copy}
                onClick={async () => {
                  try {
                    nav(`/campaigns/${(await api.duplicateCampaign(c.id)).id}?step=who`);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Duplicate
              </Button>
            )}
            {c.status === "draft" && (
              <ConfirmButton
                label="Delete"
                icon={Trash2}
                onConfirm={async () => {
                  try {
                    // A save still waiting for its pause would hit a campaign that no longer exists.
                    clearTimeout(timer.current);
                    pending.current = {};
                    await api.deleteCampaign(c.id);
                    nav("/campaigns");
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              />
            )}
          </>
        }
      />
      {c.source === "kompass" && (
        <div className="flex shrink-0 items-center gap-1 border-b border-ink-200 bg-white px-6 py-2">
          {STEPS.map((st, i) => (
            <Fragment key={st.key}>
              {i > 0 && <ChevronRight size={14} className="text-ink-300" />}
              <button data-ai={`step-${i + 1}`} onClick={() => go(st.key)} className={clsx("relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors", step === st.key ? "text-white" : "text-ink-600 hover:bg-ink-100")}>
                {step === st.key && <motion.span layoutId="campaign-step" className="absolute inset-0 rounded-lg bg-navy-900" transition={spring} />}
                <span className="relative">
                  {done[st.key] ? (
                    <CheckCircle2 size={14} className={step === st.key ? "text-sun-400" : "text-good-600"} />
                  ) : (
                    <span className={clsx("num grid h-4 w-4 place-items-center rounded-full text-[10px]", step === st.key ? "bg-white/20" : "bg-ink-200 text-ink-600")}>{i + 1}</span>
                  )}
                </span>
                <span className="relative">{st.label}</span>
              </button>
            </Fragment>
          ))}
          {launched && (
            <>
              <ChevronRight size={14} className="text-ink-300" />
              <button onClick={() => go("results")} className={clsx("relative rounded-lg px-2.5 py-1.5 text-[13px] font-medium", step === "results" ? "text-white" : "text-ink-600 hover:bg-ink-100")}>
                {step === "results" && <motion.span layoutId="campaign-step" className="absolute inset-0 rounded-lg bg-navy-900" transition={spring} />}
                <span className="relative">Results</span>
              </button>
            </>
          )}
          <div className="ml-auto">
            {!locked && step === "who" && (
              <Button size="sm" variant="primary" disabled={!s?.contacts} onClick={() => go("message")}>
                Continue to the message <ArrowRight size={14} />
              </Button>
            )}
            {!locked && step === "message" && (
              <Button size="sm" variant="primary" onClick={() => go("review")}>
                Review & send <ArrowRight size={14} />
              </Button>
            )}
          </div>
        </div>
      )}
      {locked && c.source === "kompass" && step !== "results" && (
        <div className="shrink-0 bg-navy-50 px-6 py-2 text-[12.5px] text-navy-800">Launched {fmtWhen(c.launchedAt, false)}. A launched campaign is read-only; duplicate it to change anything.</div>
      )}
      <ErrorNote error={error} className="mx-6 mt-3" />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <StepTransition key={step} stepKey={step} dir={dir} className="h-full">
          {step === "who" && (
            <WhoStep
              c={c}
              cards={cards}
              group={group}
              onGroup={setGroup}
              vocab={vocab}
              settings={settings}
              locked={locked}
              edit={edit}
              onPick={(card) => edit(pickPatch(card))}
              tuneOpen={tuneOpen}
              setTuneOpen={setTuneOpen}
              best={best}
              planning={planning}
              onOpenCustomer={(cid) => nav(`/customers/${cid}`)}
            />
          )}
          {step === "message" && <MessageStep c={c} readOnly={locked} tab={msgTab} onTab={setMsgTab} previewCustomerId={previewId} onChange={(ch, doc) => edit(draftPatch(c, ch, doc))} />}
          {step === "review" && (
            <ReviewSend
              c={c}
              settings={settings}
              planning={planning}
              saving={!saved}
              onGo={go}
              onEdit={edit}
              onChanged={(camp) => {
                setC((prev) => (prev ? { ...prev, ...camp, plan: prev.plan } : prev));
                emitDataChanged();
              }}
              onLaunched={() => {
                api.campaign(id).then(setC);
                emitDataChanged();
                go("results");
              }}
            />
          )}
          {step === "results" && <ResultsStep c={c} onUpdate={() => api.campaign(id).then(setC)} />}
        </StepTransition>
      </div>
    </>
  );
}

/** A button that asks "Delete? Yes / No" in place, instead of a browser dialog. Walking away cancels the question. */
function ConfirmButton({ label, icon, onConfirm }: { label: string; icon?: LucideIcon; onConfirm: () => void | Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAsking(false), 8000);
    return () => clearTimeout(t);
  }, [asking]);
  if (!asking)
    return (
      <Button size="sm" variant="ghost" icon={icon} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  return (
    <span role="group" aria-label={`${label}?`} className="flex items-center gap-1" onKeyDown={(e) => e.key === "Escape" && setAsking(false)}>
      <span className="text-[12.5px] font-medium text-bad-600">{label}?</span>
      <Button
        size="sm"
        variant="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
            setAsking(false);
          }
        }}
      >
        Yes
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} autoFocus onClick={() => setAsking(false)}>
        No
      </Button>
    </span>
  );
}

function Section({ title, hint, children, aiTarget }: { title: string; hint?: string; children: React.ReactNode; aiTarget?: string }) {
  return (
    <section data-ai={aiTarget}>
      <div className="mb-2.5">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink-950">{title}</h2>
        {hint && <p className="mt-0.5 text-[12.5px] text-ink-500">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function WhoStep({
  c,
  cards,
  group,
  onGroup,
  vocab,
  settings,
  locked,
  edit,
  onPick,
  tuneOpen,
  setTuneOpen,
  best,
  planning,
  onOpenCustomer,
}: {
  c: CampaignFull;
  cards: AudienceCard[] | null;
  group: AudienceGroup;
  onGroup: (g: AudienceGroup) => void;
  vocab: Vocabulary | null;
  settings: Settings | null;
  locked: boolean;
  edit: (p: Partial<Campaign>) => void;
  onPick: (card: AudienceCard) => void;
  tuneOpen: boolean;
  setTuneOpen: (v: boolean) => void;
  best: BestTimes | null | "loading";
  planning: boolean;
  onOpenCustomer: (id: string) => void;
}) {
  const timing = c.timing ?? { mode: "asap" as const };
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto page-scroll px-8 py-6 scroll-thin">
        <div className="mx-auto max-w-[880px] space-y-8">
          <Section title="Who should hear from you?" hint="Start from a ready-made audience. The figures come straight from the insights service.">
            <AudienceGallery cards={cards} group={group} onGroup={onGroup} selected={c.audienceSource?.cardId} onPick={onPick} disabled={locked} />
            <div data-ai="audience-refine" className="mt-3 rounded-xl border border-ink-200 bg-white">
              <button onClick={() => setTuneOpen(!tuneOpen)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left">
                <SlidersHorizontal size={14} className="shrink-0 text-ink-500" />
                <span className="shrink-0 text-[13px] font-medium text-ink-900">Fine-tune</span>
                <span className="min-w-0 truncate text-[12.5px] text-ink-500">{Object.keys(c.audience).length ? c.audienceLabel || describeAudience(c.audience, vocab) : "or build an audience from filters"}</span>
                <ChevronDown size={15} className={clsx("ml-auto shrink-0 text-ink-400 transition-transform", tuneOpen && "rotate-180")} />
              </button>
              <AnimatePresence initial={false}>
                {tuneOpen && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease: EASE }} className="overflow-hidden">
                    <fieldset disabled={locked} className="border-t border-ink-100 px-4 py-4">
                      {c.audience.customer_ids && <p className="mb-3 text-[12px] text-ink-500">Starts from the {plural(c.audience.customer_ids.length, "customer")} of “{c.audienceSource?.title}”. Filters below narrow it down.</p>}
                      <AudienceBuilder value={c.audience} vocab={vocab} onChange={(audience) => edit({ audience, audienceLabel: c.audienceSource ? `${c.audienceSource.title} (fine-tuned)` : describeAudience(audience, vocab) })} />
                    </fieldset>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </Section>

          <Section title="What should they get?" hint="Offers are never shown to customers in dunning, with an open complaint or a pending cancellation. Prices are the same for everyone.">
            <OfferChoice c={c} vocab={vocab} disabled={locked} onChange={(p) => edit(p)} />
          </Section>

          <Section title="When should it arrive?">
            <TimingChoice timing={timing} best={best} disabled={locked} onChange={(t) => edit({ timing: t })} />
          </Section>

          <Section title="Which channels may we use?" hint="Each customer gets one message, on a channel they consented to. Contact limits from Settings apply." aiTarget="channels">
            <ChannelPicker c={c} settings={settings} disabled={locked} onChange={(channels) => edit({ channels })} />
          </Section>

          <Section title="Goal" hint="One sentence. Kompass uses it when it writes the message.">
            <Input value={c.goal} disabled={locked} onChange={(e) => edit({ goal: e.target.value })} placeholder="e.g. Keep customers whose price guarantee ends with a fair follow-up tariff" />
          </Section>
        </div>
      </div>
      <aside className="w-[380px] shrink-0 overflow-y-auto page-scroll border-l border-ink-200 bg-white px-5 py-5 scroll-thin">
        <AudiencePanel
          plan={c.plan}
          planning={planning}
          label={Object.keys(c.audience).length ? c.audienceLabel || describeAudience(c.audience, vocab) : undefined}
          onOpenCustomer={onOpenCustomer}
          footer={
            c.plan && (
              <div className="rounded-xl bg-ink-50 px-3 py-2.5 text-[12.5px] text-ink-600">
                <span className="font-medium text-ink-800">When: </span>
                {timing.mode === "asap"
                  ? "right after you press Send"
                  : timing.mode === "fixed"
                    ? fmtWhen(timing.at)
                    : best && best !== "loading"
                      ? best.slots
                          .filter((x) => x.customers)
                          .map((x) => `${x.sendAt} → ${fmtInt(x.customers)}`)
                          .join(" · ")
                      : "each customer's best time"}
              </div>
            )
          }
        />
      </aside>
    </div>
  );
}

/** "A, B and C". */
const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? ""));

function ChannelPicker({ c, settings, disabled, onChange }: { c: CampaignFull; settings: Settings | null; disabled?: boolean; onChange: (ch: string[]) => void }) {
  // Service-only messages go out as a service call, which these switches do not govern.
  const serviceOnly = c.offerMode === "service";
  const counts = channelCounts(c.plan);
  const reach = (ch: string) => counts.get(ch) ?? 0;
  const serviceCalls = counts.get("service_contact") ?? 0;
  /** Customers left out because the campaign does not use this channel. */
  const leftOut = (ch: string) => Object.entries(c.plan?.summary.skipped_by_reason ?? {}).reduce((n, [why, k]) => (plainReason(why) === `${channelName(ch)} not selected for this campaign` ? n + k : n), 0);
  const unused = CHANNELS.filter((ch) => c.plan && c.channels.includes(ch) && settings?.terms.channelsEnabled[ch] !== false && !reach(ch));
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {CHANNELS.map((ch) => {
          const on = c.channels.includes(ch);
          const off = settings && settings.terms.channelsEnabled[ch] === false;
          const n = reach(ch);
          const out = leftOut(ch);
          return (
            <button
              key={ch}
              disabled={disabled || !!off || serviceOnly}
              title={serviceOnly ? "Does not apply to service-only messages" : off ? "Switched off in Settings" : on && c.plan && !n ? "Nobody in this audience gets this channel" : undefined}
              onClick={() => onChange(on ? c.channels.filter((x) => x !== ch) : [...c.channels, ch])}
              className={clsx("flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] transition-colors disabled:opacity-40", on ? "border-navy-700 bg-navy-900 text-white" : "border-ink-200 bg-white text-ink-700 hover:bg-ink-50")}
            >
              {on && <Check size={13} />}
              {channelName(ch)}
              {c.plan && !serviceOnly && (on ? <span className="num text-[12px] text-white/70">{fmtInt(n)}</span> : out > 0 ? <span className="num text-[12px] text-ink-400">{fmtInt(out)} left out</span> : null)}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[12px] leading-snug text-ink-500">
        {serviceOnly ? (
          "Service-only messages go out as a call from the service team about the open issue, so these switches do not apply."
        ) : (
          <>
            Customers get the cheapest channel they consented to: Portal pop-up first, then Email, Newsletter, SMS and Call. A channel you switch off leaves its customers out; they are not moved to another channel.
            {serviceCalls > 0 && ` ${plural(serviceCalls, "customer")} with an open problem get a service call instead, whatever you switch here.`}
            {unused.length > 0 && ` ${list(unused.map(channelName))} ${unused.length === 1 ? "reaches" : "reach"} nobody in this audience.`}
          </>
        )}
      </p>
    </div>
  );
}

function MessageStep({
  c,
  readOnly,
  tab,
  onTab,
  onChange,
  previewCustomerId,
}: {
  c: CampaignFull;
  readOnly: boolean;
  tab: MessageChannel;
  onTab: (t: MessageChannel) => void;
  onChange: (ch: MessageChannel, doc: EmailDoc) => void;
  previewCustomerId?: string;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  /** A template picked but not yet confirmed: replacing a draft asks first, in place. */
  const [pick, setPick] = useState<Template | null>(null);
  const catalog = useBlocks();
  useEffect(() => {
    api.templates().then(setTemplates, (e) => reportIssue("warn", "campaign-editor", "templates could not be loaded", { error: String(e) }));
  }, []);
  useEffect(() => {
    setPick(null);
  }, [tab]);
  const tabs = messageTabs(c, tab);
  const channelOf = useMemo(() => channelOfContacts(c.plan), [c.plan?.computedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // Open the biggest channel first when the current tab has nobody.
  useEffect(() => {
    if (!tabs.some((t) => t.key === tab && t.contacts) && tabs[0]?.contacts) onTab(tabs[0].key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.plan?.computedAt]);
  if (c.source === "legacy_newsletter")
    return <p className="p-6 text-[13px] text-ink-500">This newsletter was sent before Kompass, with the same text to everyone: “{c.email.subject.sie}”.</p>;
  const newsletter = c.plan?.summary.by_channel.find((x) => x.key === "newsletter")?.contacts ?? 0;
  const replaceWith = (t: Template) => {
    const fits = (type: string) => {
      const def = catalog?.blocks.find((d) => d.type === type);
      return !def?.channels || def.channels.includes(tab);
    };
    const doc = structuredClone(t.email);
    onChange(tab, tab === "email" ? doc : { ...doc, blocks: doc.blocks.filter((b) => fits(b.type)) });
    setPick(null);
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-ink-200 bg-white px-6 py-2">
        {tabs.map((t) => {
          const meta = MESSAGE_CHANNELS[t.key];
          const on = t.key === tab;
          return (
            <button key={t.key} data-ai={`channel-tab:${t.key}`} title={t.key === "email" && newsletter > 0 ? `Includes ${plural(newsletter, "newsletter contact")}: email and newsletter share this text` : undefined} onClick={() => onTab(t.key)} className={clsx("relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors", on ? "text-navy-950" : "text-ink-600 hover:bg-ink-100")}>
              {on && <motion.span layoutId="message-tab" className="absolute inset-0 rounded-lg bg-navy-50 ring-1 ring-navy-700/30" transition={spring} />}
              <meta.icon size={14} className="relative" />
              <span className="relative">{meta.label}</span>
              <span className="num relative text-[12px] text-ink-400">{fmtInt(t.contacts)}</span>
            </button>
          );
        })}
        {!readOnly && (
          <div className="ml-auto flex items-center gap-2 text-[12.5px] text-ink-500">
            {pick ? (
              <span role="group" aria-label="Replace the message?" className="flex items-center gap-1.5" onKeyDown={(e) => e.key === "Escape" && setPick(null)}>
                <span className="font-medium text-ink-800">
                  Replace the {MESSAGE_CHANNELS[tab].editor} with “{pick.name}”?
                </span>
                <Button size="sm" variant="primary" onClick={() => replaceWith(pick)}>
                  Yes
                </Button>
                <Button size="sm" variant="ghost" autoFocus onClick={() => setPick(null)}>
                  No
                </Button>
              </span>
            ) : (
              <>
                Start from
                <Select value="" className="w-60" onChange={(e) => setPick(templates.find((x) => x.id === e.target.value) ?? null)} options={[{ value: "", label: "a saved template…" }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} />
              </>
            )}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <EmailBuilder
          key={tab}
          channel={tab}
          email={draftOf(c, tab)}
          onChange={(d) => onChange(tab, d)}
          campaignId={c.plan ? c.id : undefined}
          audience={c.audience}
          readOnly={readOnly}
          previewCustomerId={previewCustomerId}
          total={c.plan ? tabs.find((t) => t.key === tab)?.contacts : undefined}
          channelOf={channelOf}
        />
      </div>
    </div>
  );
}

function ResultsStep({ c, onUpdate }: { c: CampaignFull; onUpdate: () => void }) {
  const r = c.results;
  if (!r) return <p className="p-6 text-[13px] text-ink-500">Results appear here after launch.</p>;
  const legacy = c.source === "legacy_newsletter";
  const max = r.funnel[0]?.count || 1;
  return (
    <div className="h-full overflow-y-auto page-scroll px-6 py-5 scroll-thin">
      <div className="max-w-[1040px] space-y-5">
        <div className={clsx("rounded-xl border px-5 py-4", legacy ? "border-ink-200 bg-white" : r.upliftPp > 0 ? "border-good-600/25 bg-good-50" : "border-warn-600/25 bg-warn-50")}>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-semibold text-ink-950">{r.verdict}</div>
              <div className="mt-0.5 text-[12.5px] text-ink-600">
                {legacy
                  ? "Sent to every subscriber with the same text. Without a control group, nobody can tell which sales the newsletter caused."
                  : `Contacted customers converted at ${fmtPct(r.treated.rate, 1)}, the control group at ${fmtPct(r.control.rate, 1)}. 95 % interval ${fmtPp(r.ci95[0])} to ${fmtPp(r.ci95[1])}.`}
                {r.simulated && " Simulated."}
              </div>
            </div>
            {!legacy && (
              <>
                <Figure label="uplift vs control" value={fmtPp(r.upliftPp)} tone={r.upliftPp > 0 ? "good" : "bad"} />
                <Figure label="realised CLV gain" value={fmtDelta(r.realisedDclvEur)} />
                <Figure label="portal visits after contact" value={fmtInt(r.portalVisits)} />
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-[1fr_1fr] gap-5">
          <div className="rounded-xl border border-ink-200 bg-white p-5">
            <div className="mb-3 text-[14px] font-semibold text-ink-950">Funnel</div>
            <div className="space-y-2">
              {r.funnel.map((f) => (
                <div key={f.key} className="text-[13px]">
                  <div className="flex justify-between">
                    <span className="text-ink-700">{f.label}</span>
                    <span className="num text-ink-500">
                      {fmtInt(f.count)} <span className="text-ink-400">({fmtPct(f.count / max, 1)})</span>
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-ink-100">
                    <div className={clsx("h-2 rounded-full", f.key === "unsubscribed" ? "bg-bad-600/70" : "bg-navy-700")} style={{ width: `${Math.max(1, (f.count / max) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-5">
            {!legacy && (
              <div className="rounded-xl border border-ink-200 bg-white p-5">
                <div className="mb-3 text-[14px] font-semibold text-ink-950">Contacted vs control</div>
                <table className="w-full text-[13px]">
                  <thead className="text-left text-[11.5px] uppercase tracking-wider text-ink-400">
                    <tr>
                      <th className="pb-1.5 font-medium" />
                      <th className="pb-1.5 text-right font-medium">Customers</th>
                      <th className="pb-1.5 text-right font-medium">Converted</th>
                      <th className="pb-1.5 text-right font-medium">Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {[
                      ["Contacted", r.treated],
                      ["Control (no message)", r.control],
                    ].map(([l, g]) => {
                      const grp = g as typeof r.treated;
                      return (
                        <tr key={l as string}>
                          <td className="py-1.5 text-ink-700">{l as string}</td>
                          <td className="num py-1.5 text-right">{fmtInt(grp.n)}</td>
                          <td className="num py-1.5 text-right">{fmtInt(grp.conversions)}</td>
                          <td className="num py-1.5 text-right font-medium">{fmtPct(grp.rate, 1)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {r.byTone.length > 0 && (
              <div className="rounded-xl border border-ink-200 bg-white p-5">
                <div className="mb-3 text-[14px] font-semibold text-ink-950">Du vs Sie</div>
                <table className="w-full text-[13px]">
                  <tbody className="divide-y divide-ink-100">
                    {r.byTone.map((t) => (
                      <tr key={t.key}>
                        <td className="py-1.5 text-ink-700">{t.key}</td>
                        <td className="num py-1.5 text-right">{fmtInt(t.contacts)} contacted</td>
                        <td className="num py-1.5 text-right">{t.contacts ? fmtPct(t.opens / t.contacts, 0) : "–"} opened</td>
                        <td className="num py-1.5 text-right font-medium">{t.contacts ? fmtPct(t.conversions / t.contacts, 1) : "–"} converted</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {(r.byOffer.length > 0 || r.orders.length > 0) && (
          <div className="grid grid-cols-2 gap-5">
            {r.byOffer.length > 0 && (
              <div className="rounded-xl border border-ink-200 bg-white p-5">
                <div className="mb-3 text-[14px] font-semibold text-ink-950">By offer</div>
                <table className="w-full text-[13px]">
                  <tbody className="divide-y divide-ink-100">
                    {r.byOffer.map((o) => (
                      <tr key={o.key}>
                        <td className="py-1.5 text-ink-700">{offerLabel(o.key)}</td>
                        <td className="num py-1.5 text-right">{fmtInt(o.contacts)} contacted</td>
                        <td className="num py-1.5 text-right font-medium">{fmtInt(o.conversions)} bought</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {r.orders.length > 0 && (
              <div className="rounded-xl border border-ink-200 bg-white p-5">
                <div className="mb-3 text-[14px] font-semibold text-ink-950">What customers bought</div>
                <ul className="space-y-1 text-[13px]">
                  {r.orders.map((o) => (
                    <li key={o.product} className="flex justify-between">
                      <span className="text-ink-700">{o.product}</span>
                      <span className="num text-ink-500">{fmtInt(o.count)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {!legacy && (
          <div className="rounded-xl border border-violet-600/20 bg-white p-5">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[14px] font-semibold text-ink-950">
                <Sparkles size={15} className="text-violet-600" /> Learnings
              </div>
              <Button size="sm" variant="ghost" icon={Sparkles} onClick={() => askKompass("What should we learn from this campaign's results? Three points: what worked, what did not, what to change next time.")}>
                Ask Kompass
              </Button>
            </div>
            {r.learnings ? <div className="whitespace-pre-line text-[13px] leading-relaxed text-ink-700">{r.learnings}</div> : <p className="text-[12.5px] text-ink-500">Ask Kompass in the bubble below what worked, what did not and what to change next time.</p>}
          </div>
        )}

        <div className="rounded-xl border border-ink-200 bg-white p-5">
          <div className="mb-2 text-[13px] font-semibold text-ink-950">How these numbers come about</div>
          <ul className="list-disc space-y-0.5 pl-5 text-[12.5px] text-ink-500">
            {r.assumptions.map((a) => (
              <li key={a}>{plainNote(a)}</li>
            ))}
          </ul>
        </div>
        {c.status === "running" && (
          <Button
            onClick={async () => {
              await api.finishCampaign(c.id);
              onUpdate();
            }}
          >
            Mark as finished
          </Button>
        )}
      </div>
    </div>
  );
}
