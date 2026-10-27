// Intelligent email blocks. A marketer drops blocks into an email; each smart block fills itself
// per recipient from the insights service (profile, savings, best action) and the customer's own
// service history, and hides when it has nothing true to say. Free text is checked by guardrails.
import type { Block, BlockDef, CustomerProfile, EmailDoc, GuardrailCheck, Identity, RenderedBlock, RenderedEmail, Settings, ShowIf, Tone } from "../../shared/types.ts";
import { checkFreeText, fillCopy, offerCopy, PRICE } from "./copy.ts";
import { overlayProfile } from "./engine.ts";
import { identityFor } from "./identity.ts";
import { getProfile, getVocabulary, queryRows } from "./upstream.ts";

export const SNAPSHOT = new Date("2026-09-30T23:59:00");

// ---------- Catalog ----------

const ALL = ["email", "portal_popup", "sms", "call"];
export const BUILTIN_BLOCKS: BlockDef[] = [
  { type: "greeting", label: "Greeting", group: "smart", icon: "hand", description: "Du or Sie, as the customer writes to us, with their name.", defaults: {}, source: "Tone detected from the customer's own messages", channels: ALL },
  { type: "last_contact", label: "Last contact recap", group: "smart", icon: "history", description: "“You wrote to us on 28.08. about your installment – that is sorted.” Hidden if there was no recent contact.", defaults: { maxDays: 120 }, source: "Service tickets and calls", channels: ["email", "portal_popup", "call"] },
  { type: "service_status", label: "Open issue", group: "smart", icon: "life-buoy", description: "Only for customers with an open case. Replaces any offer: service first.", defaults: {}, source: "Open tickets, complaints, failed charging", channels: ALL },
  { type: "offer", label: "Recommended offer", group: "smart", icon: "sparkles", description: "The engine's best action for this customer (highest expected CLV gain). Hidden when sales are not allowed.", defaults: { mode: "engine" }, source: "dCLV decision of the insights service", channels: ALL },
  { type: "savings", label: "Your savings", group: "smart", icon: "piggy-bank", description: "A real saving computed from the customer's own contract and usage.", defaults: { allowAssumptions: false }, source: "Savings computed from contracts and usage", channels: ALL },
  { type: "usage", label: "Usage insight", group: "smart", icon: "gauge", description: "Consumption, charging sessions or solar self-consumption, whatever this customer has.", defaults: {}, source: "Contracts, charging sessions, HEMS", channels: ["email", "portal_popup", "call"] },
  { type: "guarantee", label: "Price guarantee date", group: "smart", icon: "calendar", description: "States the date the price guarantee ends. Factual, no countdown.", defaults: { withinDays: 120 }, source: "Energy contract", channels: ALL },
  { type: "objections", label: "Likely objections", group: "smart", icon: "message-circle", description: "What this customer may say, from their own pains, with a fair answer for the agent.", defaults: {}, source: "The customer's pains and the cases the service team solved well", channels: ["call"] },
  { type: "article", label: "Helpful article", group: "smart", icon: "book-open", description: "A MAINGAU guide that matches the customer's situation.", defaults: { topic: "auto" }, source: "maingau-energie.de/blog, matched to products and pains", channels: ["email", "portal_popup"] },
  { type: "survey", label: "Feedback survey", group: "smart", icon: "star", description: "1–5 rating, optionally with a €5 shop voucher as a thank-you.", defaults: { question: "Wie zufrieden sind Sie mit MAINGAU?", questionDu: "Wie zufrieden bist du mit MAINGAU?", voucher: false, voucherEur: 5 }, source: "Static, answers flow back as feedback", channels: ["email"] },
  { type: "hero", label: "Header", group: "content", icon: "image", description: "Coloured header with a title.", defaults: { title: "Neuigkeiten für Sie", titleDu: "Neuigkeiten für dich", style: "green" }, source: "", channels: ["email", "portal_popup"] },
  { type: "text", label: "Text", group: "content", icon: "type", description: "Your own text in a Du and a Sie version, with an optional heading. Placeholders like {{vorname}} work.", defaults: { sie: "", du: "" }, source: "", channels: ALL },
  { type: "button", label: "Button / link", group: "content", icon: "mouse-pointer", description: "A call-to-action button; in an SMS a short link.", defaults: { label: "Mehr erfahren", url: "https://www.maingau-energie.de" }, source: "", channels: ["email", "portal_popup", "sms"] },
  { type: "divider", label: "Divider", group: "content", icon: "minus", description: "A thin line.", defaults: {}, source: "", channels: ["email"] },
  { type: "footer", label: "Footer", group: "content", icon: "align-bottom", description: "Sign-off, legal notice and unsubscribe link (required for email).", defaults: {}, source: "Brand voice settings", channels: ["email"] },
];

export function blockCatalog(settings: Settings): BlockDef[] {
  return [
    ...BUILTIN_BLOCKS,
    ...settings.customBlocks.map<BlockDef>((c) => ({
      type: `custom:${c.id}`,
      label: c.name,
      group: "custom",
      icon: "puzzle",
      description: c.description,
      defaults: {},
      source: "Custom block from Settings",
      channels: ["email", "portal_popup", "call"],
    })),
  ];
}

// ---------- Recipient context ----------

export interface Ticket {
  ticket_id: string;
  channel: string;
  category: string;
  status: string;
  resolution_code: string | null;
  created_at: string;
  csat_1to5: number | null;
}

export interface Recipient {
  id: string;
  identity: Identity;
  tone: Tone;
  profile: CustomerProfile;
  f: Record<string, unknown>;
  tickets: Ticket[];
}

const recipients = new Map<string, Promise<Recipient>>();

/** The customer as of the live clock: the snapshot with the event stream's facts and the live ranking applied. */
export function loadRecipient(id: string): Promise<Recipient> {
  return rawRecipient(id).then((r) => {
    const profile = overlayProfile(id, r.profile);
    return { ...r, profile, f: { ...profile.features, ...flat(profile) } };
  });
}

