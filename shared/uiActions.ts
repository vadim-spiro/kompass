// UI actions the Kompass bubble can perform on screen. The server offers them to the model as
// tools; the browser carries them out where the user can see it and reports back what changed.
// Nothing here can send, approve or launch: those buttons stay with the human.

export type UiView = "any" | "campaign" | "analytics" | "customers" | "customer";

export interface UiActionDef {
  name: string;
  view: UiView;
  /** Plain-language step label shown while it runs. */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  required?: string[];
}

const CHANNELS = ["email", "portal_popup", "sms", "call"];
const BLOCK_TYPES = ["greeting", "last_contact", "service_status", "offer", "savings", "usage", "guarantee", "article", "survey", "hero", "text", "button", "divider", "footer"];

export const UI_ACTIONS: UiActionDef[] = [
  {
    name: "navigate",
    view: "any",
    label: "Opening the screen",
    description:
      "Open a screen for the user. to=new_campaign creates a draft campaign and opens its first step (who & when). Use id for campaign, customer, automation or chart.",
    parameters: {
      to: { type: "string", enum: ["home", "campaigns", "new_campaign", "campaign", "automations", "automation", "customers", "customer", "analytics", "new_chart", "chart", "settings", "templates"] },
      id: { type: "string" },
      name: { type: "string", description: "For new_campaign: a short campaign name." },
    },
    required: ["to"],
  },
  // ---------- Campaign (guided outreach) ----------
  {
    name: "pick_audience",
    view: "campaign",
    label: "Choosing the audience",
    description: "Step 1. Pick one of the ready-made audience cards on screen (ids are in the screen snapshot under cards).",
    parameters: { card_id: { type: "string" } },
    required: ["card_id"],
  },
  {
    name: "refine_audience",
    view: "campaign",
    label: "Fine-tuning the audience",
    description:
      "Step 1. Add filters to the current audience, e.g. {service_case:false} for customers who are not upset, {tonality:'du'}, {value_tiers:['high']}, {min_churn:0.2}, {lacks:['wallbox']}.",
    parameters: { audience: { type: "object" }, label: { type: "string", description: "New plain-language audience name." } },
    required: ["audience"],
  },
  {
    name: "set_offer_mode",
    view: "campaign",
    label: "Choosing what to offer",
    description: "Step 1. engine = best offer per customer; pinned = one specific offer (offer_id); service = no sales offer, service message only.",
    parameters: { mode: { type: "string", enum: ["engine", "pinned", "service"] }, offer_id: { type: "string" } },
    required: ["mode"],
  },
  {
    name: "set_timing",
    view: "campaign",
    label: "Setting the send time",
    description: "Step 1. asap = as soon as approved; fixed = at a date and time (at, ISO); best = each customer's most active time of day.",
    parameters: { mode: { type: "string", enum: ["asap", "fixed", "best"] }, at: { type: "string", description: "ISO date-time for fixed, e.g. 2026-10-29T09:00" } },
    required: ["mode"],
  },
  {
    name: "set_channels",
    view: "campaign",
    label: "Choosing channels",
    description: "Which channels the campaign may use. Each customer still gets only a channel they consented to.",
    parameters: { channels: { type: "array", items: { type: "string", enum: ["email", "portal_popup", "sms", "outbound_call", "newsletter"] } } },
    required: ["channels"],
  },
  {
    name: "go_to_step",
    view: "campaign",
    label: "Moving to the next step",
    description: "Move to step 1 (who & when), 2 (message) or 3 (review & send). Step 3 only shows the review: sending is up to the user.",
    parameters: { step: { type: "number", enum: [1, 2, 3] } },
    required: ["step"],
  },
  {
    name: "draft_channel",
    view: "campaign",
    label: "Writing the message",
    description:
      "Step 2. Write the whole message for one channel as ordered blocks. Smart blocks (greeting, offer, savings, guarantee, last_contact, service_status, usage, article, survey) fill themselves per customer. For text blocks give both tones: sie and du. Email needs a subject and ends with a footer; SMS stays short (greeting, one text, offer or guarantee); call = a script for the agent.",
    parameters: {
      channel: { type: "string", enum: CHANNELS },
      subject_sie: { type: "string" },
      subject_du: { type: "string" },
      blocks: {
        type: "array",
        items: {
          type: "object",
          properties: { type: { type: "string", enum: BLOCK_TYPES }, sie: { type: "string" }, du: { type: "string" }, title: { type: "string" } },
          required: ["type"],
        },
      },
    },
    required: ["channel", "blocks"],
  },
  {
    name: "set_block_text",
    view: "campaign",
    label: "Rewriting a block",
    description: "Step 2. Replace the text of one block (block ids are in the snapshot) in both tones.",
    parameters: { channel: { type: "string", enum: CHANNELS }, block_id: { type: "string" }, sie: { type: "string" }, du: { type: "string" } },
    required: ["channel", "block_id", "sie", "du"],
  },
  {
    name: "add_block",
    view: "campaign",
    label: "Adding a block",
    description: "Step 2. Add one block to a channel's message, optionally after a block id.",
    parameters: { channel: { type: "string", enum: CHANNELS }, type: { type: "string", enum: BLOCK_TYPES }, sie: { type: "string" }, du: { type: "string" }, after: { type: "string" } },
    required: ["channel", "type"],
  },
  {
    name: "remove_block",
    view: "campaign",
    label: "Removing a block",
    description: "Step 2. Remove one block from a channel's message.",
    parameters: { channel: { type: "string", enum: CHANNELS }, block_id: { type: "string" } },
    required: ["channel", "block_id"],
  },
  {
    name: "preview_customer",
    view: "campaign",
    label: "Previewing for a customer",
    description: "Step 2. Show the message as one customer (MG-…) would get it.",
    parameters: { customer_id: { type: "string" }, channel: { type: "string", enum: CHANNELS } },
    required: ["customer_id"],
  },
  // ---------- Analytics ----------
  {
    name: "set_chart",
    view: "analytics",
    label: "Building the chart",
    description:
      "Replace the chart in the builder. spec: {source, x, split, measures[], filters[{field, values[] | min | max}], chart: auto|bar|stacked|line|table|kpi, title}. Field keys are in the snapshot catalog.",
    parameters: { spec: { type: "object" } },
    required: ["spec"],
  },
  {
    name: "add_field",
    view: "analytics",
    label: "Adding to the chart",
    description: "Drop one field on a shelf: x (compare), split (colour), measure (numbers) or filter (only include values).",
    parameters: { shelf: { type: "string", enum: ["x", "split", "measure", "filter"] }, field: { type: "string" }, values: { type: "array", items: {} } },
    required: ["shelf", "field"],
  },
  {
    name: "set_chart_type",
    view: "analytics",
    label: "Changing the chart type",
    description: "auto, bar, stacked, line, table or kpi.",
    parameters: { chart: { type: "string", enum: ["auto", "bar", "stacked", "line", "table", "kpi"] } },
    required: ["chart"],
  },
  // ---------- Customers ----------
  {
    name: "set_filters",
    view: "customers",
    label: "Filtering customers",
    description: "Filter the customer list: q (search text), segment, pain, problems (only customers with an open problem), sort (value_at_risk, clv, churn, best_dclv).",
    parameters: { q: { type: "string" }, segment: { type: "string" }, pain: { type: "string" }, problems: { type: "boolean" }, sort: { type: "string", enum: ["value_at_risk", "clv", "churn", "best_dclv"] } },
  },
  // ---------- Customer 360 ----------
  {
    name: "draft_message",
    view: "customer",
    label: "Drafting a message",
    description:
      "Draft a 1:1 message to the open customer, in their tone. It goes to Approvals; nothing is sent until a person approves it.",
    parameters: { channel: { type: "string", enum: ["email", "sms", "portal_popup"] }, subject: { type: "string" }, text: { type: "string" } },
    required: ["channel", "text"],
  },
];

export const UI_ACTION_NAMES = new Set(UI_ACTIONS.map((a) => a.name));

export function uiActionsFor(view: string | undefined): UiActionDef[] {
  return UI_ACTIONS.filter((a) => a.view === "any" || a.view === view);
}

/** What the page tells the bubble (and the model) about the screen. */
export interface ScreenSnapshot {
  view: string;
  /** Short title for the "sees" chip, e.g. "Campaign · Step 1 · 212 contacts". */
  title: string;
  /** Compact JSON-able state for the model. Keep it small. */
  data?: Record<string, unknown>;
}

export interface UiResult {
  ok: boolean;
  message: string;
  screen?: ScreenSnapshot;
}
