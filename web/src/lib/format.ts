const eur0 = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("de-DE");

export const fmtEur = (v: number, precise = false) => (precise || Math.abs(v) < 100 ? eur2 : eur0).format(v);
export const fmtDelta = (v: number) => (v > 0 ? "+" : "") + fmtEur(v, Math.abs(v) < 100);
export const fmtInt = (v: number) => int.format(v);
const dec = (v: number, digits: number) => v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const fmtPct = (v: number, digits = 0) => `${dec(v * 100, digits)} %`;
export const fmtPp = (pp: number) => `${pp > 0 ? "+" : ""}${dec(pp, 1)} pp`;

export function fmtDate(s?: string | null) {
  if (!s) return "–";
  const d = new Date(s.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
export function fmtDateTime(s?: string | null) {
  if (!s) return "–";
  const d = new Date(s.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
export function fmtAgo(s?: string | null) {
  if (!s) return "–";
  const min = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
  return fmtDate(s);
}

export const channelLabel: Record<string, string> = {
  email: "Email",
  newsletter: "Newsletter",
  portal_popup: "Portal pop-up",
  app_push: "App push",
  sms: "SMS",
  outbound_call: "Call",
  service_contact: "Service contact",
  best: "Best channel",
};
export const chLabel = (c?: string | null) => (c ? (channelLabel[c] ?? c.replace(/_/g, " ")) : "–");

export const actionTypeLabel: Record<string, string> = {
  sales: "Cross-sell",
  upsell: "Upsell",
  retention: "Retention",
  one_off: "Shop",
  service: "Service first",
};

export const statusLabel: Record<string, string> = { draft: "Draft", review: "In review", running: "Running", done: "Done" };

/** "price_guarantee_ending" → "Price guarantee ending" */
export const humanize = (k: string) => {
  const s = k.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Plain names for stream events and triggers ("cart_abandoned" → "Cart abandoned"). */
export const eventLabel: Record<string, string> = {
  schedule: "Morning schedule",
  manual: "Started by hand",
  gas_meter_deregistration_received: "Gas meter deregistered",
  order_placed: "Shop order",
  cart_abandoned: "Cart abandoned",
  newsletter_clicked: "Newsletter link clicked",
  newsletter_opened: "Newsletter opened",
  charge_session_failed: "Charging failed",
  charge_session_completed: "Charging finished",
  contract_cancellation_received: "Cancellation received",
  consent_changed: "Consent changed",
  dunning_level_changed: "Dunning level changed",
  mobile_data_threshold: "Mobile data limit reached",
  ticket_created: "Service ticket",
  ticket_updated: "Ticket updated",
  call_transcript_ready: "Phone call",
  meter_reading_submitted: "Meter reading",
  hems_device_offline: "HEMS offline",
  page_viewed: "Portal page viewed",
  portal_login: "Portal login",
  agent_nba_feedback: "Agent feedback",
  campaign: "Campaign",
};
export const evLabel = (k?: string | null) => (k ? (eventLabel[k] ?? humanize(k)) : "–");

/** "2 offers", "1 offer" */
export const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** Makes an engine reason readable: "p=0.03" → "3 % likely", channel keys → names, internal notes dropped. */
export function plainWhy(reason: string) {
  return reason
    .replace(/\s*\(churn [^)]*\)/g, "")
    // "… → StromGarant, p=0.07": the action is shown next to its reason already.
    .replace(/\s*→\s*[^,→]+(?=,\s*p=)/g, "")
    .replace(/\(removes /g, "(")
    .replace(/\bCSAT (\d)\b/g, "satisfaction $1/5")
    .replace(/,?\s*p=(\d+(\.\d+)?)/g, (_, p: string) => `, ${Math.round(Number(p) * 100)} % likely`)
    .replace(/\bvia (\w+)/g, (_, c: string) => `via ${chLabel(c)}`)
    .replace(/\s*\((Du|Sie)\)/g, "")
    .replace(/\bdCLV\b|\bΔCLV\b/g, "CLV")
    .replace(/_/g, " ")
    .replace(/^,\s*/, "");
}