/** The customer as the 30.09. snapshot knows them (cached). */
export function rawRecipient(id: string): Promise<Recipient> {
  let p = recipients.get(id);
  if (!p) {
    p = (async () => {
      const [profile, tickets] = await Promise.all([
        getProfile(id),
        queryRows<Ticket>("service_tickets", ["ticket_id", "channel", "category", "status", "resolution_code", "created_at", "csat_1to5"], [{ field: "customer_id", value: id }], 50)
          .then((r) => r.rows)
          .catch(() => [] as Ticket[]),
      ]);
      tickets.sort((a, b) => b.created_at.localeCompare(a.created_at));
      const tone: Tone = profile.summary.tonality === "du" ? "du" : "sie";
      return { id, profile, tickets, tone, f: { ...profile.features, ...flat(profile) }, identity: identityFor(id, profile.summary.city) };
    })();
    p.catch(() => recipients.delete(id));
    recipients.set(id, p);
  }
  return p;
}

/** Fields usable in "show only if" rules, beyond the raw features. */
function flat(p: CustomerProfile): Record<string, unknown> {
  const s = p.summary;
  return {
    service_case: s.service_case,
    value_tier: s.value_tier,
    tonality: s.tonality,
    segments: s.segments,
    personas: s.personas,
    pains: s.pains,
    clv_eur: s.clv_eur,
    churn_prob_12m: s.churn_prob_12m,
    products: s.products,
    sales_allowed: p.contact_policy.sales_allowed,
    best_offer: s.best_action?.offer_id ?? null,
    has_saving: p.savings.some((x) => x.basis === "data"),
  };
}

export const SHOW_IF_FIELDS: { field: string; label: string; kind: "bool" | "number" | "text" | "list" }[] = [
  { field: "service_case", label: "Has an open service case", kind: "bool" },
  { field: "sales_allowed", label: "Sales allowed", kind: "bool" },
  { field: "value_tier", label: "Value tier", kind: "text" },
  { field: "tonality", label: "Tone (du/sie)", kind: "text" },
  { field: "segments", label: "Segment", kind: "list" },
  { field: "pains", label: "Pain", kind: "list" },
  { field: "products", label: "Product held", kind: "list" },
  { field: "clv_eur", label: "CLV (€)", kind: "number" },
  { field: "churn_prob_12m", label: "Churn probability", kind: "number" },
  { field: "has_mobile", label: "Has mobile", kind: "bool" },
  { field: "has_autostrom", label: "Has Autostrom", kind: "bool" },
  { field: "ev_driver", label: "Drives an EV", kind: "bool" },
  { field: "owns_wallbox", label: "Owns a wallbox", kind: "bool" },
  { field: "has_heat_pump", label: "Has a heat pump", kind: "bool" },
  { field: "smart_meter", label: "Has a smart meter", kind: "bool" },
  { field: "app_installed", label: "Has the app", kind: "bool" },
  { field: "has_saving", label: "Has a real saving", kind: "bool" },
  { field: "price_guarantee_ends_in_days", label: "Days until guarantee ends", kind: "number" },
  { field: "household_size", label: "Household size", kind: "number" },
];

export function evalShowIf(rules: ShowIf[] | undefined, f: Record<string, unknown>): { ok: boolean; failed?: string } {
  for (const r of rules ?? []) {
    const v = f[r.field];
    const want = r.value;
    let ok = true;
    switch (r.op) {
      case "is":
        ok = Array.isArray(v) ? v.includes(want) : String(v) === String(want);
        break;
      case "is_not":
        ok = Array.isArray(v) ? !v.includes(want) : String(v) !== String(want);
        break;
      case "gt":
        ok = typeof v === "number" && v > Number(want);
        break;
      case "lt":
        ok = typeof v === "number" && v < Number(want);
        break;
      case "contains":
        ok = Array.isArray(v) ? v.some((x) => String(x).toLowerCase().includes(String(want).toLowerCase())) : String(v ?? "").toLowerCase().includes(String(want).toLowerCase());
        break;
      case "not_contains":
        ok = Array.isArray(v) ? !v.some((x) => String(x).toLowerCase().includes(String(want).toLowerCase())) : !String(v ?? "").toLowerCase().includes(String(want).toLowerCase());
        break;
      case "exists":
        ok = v != null && v !== false && !(Array.isArray(v) && v.length === 0);
        break;
      case "not_exists":
        ok = v == null || v === false || (Array.isArray(v) && v.length === 0);
        break;
    }
    if (!ok) return { ok: false, failed: `${r.field} ${r.op.replace("_", " ")}${want !== undefined ? ` ${want}` : ""}` };
  }
  return { ok: true };
}

// ---------- Helpers ----------

const dateDe = (d: Date | string) => {
  const x = typeof d === "string" ? new Date(d) : d;
  return `${String(x.getDate()).padStart(2, "0")}.${String(x.getMonth() + 1).padStart(2, "0")}.${x.getFullYear()}`;
};
const shortDate = (d: string) => dateDe(d).slice(0, 6);
const eur = (n: number) => `${Math.round(n).toLocaleString("de-DE")} €`;
const num = (n: number) => Math.round(n).toLocaleString("de-DE");
const pick = (tone: Tone, sie: string, du: string) => (tone === "du" ? du : sie);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const TOPIC: Record<string, { sie: string; du: string }> = {
  billing: { sie: "Ihrer Rechnung bzw. Ihres Abschlags", du: "deiner Rechnung bzw. deines Abschlags" },
  tariff: { sie: "Ihres Tarifs", du: "deines Tarifs" },
  moving: { sie: "Ihres Umzugs", du: "deines Umzugs" },
  meter: { sie: "Ihres Zählerstands", du: "deines Zählerstands" },
  autostrom: { sie: "Ihrer Ladevorgänge mit Autostrom", du: "deiner Ladevorgänge mit Autostrom" },
  complaint: { sie: "Ihrer Beschwerde", du: "deiner Beschwerde" },
  mobile: { sie: "Ihres Mobilfunkvertrags", du: "deines Mobilfunkvertrags" },
  hems: { sie: "Ihres Energiemanagers", du: "deines Energiemanagers" },
  smart_living: { sie: "Ihres Energiemanagers", du: "deines Energiemanagers" },
  shop: { sie: "Ihrer Bestellung", du: "deiner Bestellung" },
};
const VIA: Record<string, string> = { phone: "telefonisch", email: "per E-Mail", chat: "im Chat", contact_form: "über das Kontaktformular", portal: "über das Kundenportal", app: "über die App", social: "über Social Media" };

