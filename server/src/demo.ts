// Scripted assistant for recorded demos. The language model needs 20–60 s a turn, too slow for a
// video, so with the demo flag on (web: open the app with ?demo=1) a known request plays a fixed
// script in place of the model: the same tool calls the model would make, carried out for real
// (screen actions, tools, cards), and an answer built from what they returned, streamed fast.
// Requests no script knows still go to the real model.
import type { ChatContext } from "../../shared/types.ts";
import type { ScreenSnapshot } from "../../shared/uiActions.ts";
import { liveCustomer, liveState } from "./live.ts";
import type { ToolRound } from "./llm.ts";
import { log } from "./log.ts";

/** What the script has seen so far: the screen after the last screen action and the last result of each tool. */
export interface DemoSeen {
  screen?: ScreenSnapshot;
  results: Record<string, unknown>;
}

type Call = { name: string; args: Record<string, unknown> };
/** One model round: the tool calls to make, or the final answer. */
type Round = (seen: DemoSeen, ctx: ChatContext) => Call[] | string | Promise<Call[] | string>;

export interface DemoScript {
  name: string;
  match: RegExp;
  rounds: Round[];
}

const eur = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n)).toLocaleString("de-DE")} €`;
const CHANNEL_NAMES: Record<string, string> = { email: "Email", sms: "SMS", portal_popup: "Portal pop-up", outbound_call: "Call", call: "Call", newsletter: "Newsletter" };
const channelName = (k: string) => CHANNEL_NAMES[k] ?? k.replace(/_/g, " ");
const data = (seen: DemoSeen) => (seen.screen?.data ?? {}) as Record<string, unknown>;

// ---------- Campaign: "Offer a home wallbox to EV drivers without one, by email and portal pop-up, at each customer's best time" ----------

/** The audience card for EV drivers without a wallbox, from the cards the campaign screen lists ("id = title (n)"). */
function wallboxCard(seen: DemoSeen): string {
  const groups = (data(seen).cards ?? {}) as Record<string, string[]>;
  const line = Object.values(groups)
    .flat()
    .find((l) => /wallbox/i.test(l));
  return line?.split(" = ")[0] ?? "seg:ev_without_wallbox";
}

const EMAIL = {
  channel: "email",
  subject_sie: "Laden Sie Ihr E-Auto doch einfach zu Hause",
  subject_du: "Lade dein E-Auto doch einfach zu Hause",
  blocks: [
    { type: "greeting" },
    {
      type: "text",
      sie: "Sie fahren elektrisch und laden bisher unterwegs. Mit einer eigenen Wallbox laden Sie über Nacht in der Garage: sicher, schnell und günstiger als an der Säule.",
      du: "Du fährst elektrisch und lädst bisher unterwegs. Mit einer eigenen Wallbox lädst du über Nacht in der Garage: sicher, schnell und günstiger als an der Säule.",
    },
    { type: "offer" },
    {
      type: "text",
      sie: "Wir kümmern uns um alles, von der Beratung bis zur Installation durch unseren Fachpartner. Antworten Sie einfach auf diese E-Mail, wenn Sie Fragen haben.",
      du: "Wir kümmern uns um alles, von der Beratung bis zur Installation durch unseren Fachpartner. Antworte einfach auf diese E-Mail, wenn du Fragen hast.",
    },
    { type: "button", sie: "Wallbox ansehen" },
    { type: "footer" },
  ],
};

const POPUP = {
  channel: "portal_popup",
  blocks: [
    { type: "hero", sie: "Zu Hause laden", du: "Zu Hause laden" },
    { type: "greeting" },
    {
      type: "text",
      sie: "Sie laden Ihr E-Auto bisher unterwegs. Mit einer eigenen Wallbox laden Sie über Nacht in der Garage.",
      du: "Du lädst dein E-Auto bisher unterwegs. Mit einer eigenen Wallbox lädst du über Nacht in der Garage.",
    },
    { type: "offer" },
  ],
};

function campaignAnswer(seen: DemoSeen): string {
  const plan = data(seen).plan as { contacts?: number; control?: number; left_out?: number; left_out_why?: string[]; by_channel?: Record<string, number>; expected_dclv_eur?: number } | undefined;
  if (!plan?.contacts) return "The campaign is set up: EV drivers without a wallbox, the Wallbox 11 kW offer, email and portal pop-up, each at their best time. Have a look at the review on screen: nothing is sent until you press the button.";
  const why = (plan.left_out_why ?? []).slice(0, 3).map((w) => w.charAt(0).toLowerCase() + w.slice(1));
  const channels = Object.entries(plan.by_channel ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `**${channelName(k)}** to ${n.toLocaleString("de-DE")}`)
    .join(", ");
  return [
    `Ready for your review: **${plan.contacts.toLocaleString("de-DE")} EV drivers without a wallbox** get the Wallbox 11 kW offer, each at the time of day they are most active.`,
    "",
    `- ${channels || "Email and portal pop-up"}, written in Du and in Sie, matching how each customer writes to us.`,
    `- **${(plan.left_out ?? 0).toLocaleString("de-DE")} left out**, each for a reason${why.length ? `: ${why.join(", ")}` : ""}. The panel on the right lists them all.`,
    `- **${(plan.control ?? 0).toLocaleString("de-DE")} kept as a control group**, so the uplift can be measured afterwards.`,
    `- Expected gain: **${eur(plan.expected_dclv_eur ?? 0)}** customer value.`,
    "",
    "Nothing goes out until you press the button on this screen.",
  ].join("\n");
}

const CAMPAIGN: DemoScript = {
  name: "wallbox campaign",
  match: /wallbox/i,
  rounds: [
    () => [{ name: "navigate", args: { to: "new_campaign", name: "Wallbox for EV drivers" } }],
    (seen) => [
      { name: "pick_audience", args: { card_id: wallboxCard(seen) } },
      { name: "set_offer_mode", args: { mode: "pinned", offer_id: "P-SH-02" } },
    ],
    () => [
      { name: "set_timing", args: { mode: "best" } },
      { name: "set_channels", args: { channels: ["email", "portal_popup"] } },
    ],
    () => [
      { name: "draft_channel", args: EMAIL },
      { name: "draft_channel", args: POPUP },
    ],
    // A moment on the written message before the review, so it can be seen.
    async () => {
      await pause(2600);
      return [{ name: "go_to_step", args: { step: 3 } }];
    },
    campaignAnswer,
  ],
};

// ---------- Service desk: "Summarise this customer for me before I call back" ----------

function onScreenCustomer(seen: DemoSeen, ctx: ChatContext): string | undefined {
  const d = data(seen);
  const pick = (v: unknown) => (typeof v === "string" && /^MG-\d+$/.test(v) ? v : undefined);
  return ctx.customerId ?? pick((d.selected as { customer?: unknown } | null | undefined)?.customer) ?? pick(d.customer);
}

async function serviceAnswer(seen: DemoSeen, ctx: ChatContext): Promise<string> {
  const id = onScreenCustomer(seen, ctx);
  if (!id) return "Pick someone from the queue first, then ask me again.";
  const lc = await liveCustomer(id);
  const desk = liveState().desk.find((x) => x.customerId === id && x.status === "waiting");
  const name = desk?.customerName ?? id;
  const fix = lc.actions.find((a) => a.type === "service");
  const best = lc.actions.find((a) => a.type !== "service");
  const held = lc.blocked.slice(0, 3);
  const today = [...lc.decisions]
    .reverse()
    .slice(-4)
    .map((d) => `${d.at.slice(11, 16)} ${d.eventLabel.charAt(0).toLowerCase()}${d.eventLabel.slice(1)}`);
  return [
    desk ? `**${name}** (${id}) is waiting: ${desk.topic.toLowerCase()}, via ${desk.channel}${desk.mood === "upset" ? ", and upset" : ""}.` : `**${name}** (${id}) has nothing open on the desk.`,
    "",
    fix ? `- **Do first:** ${fix.reason}` : best ? `- **Worth offering:** ${best.product} (${eur(best.dclvEur)} customer value). ${best.reason}` : "- Nothing worth offering today. Help with what they came for.",
    held.length ? `- **Don't sell now:** ${held.map((b) => b.product).join(", ")}. ${held[0].reason.replace(/^exclusion:\s*/i, "Reason: ")}.` : "",
    today.length ? `- **Today:** ${today.join(" · ")}.` : "",
    lc.allowedChannels.length ? `- **May contact by:** ${lc.allowedChannels.map(channelName).join(", ")}.` : "- **No consent** for any marketing channel: service contact only.",
  ]
    .filter((l, i) => l || i === 1)
    .join("\n");
}