const SAVING_DE: Record<string, { sie: (s: number) => string; du: (s: number) => string }> = {
  electricity_tariff: { sie: (s) => `Mit dem Tarif StromAktiv zahlen Sie für denselben Strom rund ${eur(s)} weniger im Jahr.`, du: (s) => `Mit dem Tarif StromAktiv zahlst du für denselben Strom rund ${eur(s)} weniger im Jahr.` },
  heat_pump_tariff: { sie: (s) => `Für Ihre Wärmepumpe spart der Tarif StromWärme rund ${eur(s)} im Jahr.`, du: (s) => `Für deine Wärmepumpe spart der Tarif StromWärme rund ${eur(s)} im Jahr.` },
  gas_tariff: { sie: (s) => `Nach dem Ende Ihrer Preisgarantie sparen Sie mit GasAktiv rund ${eur(s)} im Jahr.`, du: (s) => `Nach dem Ende deiner Preisgarantie sparst du mit GasAktiv rund ${eur(s)} im Jahr.` },
  mobile_downsize: { sie: (s) => `Ein kleinerer Mobilfunktarif reicht für Ihre Nutzung und spart rund ${eur(s)} im Jahr.`, du: (s) => `Ein kleinerer Mobilfunktarif reicht für deine Nutzung und spart rund ${eur(s)} im Jahr.` },
  balcony_pv: { sie: (s) => `Ein Balkonkraftwerk kann Ihre Stromrechnung um rund ${eur(s)} im Jahr senken.`, du: (s) => `Ein Balkonkraftwerk kann deine Stromrechnung um rund ${eur(s)} im Jahr senken.` },
  dynamic_tariff: { sie: (s) => `Mit dem dynamischen Tarif sparen Sie bei flexiblem Verbrauch rund ${eur(s)} im Jahr.`, du: (s) => `Mit dem dynamischen Tarif sparst du bei flexiblem Verbrauch rund ${eur(s)} im Jahr.` },
  charging_refund: { sie: (s) => `Fehlgeschlagene Ladevorgänge, die berechnet wurden, erstatten wir Ihnen: ${eur(s)}.`, du: (s) => `Fehlgeschlagene Ladevorgänge, die berechnet wurden, erstatten wir dir: ${eur(s)}.` },
};

const ARTICLES: { key: string; title: string; url: string; match: (r: Recipient) => boolean }[] = [
  { key: "wallbox", title: "Zuhause eine Wallbox installieren", url: "https://www.maingau-energie.de/blog/wallbox-zuhause-installieren", match: (r) => !!r.f.ev_driver && !r.f.owns_wallbox },
  { key: "heat_pump", title: "Neues Gesetz für Wärmepumpen und Wallboxen", url: "https://www.maingau-energie.de/blog/guenstigere-stromrechnung-wallbox-waermepumpe", match: (r) => !!r.f.has_heat_pump || !!r.f.gas_meter_deregistered },
  { key: "charging", title: "Schlaue Ladestrategien", url: "https://www.maingau-energie.de/blog/schlaue-ladestrategien", match: (r) => !!r.f.has_autostrom },
  { key: "moving", title: "Woran muss man bei einem Umzug denken?", url: "https://www.maingau-energie.de/blog/umzug", match: (r) => r.profile.summary.pains.includes("moving") },
  { key: "smart_meter", title: "Intelligente Stromversorgung mit einem Smart Meter", url: "https://www.maingau-energie.de/blog/intelligente-stromversorgung-mit-smart-meter", match: (r) => !!r.f.smart_meter },
  { key: "balcony", title: "Alles Wichtige zu Mini-PV-Anlagen", url: "https://www.maingau-energie.de/blog/balkonkraftwerke", match: (r) => r.profile.savings.some((s) => s.kind === "balcony_pv") },
  { key: "data", title: "Datenvolumen sparen im Urlaub", url: "https://www.maingau-energie.de/blog/datenvolumen-sparen", match: (r) => r.profile.summary.pains.includes("data_volume") },
  { key: "prices", title: "Was ändert sich 2026 bei Strom und Gas?", url: "https://www.maingau-energie.de/blog/was-aendert-sich-2026-bei-strom-und-gas", match: (r) => !!r.f.has_energy },
];

const OFFER_ARTICLE: Record<string, string> = { "P-EN-03": "heat_pump", "P-AS-01": "wallbox", "P-SL-01": "smart_meter", "P-EN-05": "smart_meter", "P-SH-01": "balcony" };

const OFFER_URL: Record<string, string> = {
  "P-EN": "https://www.maingau-energie.de/strom",
  "P-MO": "https://www.maingau-energie.de/mobilfunk",
  "P-IN": "https://www.maingau-energie.de/internet",
  "P-SL": "https://www.maingau-energie.de/smart-living",
  "P-SH": "https://shop.maingau-energie.de",
  "P-AS": "https://www.maingau-energie.de/autostrom",
};

/** Placeholders usable in text blocks, custom blocks and AI paragraphs. */
export const PLACEHOLDERS = ["vorname", "nachname", "name", "stadt", "kunde_seit", "produkt", "tarif", "garantie_ende", "ersparnis", "angebot"];

function placeholders(r: Recipient): Record<string, string> {
  const s = r.profile.summary;
  const tariffs = (r.f.energy_tariffs as string[] | undefined) ?? [];
  const saving = r.profile.savings.filter((x) => x.basis === "data").sort((a, b) => b.annual_saving_eur - a.annual_saving_eur)[0];
  const days = r.f.price_guarantee_ends_in_days as number | null | undefined;
  return {
    vorname: r.identity.firstName,
    nachname: r.identity.lastName,
    name: r.identity.name,
    stadt: s.city ?? "",
    kunde_seit: String(r.f.customer_since ?? "").slice(0, 4),
    produkt: s.products[0] ?? "MAINGAU",
    tarif: tariffs[0] ?? s.products[0] ?? "",
    garantie_ende: days != null ? dateDe(new Date(SNAPSHOT.getTime() + days * 86400000)) : "",
    ersparnis: saving ? eur(saving.annual_saving_eur) : "",
    angebot: s.best_action?.product_name ?? "",
  };
}

const fillPh = (text: string, ph: Record<string, string>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => ph[k] ?? "");

// ---------- Rendering ----------

interface Ctx {
  r: Recipient;
  tone: Tone;
  settings: Settings;
  ph: Record<string, string>;
  /** Set when a service block rendered, so the offer block steps aside. */
  serviceShown: boolean;
  offerShown: string | null;
  offerName?: string;
  checks: GuardrailCheck[];
  /** Event that triggered this message (automations): a fresh signal the 30.09 snapshot does not have. */
  signal?: string;
  /** The campaign's chosen offers ("a specific offer"): an offer block left on the engine's pick shows the best of these instead. */
  offerIds?: string[];
  offerNames: Record<string, string>;
  /** Message channel: e-mail and newsletter render in full, SMS short, calls as a script for the agent. */
  channel: string;
}

function hidden(b: Block, reason: string): RenderedBlock {
  return { id: b.id, type: b.type, visible: false, hiddenReason: reason, text: "" };
}

const isSms = (c: Ctx) => c.channel === "sms";
/** How the customer answers on this channel: an email can be replied to, a pop-up or an SMS cannot. */
function replyHint(c: Ctx, tone: Tone) {
  if (c.channel === "sms") return pick(tone, "rufen Sie uns gern an", "ruf uns gern an");
  if (c.channel === "portal_popup" || c.channel === "app_push") return pick(tone, "schreiben Sie uns gern über das Kundenportal", "schreib uns gern über das Kundenportal");
  if (c.channel === "outbound_call") return "das klären wir gern gleich am Telefon";
  return pick(tone, "antworten Sie einfach auf diese E-Mail", "antworte einfach auf diese E-Mail");
}
const isCall = (c: Ctx) => c.channel === "outbound_call" || c.channel === "service_contact" || c.channel === "call";
const NOT_IN: Record<string, string[]> = { sms: ["hero", "divider", "footer", "article", "survey", "usage", "last_contact"], call: ["hero", "divider", "footer", "button", "survey", "article"] };

/** What the customer may say on the phone, from their pains, with a fair answer. Static copy, no customer text. */
function objectionsFor(r: Recipient, tone: Tone) {
  const p = r.profile.summary.pains;
  const saving = r.profile.savings.find((x) => x.basis === "data" && x.annual_saving_eur > 0);
  const out: { say: string; answer: string }[] = [];
  if (p.includes("price_concern") || p.includes("bill_shock"))
    out.push({
      say: "Das ist mir zu teuer.",
      answer: saving
        ? pick(tone, `Verständlich. Laut Ihrem Verbrauch sparen Sie mit dem passenden Tarif rund ${eur(saving.annual_saving_eur)} im Jahr.`, `Verständlich. Laut deinem Verbrauch sparst du mit dem passenden Tarif rund ${eur(saving.annual_saving_eur)} im Jahr.`)
        : pick(tone, "Verständlich. Wir schauen gemeinsam, ob Ihr Abschlag zu Ihrem Verbrauch passt.", "Verständlich. Wir schauen gemeinsam, ob dein Abschlag zu deinem Verbrauch passt."),
    });
  if (p.includes("no_answer") || p.includes("upset"))
    out.push({ say: "Ich warte schon ewig auf eine Antwort.", answer: pick(tone, "Das tut mir leid. Ich kümmere mich jetzt persönlich darum und sage Ihnen, bis wann Sie von uns hören.", "Das tut mir leid. Ich kümmere mich jetzt persönlich darum und sage dir, bis wann du von uns hörst.") });
  if (p.includes("charging_failure") || p.includes("charging_bill"))
    out.push({ say: "Das Laden hat nicht funktioniert.", answer: pick(tone, "Fehlerhaft berechnete Ladevorgänge erstatten wir automatisch. Ich prüfe die Sitzungen gern mit Ihnen.", "Fehlerhaft berechnete Ladevorgänge erstatten wir automatisch. Ich prüfe die Sitzungen gern mit dir.") });
  if (p.includes("moving")) out.push({ say: "Ich ziehe bald um.", answer: pick(tone, "Ihren Vertrag nehmen Sie einfach mit. Wir brauchen nur die neue Adresse und den Zählerstand.", "Deinen Vertrag nimmst du einfach mit. Wir brauchen nur die neue Adresse und den Zählerstand.") });
  if (p.includes("data_volume")) out.push({ say: "Mein Datenvolumen reicht nicht.", answer: pick(tone, "Sie können jederzeit in einen größeren Tarif wechseln, ohne neue Laufzeit.", "Du kannst jederzeit in einen größeren Tarif wechseln, ohne neue Laufzeit.") });
  out.push({ say: "Ich habe gerade keine Zeit.", answer: pick(tone, "Kein Problem. Wann passt es Ihnen besser? Ich rufe gern zurück.", "Kein Problem. Wann passt es dir besser? Ich rufe gern zurück.") });
  out.push({ say: "Ich möchte keine Anrufe.", answer: pick(tone, "Verstanden, ich vermerke das sofort. Sie bekommen von uns keine Werbeanrufe mehr.", "Verstanden, ich vermerke das sofort. Du bekommst von uns keine Werbeanrufe mehr.") });
  return out.slice(0, 4);
}