const SERVICE: DemoScript = {
  name: "service summary",
  match: /summari[sz]e this customer|before i call (them )?back/i,
  rounds: [
    (seen, ctx) => {
      const id = onScreenCustomer(seen, ctx);
      return id ? [{ name: "live_stream", args: { customer_id: id } }] : [];
    },
    serviceAnswer,
  ],
};

// ---------- Analytics: "Build a chart: which channel beats its control group, split by Du and Sie" ----------

function chartAnswer(seen: DemoSeen): string {
  const d = data(seen);
  return [
    "Here it is: the uplift of each channel over its control group, split by the form of address the offer used.",
    "",
    typeof d.insight === "string" && d.insight ? `- ${d.insight}` : "",
    "- Every bar keeps its sample size; small samples are hatched, so nobody reads too much into them.",
    "",
    "Save it to the board, or tell me what to change.",
  ]
    .filter((l, i) => l || i === 1 || i === 4)
    .join("\n");
}

const ANALYTICS: DemoScript = {
  name: "channel uplift chart",
  match: /which channel beats/i,
  rounds: [
    () => [{ name: "navigate", args: { to: "new_chart" } }],
    () => [{ name: "set_chart", args: { spec: { source: "offers", x: "channel", measures: ["uplift"], chart: "bar" } } }],
    () => [{ name: "add_field", args: { shelf: "split", field: "tone" } }],
    chartAnswer,
  ],
};