function renderBlock(b: Block, c: Ctx): RenderedBlock {
  const { r, tone } = c;
  const not = NOT_IN[isCall(c) ? "call" : c.channel];
  if (not?.includes(b.type)) return hidden(b, `Not used in ${isCall(c) ? "a call script" : c.channel.replace("_", " ")}`);
  const s = r.profile.summary;
  const cond = evalShowIf(b.showIf, r.f);
  if (!cond.ok) return hidden(b, `Rule not met: ${cond.failed}`);
  const p = b.props;
  const show = (text: string, extra: Partial<RenderedBlock> = {}): RenderedBlock => ({ id: b.id, type: b.type, visible: true, text, ...extra });

  switch (b.type) {
    case "greeting":
      if (isCall(c))
        return show(pick(tone, `Guten Tag ${r.identity.firstName} ${r.identity.lastName}, hier spricht [Ihr Name] von MAINGAU Energie. Haben Sie zwei Minuten?`, `Hallo ${r.identity.firstName}, hier ist [dein Name] von MAINGAU Energie. Hast du zwei Minuten?`), {
          title: "Begrüßung",
          source: `${tone === "du" ? "Du" : "Sie"}, as the customer writes to us`,
        });
      // An SMS reads as one line, so the greeting ends the sentence instead of opening a letter.
      return show(pick(tone, `Guten Tag ${r.identity.firstName} ${r.identity.lastName}${isSms(c) ? "!" : ","}`, `Hallo ${r.identity.firstName}${isSms(c) ? "!" : ","}`), {
        source: r.profile.contact_policy.tone_observed ? `${tone === "du" ? "Du" : "Sie"}: detected from the customer's messages` : "Sie: default (no own messages yet)",
      });

    case "last_contact": {
      const maxDays = Number(p.maxDays ?? 120);
      const t = r.tickets.find((x) => (SNAPSHOT.getTime() - new Date(x.created_at).getTime()) / 86400000 <= maxDays);
      if (!t) return hidden(b, `No contact in the last ${maxDays} days`);
      const topic = TOPIC[t.category]?.[tone] ?? pick(tone, "Ihres Anliegens", "deines Anliegens");
      const via = VIA[t.channel] ?? "";
      const open = t.status !== "closed" && t.status !== "resolved";
      const lead = pick(tone, `Sie hatten uns am ${shortDate(t.created_at)} ${via} wegen ${topic} kontaktiert.`, `Du hattest uns am ${shortDate(t.created_at)} ${via} wegen ${topic} kontaktiert.`).replace("  ", " ");
      const tail = open
        ? pick(tone, "Wir sind weiter für Sie dran und melden uns persönlich.", "Wir sind weiter für dich dran und melden uns persönlich.")
        : pick(tone, "Danke, dass Sie sich gemeldet haben – das Anliegen ist erledigt.", "Danke, dass du dich gemeldet hast – das Anliegen ist erledigt.");
      return show(`${lead} ${tail}`, { source: `Ticket ${t.ticket_id} (${t.category}, ${t.channel}, ${t.status})` });
    }

    case "service_status": {
      if (!s.service_case) return hidden(b, "No open service case");
      const parts: string[] = [];
      const openT = r.tickets.find((x) => x.status === "open");
      if (r.f.open_complaint || openT) {
        parts.push(
          openT
            ? pick(tone, `Ihr Anliegen vom ${shortDate(openT.created_at)} ist noch offen. Eine Kollegin oder ein Kollege aus dem Kundenservice meldet sich persönlich bei Ihnen.`, `Dein Anliegen vom ${shortDate(openT.created_at)} ist noch offen. Jemand aus unserem Kundenservice meldet sich persönlich bei dir.`)
            : pick(tone, "Ihr Anliegen ist bei uns noch offen. Wir melden uns persönlich bei Ihnen.", "Dein Anliegen ist bei uns noch offen. Wir melden uns persönlich bei dir."),
        );
      }
      if (s.pains.includes("no_answer")) parts.unshift(pick(tone, "Es tut uns leid, dass Sie auf eine Antwort warten mussten.", "Es tut uns leid, dass du auf eine Antwort warten musstest."));
      const failed = Number(r.f.failed_charges_30d ?? 0);
      const refund = Number(r.f.billed_failed_charges_eur ?? 0);
      if (failed >= 1)
        parts.push(
          refund > 0
            ? pick(tone, `Wir haben gesehen, dass zuletzt Ladevorgänge nicht geklappt haben. Fehlerhaft berechnete Ladevorgänge erstatten wir Ihnen automatisch.`, `Wir haben gesehen, dass zuletzt Ladevorgänge nicht geklappt haben. Fehlerhaft berechnete Ladevorgänge erstatten wir dir automatisch.`)
            : pick(tone, "Wir haben gesehen, dass zuletzt Ladevorgänge nicht geklappt haben, und kümmern uns darum.", "Wir haben gesehen, dass zuletzt Ladevorgänge nicht geklappt haben, und kümmern uns darum."),
        );
      if (Number(r.f.max_dunning_level ?? 0) >= 1)
        parts.push(`${pick(tone, "Bei Fragen zu Rechnung oder Abschlag finden wir gemeinsam eine Lösung", "Bei Fragen zu Rechnung oder Abschlag finden wir gemeinsam eine Lösung")} – ${replyHint(c, tone)}.`);
      if (r.f.cancellation_pending) parts.push(pick(tone, "Wir haben Ihre Kündigung erhalten. Wenn Sie möchten, rufen wir Sie an und schauen gemeinsam, ob wir etwas besser machen können.", "Wir haben deine Kündigung erhalten. Wenn du magst, rufen wir dich an und schauen gemeinsam, ob wir etwas besser machen können."));
      if (!parts.length) parts.push(pick(tone, "Wir kümmern uns gerade um Ihr Anliegen und melden uns bei Ihnen.", "Wir kümmern uns gerade um dein Anliegen und melden uns bei dir."));
      c.serviceShown = true;
      const text = isSms(c) ? parts.slice(0, 2).join(" ") : parts.join(" ");
      return show(text, { title: isCall(c) ? "Anlass: offenes Anliegen" : pick(tone, "Ihr Anliegen", "Dein Anliegen"), source: `Service case: ${s.sales_blockers.join(", ") || "open ticket"}` });
    }

    case "offer": {
      if (c.serviceShown) return hidden(b, "Service first: the open issue is shown instead");
      if (s.service_case) return hidden(b, `Sales blocked: ${s.sales_blockers.join(", ") || "open service case"}`);
      // A block pinned to one offer wins; otherwise a campaign with chosen offers shows the best of those for this customer.
      const pins = p.mode === "pinned" && typeof p.offerId === "string" ? [p.offerId as string] : (c.offerIds ?? []);
      const all = [...r.profile.recommended_actions, ...r.profile.suppressed_actions];
      const candidates = all.filter((a) => pins.includes(a.offer_id)).sort((a, z) => Number(!!a.blocked_by) - Number(!!z.blocked_by) || z.dclv_eur - a.dclv_eur);
      const action = pins.length ? candidates[0] : r.profile.recommended_actions.find((a) => a.action_type !== "service");
      const pinned = pins.length ? (action?.offer_id ?? pins[0]) : null;
      const offerBlock = (offerId: string, name: string, source: string) => {
        const copy = offerCopy(offerId, tone);
        if (!copy) return hidden(b, "No approved copy for this offer");
        const vars = { guarantee_end: c.ph.garantie_ende || undefined, lines: s.products.join(", ") || undefined };
        c.offerShown = offerId;
        c.offerName = name;
        const url = OFFER_URL[offerId.slice(0, 4)] ?? "https://www.maingau-energie.de";
        const body = fillCopy(copy.body, vars);
        if (isSms(c)) return show(`${fillCopy(copy.short, vars)} ${url.replace(/^https:\/\/(www\.)?/, "")}`, { source });
        return show(body, {
          title: isCall(c) ? `Angebot und Nutzen: ${name}` : fillCopy(copy.subject, vars),
          ...(isCall(c) ? {} : { cta: { label: copy.cta, url } }),
          source,
        });
      };
      if (pinned && !action) {
        const name = c.offerNames[pinned] ?? pinned;
        const held = s.products.some((x) => x.toLowerCase() === name.toLowerCase());
        const policy = r.profile.contact_policy;
        if (held) return hidden(b, `Already holds ${name}`);
        // The triggering event is the signal the snapshot does not have yet (e.g. gas meter deregistered → StromWärme).
        if (c.signal && policy.sales_allowed && policy.profiling_allowed) return offerBlock(pinned, name, `${name}: signal from the ${c.signal.replace(/_/g, " ")} event (after the data snapshot, no CLV estimate yet)`);
        return hidden(b, c.signal ? `Not eligible for ${name}: ${policy.profiling_allowed ? "sales not allowed" : "no profiling consent"}` : `Not eligible for ${name} (no signal in the 30.09 data)`);
      }
      if (!action) return hidden(b, "No offer with a positive expected CLV gain: stay silent");
      if (action.blocked_by) return hidden(b, `Blocked: ${action.blocked_by}`);
      if (action.dclv_eur <= 0) return hidden(b, `Expected CLV gain ${action.dclv_eur.toFixed(2).replace(".", ",")} € ≤ 0`);
      return offerBlock(action.offer_id, action.product_name, `${action.product_name}: +${action.dclv_eur.toFixed(0)} € expected CLV · ${action.reason}`);
    }

    case "savings": {
      const kinds = (p.kinds as string[] | undefined) ?? null;
      const list = r.profile.savings
        .filter((x) => (p.allowAssumptions ? true : x.basis === "data"))
        .filter((x) => !kinds || kinds.includes(x.kind))
        .filter((x) => SAVING_DE[x.kind] && (x.annual_saving_eur > 0 || x.one_off_saving_eur > 0))
        .sort((a, b) => b.annual_saving_eur + b.one_off_saving_eur - (a.annual_saving_eur + a.one_off_saving_eur));
      // A saving that needs a tariff or product change is a sales message: not while sales are
      // paused. A refund of billed failed charging is service and always allowed.
      const salesOk = r.profile.contact_policy.sales_allowed && !c.serviceShown;
      const top = list.find((x) => salesOk || x.kind === "charging_refund");
      if (!top && list.length) return hidden(b, "Saving needs a product change; sales are paused (service first)");
      if (!top) return hidden(b, p.allowAssumptions ? "No saving found for this customer" : "No saving computed from the customer's own data");
      const amount = top.annual_saving_eur || top.one_off_saving_eur;
      return show(SAVING_DE[top.kind][tone](amount), {
        title: pick(tone, "Gut zu wissen", "Gut zu wissen"),
        source: `${top.title} (${top.basis === "data" ? "from own data" : "typical value"}): ${top.explanation}`,
      });
    }

    case "usage": {
      const kwh = Number(r.f.annual_consumption_kwh ?? 0);
      const sessions = Number(r.f.charge_sessions ?? 0);
      const charged = Number(r.f.charged_kwh ?? 0);
      const self = r.f.self_consumption_rate as number | null;
      if (self != null) return show(pick(tone, `Ihre Solaranlage deckt derzeit rund ${Math.round(self * 100)} % Ihres Stroms selbst.`, `Deine Solaranlage deckt derzeit rund ${Math.round(self * 100)} % deines Stroms selbst.`), { source: "HEMS telemetry" });
      if (sessions > 0) return show(pick(tone, `Seit Juni haben Sie ${sessions}-mal mit Autostrom geladen, zusammen ${num(charged)} kWh.`, `Seit Juni hast du ${sessions}-mal mit Autostrom geladen, zusammen ${num(charged)} kWh.`), { source: "Charging sessions" });
      if (kwh > 0) return show(pick(tone, `Ihr Stromverbrauch liegt bei rund ${num(kwh)} kWh im Jahr.`, `Dein Stromverbrauch liegt bei rund ${num(kwh)} kWh im Jahr.`), { source: "Energy contract" });
      return hidden(b, "No usage data for this customer");
    }

    case "guarantee": {
      const days = r.f.price_guarantee_ends_in_days as number | null | undefined;
      const within = Number(p.withinDays ?? 120);
      if (days == null) return hidden(b, "No active price guarantee");
      if (days > within) return hidden(b, `Guarantee ends in ${days} days (rule: within ${within})`);
      if (isSms(c)) return show(pick(tone, `Ihre Preisgarantie endet am ${c.ph.garantie_ende}.`, `Deine Preisgarantie endet am ${c.ph.garantie_ende}.`), { source: `Energy contract: ends in ${days} days` });
      return show(pick(tone, `Ihre Preisgarantie läuft am ${c.ph.garantie_ende} aus. Gern zeigen wir Ihnen vorher Ihre Möglichkeiten.`, `Deine Preisgarantie läuft am ${c.ph.garantie_ende} aus. Gern zeigen wir dir vorher deine Möglichkeiten.`), {
        ...(isCall(c) ? { title: "Anlass: Preisgarantie" } : {}),
        source: `Energy contract: ends in ${days} days`,
      });
    }

    case "article": {
      const topic = String(p.topic ?? "auto");
      // Auto: the guide that fits the offer shown above, else the first one that matches the customer.
      const prefer = c.offerShown ? OFFER_ARTICLE[c.offerShown] : undefined;
      const a = topic === "auto" ? (ARTICLES.find((x) => x.key === prefer) ?? ARTICLES.find((x) => x.match(r))) : ARTICLES.find((x) => x.key === topic);
      if (!a) return hidden(b, "No matching guide for this customer");
      return show(pick(tone, `Passend dazu: „${a.title}“ in unserem Ratgeber.`, `Passend dazu: „${a.title}“ in unserem Ratgeber.`), { cta: { label: "Zum Ratgeber", url: a.url }, source: `Matched: ${a.key}` });
    }

    case "survey": {
      const q = String(tone === "du" ? (p.questionDu ?? p.question) : p.question);
      const v = p.voucher ? pick(tone, ` Als Dankeschön erhalten Sie einen ${p.voucherEur ?? 5}-€-Gutschein für den MAINGAU Shop.`, ` Als Dankeschön bekommst du einen ${p.voucherEur ?? 5}-€-Gutschein für den MAINGAU Shop.`) : "";
      return show(`${q}${v}`, { title: "★ ★ ★ ★ ★", cta: { label: pick(tone, "Jetzt bewerten", "Jetzt bewerten"), url: "https://www.maingau-energie.de/feedback" } });
    }

    case "ai_text": {
      const g = p.generated as { du?: string; sie?: string } | null;
      const text = g?.[tone];
      if (!text) return hidden(b, "Empty paragraph: replace it with a text block");
      const out = fillPh(text, c.ph);
      c.checks.push(...checkFreeText(out, tone, { serviceOnly: s.service_case, avoidWords: c.settings.voice.avoidWords }).map((x) => ({ ...x, check: `AI paragraph: ${x.check}` })));
      return show(out, { source: `AI: ${String(p.prompt ?? "").slice(0, 80)}` });
    }

    case "text": {
      const raw = String((tone === "du" ? p.du : p.sie) || p.sie || p.du || "");
      if (!raw.trim()) return hidden(b, "Empty text");
      const out = fillPh(raw, c.ph);
      c.checks.push(...checkFreeText(out, tone, { serviceOnly: s.service_case, avoidWords: c.settings.voice.avoidWords }).filter((x) => !x.passed).map((x) => ({ ...x, check: `Text: ${x.check}` })));
      return show(out, typeof p.title === "string" && p.title.trim() ? { title: p.title.trim() } : {});
    }

    case "objections": {
      const lines = objectionsFor(r, tone);
      return show(lines.map((o) => `„${o.say}“ → ${o.answer}`).join("\n"), { title: "Mögliche Einwände", source: `Pains: ${s.pains.join(", ") || "none"}; contact consent noted` });
    }

    case "hero":
      return show("", { title: String(tone === "du" ? (p.titleDu ?? p.title) : p.title) });
    case "button":
      if (isSms(c)) return show(`${String(p.label ?? "Mehr")}: ${String(p.url ?? "https://www.maingau-energie.de").replace(/^https:\/\/(www\.)?/, "")}`);
      return show("", { cta: { label: String(p.label ?? "Mehr erfahren"), url: String(p.url ?? "https://www.maingau-energie.de") } });
    case "divider":
      return show("");
    case "footer":
      return show(c.settings.voice.signOff[tone], {
        source: "Legal",
        title: pick(tone, "Sie erhalten diese Nachricht als MAINGAU-Kundin bzw. -Kunde. Abmelden · Datenschutz · Impressum", "Du erhältst diese Nachricht als MAINGAU-Kundin bzw. -Kunde. Abmelden · Datenschutz · Impressum"),
      });
  }

  if (b.type.startsWith("custom:")) {
    const def = c.settings.customBlocks.find((x) => `custom:${x.id}` === b.type);
    if (!def) return hidden(b, "Custom block was deleted in Settings");
    const rule = evalShowIf(def.showIf, r.f);
    if (!rule.ok) return hidden(b, `Rule not met: ${rule.failed}`);
    const out = fillPh(tone === "du" ? def.du : def.sie, c.ph);
    c.checks.push(...checkFreeText(out, tone, { avoidWords: c.settings.voice.avoidWords }).filter((x) => !x.passed).map((x) => ({ ...x, check: `${def.name}: ${x.check}` })));
    return show(out, { source: def.name });
  }
  return hidden(b, `Unknown block type ${b.type}`);
}

export async function renderEmail(doc: EmailDoc, customerId: string, settings: Settings, channel = "email", opts: { signal?: string; offerIds?: string[] } = {}): Promise<RenderedEmail> {
  const [r, vocab] = await Promise.all([loadRecipient(customerId), getVocabulary().catch(() => null)]);
  const tone = r.tone;
  // "auto": the channel this customer consented to and the engine prefers.
  if (channel === "auto") {
    const allowed = r.profile.contact_policy.allowed_channels;
    const best = r.profile.summary.best_action?.channel ?? r.profile.summary.contact_channel;
    channel = best && allowed.includes(best) ? best : (allowed.find((x) => x === "email" || x === "newsletter") ?? allowed[0] ?? "email");
  }
  const offerNames = Object.fromEntries((vocab?.offers ?? []).map((o) => [o.offer_id, o.product_name]));
  const c: Ctx = { r, tone, settings, ph: placeholders(r), serviceShown: false, offerShown: null, checks: [], signal: opts.signal, offerIds: opts.offerIds, offerNames, channel };
  // Service blocks render first so the offer can step aside, wherever they sit in the layout.
  const order = [...doc.blocks].sort((a, b) => Number(b.type === "service_status") - Number(a.type === "service_status"));
  const byId = new Map(order.map((blk) => [blk.id, renderBlock(blk, c)]));
  const blocks = doc.blocks.map((blk) => byId.get(blk.id)!);
  // Service recipients get the service block's subject instead of the campaign subject.
  const svc = c.serviceShown ? (doc.blocks.find((x) => x.type === "service_status")?.props.subject as { du?: string; sie?: string } | undefined) : undefined;
  const subject = c.serviceShown
    ? fillPh(svc?.[tone] || (tone === "du" ? "Dein Anliegen bei MAINGAU" : "Ihr Anliegen bei MAINGAU"), c.ph)
    : fillPh(doc.subject[tone] || doc.subject.sie, c.ph);

  // A call script is a service contact when it leads with the open issue, otherwise an outbound sales call.
  if (channel === "call") channel = c.serviceShown ? "service_contact" : "outbound_call";
  const allText = [channel === "email" || channel === "newsletter" ? subject : "", ...blocks.filter((x) => x.visible).map((x) => `${x.title ?? ""} ${x.text}`)].join("\n");
  const checks: GuardrailCheck[] = [...c.checks];
  const isMail = channel === "email" || channel === "newsletter";
  if (isMail) {
    const subjectPrice = subject.match(PRICE)?.[0];
    checks.push({ check: "Subject has no prices or urgency", passed: !subjectPrice && !/letzte chance|nur heute|sofort/i.test(subject), detail: subjectPrice ? `found "${subjectPrice}"` : undefined });
  }
  const wrong = tone === "sie" ? allText.match(/\b(du|dir|dich|dein\w*)\b/i)?.[0] : allText.match(/\b(Sie|Ihnen|Ihr\w*)\b/)?.[0];
  checks.push({ check: `Whole message in the ${tone === "du" ? "Du" : "Sie"} form`, passed: !wrong, detail: wrong ? `found "${wrong}"` : undefined });
  if (s(r).service_case) checks.push({ check: "Service case: no offer shown", passed: !c.offerShown, detail: c.offerShown ? `offer ${c.offerShown} visible` : undefined });
  const hasFooter = blocks.some((x) => x.type === "footer" && x.visible);
  if (channel === "email" || channel === "newsletter") checks.push({ check: "Unsubscribe link (footer) included", passed: hasFooter });
  const allowed = r.profile.contact_policy.allowed_channels;
  const reachable = channel === "service_contact" || allowed.includes(channel);
  checks.push({ check: `Consent for ${channel.replace("_", " ")}`, passed: reachable, detail: reachable ? undefined : `allowed: ${allowed.join(", ") || "none"}` });
  const visibleCount = blocks.filter((x) => x.visible && x.type !== "footer" && x.type !== "divider").length;
  checks.push({ check: "Message has content for this customer", passed: visibleCount >= 2, detail: `${visibleCount} visible blocks` });
  if (channel === "sms") {
    const len = blocks.filter((x) => x.visible).map((x) => x.text).filter(Boolean).join(" ").length;
    checks.push({ check: "SMS fits in two messages (320 characters)", passed: len <= 320, detail: `${len} characters` });
  }

  const variant = c.serviceShown ? "service" : c.offerShown ? `offer:${c.offerShown}` : "generic";
  const offerName = c.offerName ?? c.offerShown ?? "";
  return {
    customerId,
    identity: r.identity,
    tone,
    channel,
    reachable,
    subject,
    blocks,
    checks: dedupeChecks(checks),
    variant,
    variantLabel: variant === "service" ? "Service version (no offer)" : variant === "generic" ? "Information only (no offer)" : `Offer: ${offerName}`,
  };
}