// ---------- Customers: "Show customers with an open problem, biggest value at risk first" ----------

function customersAnswer(seen: DemoSeen): string {
  const d = data(seen);
  const total = typeof d.total === "number" ? d.total : null;
  return [
    total != null ? `**${total.toLocaleString("de-DE")} customers** have an open problem right now, with the most value at risk on top.` : "Here are the customers with an open problem, with the most value at risk on top.",
    "",
    "For each of them Kompass suggests fixing the problem before any offer. Open one to see why.",
  ].join("\n");
}

const CUSTOMERS: DemoScript = {
  name: "customers with an open problem",
  match: /open problem/i,
  rounds: [
    () => [{ name: "navigate", args: { to: "customers" } }],
    () => [{ name: "set_filters", args: { problems: true, sort: "value_at_risk" } }],
    customersAnswer,
  ],
};

const SCRIPTS = [CAMPAIGN, SERVICE, ANALYTICS, CUSTOMERS];

/** The script for this request, when the demo flag is on and a script knows it. */
export function demoScript(text: string, ctx: ChatContext): DemoScript | undefined {
  if (!ctx.demo) return undefined;
  const script = SCRIPTS.find((s) => s.match.test(text));
  log.info("assistant", script ? `demo: playing the "${script.name}" script` : "demo: no script for this request, asking the model", { text: text.slice(0, 80) });
  return script;
}

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Stands in for completeWithTools: the script's round, with the answer streamed in small pieces. */
export async function scriptedRound(script: DemoScript, round: number, seen: DemoSeen, ctx: ChatContext, onDelta: (t: string) => void, signal?: AbortSignal): Promise<ToolRound> {
  const step = script.rounds[Math.min(round, script.rounds.length - 1)];
  let out: Call[] | string;
  try {
    out = await step(seen, ctx);
  } catch (e) {
    log.warn("assistant", `demo: "${script.name}" round ${round} failed: ${(e as Error).message}`);
    out = "Something on screen did not go as planned. Have a look, and ask me again.";
  }
  // A short beat per round, so each step shows in the activity card.
  await pause(300, signal);
  if (typeof out !== "string" && out.length) {
    return {
      content: "",
      toolCalls: out.map((c, i) => ({ id: `demo_${Date.now().toString(36)}_${round}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      model: "demo-script",
    };
  }
  const text = typeof out === "string" ? out : "Have a look at the screen.";
  for (const piece of text.match(/[\s\S]{1,4}/g) ?? []) {
    if (signal?.aborted) break;
    onDelta(piece);
    await pause(12, signal);
  }
  return { content: text, toolCalls: [], model: "demo-script" };
}