const s = (r: Recipient) => r.profile.summary;

function dedupeChecks(list: GuardrailCheck[]) {
  const m = new Map<string, GuardrailCheck>();
  for (const c of list) {
    const prev = m.get(c.check);
    if (!prev || (prev.passed && !c.passed)) m.set(c.check, c);
  }
  return [...m.values()];
}

/** Plain-text version of a rendered email (for pop-ups, SMS, proposals and the LLM). */
export function toPlain(e: RenderedEmail, max?: number) {
  const parts = e.blocks.filter((x) => x.visible && x.type !== "footer" && x.type !== "hero" && x.type !== "divider").map((x) => [x.title && x.type !== "survey" ? x.title : "", x.text].filter(Boolean).join(": "));
  const text = parts.filter(Boolean).join("\n\n");
  return max && text.length > max ? shorten(text, max) : text;
}

/** Cuts to `max` characters at the last full sentence, or else at a word, never mid-word. */
function shorten(text: string, max: number) {
  const head = text.slice(0, max);
  const ends = [...head.matchAll(/[.!?](?=\s|$)/g)].map((m) => m.index! + 1);
  const sentence = ends.filter((i) => i >= max * 0.5).pop();
  if (sentence) return head.slice(0, sentence).trim();
  const word = head.slice(0, max - 1).replace(/\s+\S*$/, "");
  return `${word.trim()}…`;
}

export { cap, dateDe };
