// Analytics: one semantic layer over the insights service's 12 datasets, joined with customer
// attributes (form of address, segment, pain, value tier…), and a chart runner that groups, compares
// and writes a one-line insight with a two-proportion z-test.
import type { ChartFilter, ChartResult, ChartRow, ChartSpec, CustomerSummary, FieldDef, FieldValue, MeasureDef, MeasureFormat, SourceDef } from "../../shared/types.ts";
import { hourOf, loadDataset } from "./datasets.ts";
import { log } from "./log.ts";
import { getVocabulary, searchCustomers } from "./upstream.ts";

type Row = Record<string, unknown>;

interface Ctx {
  cust: Map<string, CustomerSummary>;
  base: Map<string, Row>;
  offers: Map<string, { name: string; type: string }>;
}

interface Field extends FieldDef {
  get: (r: Row, cx: Ctx) => unknown;
  fmt?: (key: string, cx: Ctx) => string;
  /** Natural order (time, numbers): keeps every value instead of the top N. */
  order?: (key: string) => number;
  /** A customer can have several values (segments, pains…), so groups overlap. */
  multi?: boolean;
}

interface Stat {
  value: number | null;
  n: number;
  hits?: number;
  n2?: number;
  hits2?: number;
}

interface Measure extends MeasureDef {
  calc: (rows: Row[], cx: Ctx) => Stat;
}

interface Source {
  key: string;
  label: string;
  description: string;
  dataset: string;
  fields: Field[];
  measures: Measure[];
}

export class AnalyticsError extends Error {}

// ---------- Labels ----------

const NONE = "(none)";
const OTHER = "__other";
const keyOf = (v: unknown) => (v === null || v === undefined || v === "" ? NONE : String(v));
const ACRONYM: Record<string, string> = { hems: "HEMS", sms: "SMS", pv: "PV", ev: "EV", dsl: "DSL", csat: "CSAT", cpo: "CPO", ac: "AC", dc: "DC", esim: "eSIM", rfid: "RFID", nba: "NBA" };
const human = (k: string) => {
  if (k === NONE) return "None";
  const s = k.replace(/_/g, " ").replace(/\b[a-z]+\b/gi, (w) => ACRONYM[w.toLowerCase()] ?? w);
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const yesNo = (k: string) => (k === "true" ? "Yes" : k === "false" ? "No" : k === NONE ? "Unknown" : human(k));
/** A label inside a sentence starts in lower case, but "CSAT score" and "SMS" keep their capitals. */
const lower = (s: string) => (/^[A-Z]{2,}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isTrue = (v: unknown) => v === true || v === "true" || v === 1;
const CHANNEL: Record<string, string> = {
  email: "Email",
  newsletter: "Newsletter",
  newsletter_email: "Newsletter",
  portal_popup: "Portal pop-up",
  app_push: "App push",
  sms: "SMS",
  outbound_call: "Call",
  service_contact: "Service contact",
  phone: "Phone",
  chat: "Chat",
  portal_form: "Portal form",
  web: "Web",
  app: "App",
};
const OFFER_TYPE: Record<string, string> = { sales: "Cross-sell", upsell: "Upsell", retention: "Retention", one_off: "Shop", service: "Service" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const channel = (k: string) => CHANNEL[k] ?? human(k);
const tone = (k: string) => (k === "du" ? "Du" : k === "sie" ? "Sie" : "Unknown");
const monthLabel = (k: string) => (/^\d{4}-\d{2}$/.test(k) ? `${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(2, 4)}` : human(k));
const weekdayOf = (iso: unknown) => (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? (new Date(`${iso.slice(0, 10)}T12:00:00Z`).getUTCDay() + 6) % 7 : null);

// ---------- Fields ----------

const own = (key: string, label: string, col: string, fmt?: Field["fmt"], extra: Partial<Field> = {}): Field => ({ key, label, group: "own", get: (r) => r[col], fmt, ...extra });
const flag = (key: string, label: string, col: string): Field => own(key, label, col, yesNo);
const month = (col = "month"): Field => ({ key: "month", label: "Month", group: "time", get: (r) => r[col], fmt: monthLabel, order: (k) => Number(k.replace("-", "")) || 0 });
const timeFields = (ts: string): Field[] => [
  { key: "month", label: "Month", group: "time", get: (r) => r.month ?? (typeof r[ts] === "string" ? (r[ts] as string).slice(0, 7) : null), fmt: monthLabel, order: (k) => Number(k.replace("-", "")) || 0 },
  { key: "weekday", label: "Weekday", group: "time", get: (r) => weekdayOf(r[ts]), fmt: (k) => WEEKDAYS[Number(k)] ?? "Unknown", order: Number },
  { key: "hour", label: "Hour of day", group: "time", numeric: true, get: (r) => hourOf(r[ts]), fmt: (k) => (k === NONE ? "Unknown" : `${k} h`), order: Number },
];

const cu = (r: Row, cx: Ctx) => cx.cust.get(String(r.customer_id));
const cb = (r: Row, cx: Ctx) => cx.base.get(String(r.customer_id));
function customerFields(group: "own" | "customer"): Field[] {
  return [
    // Offers and newsletters have their own "form of address" (what was sent): the customer's is named apart.
    { key: "c_tone", label: group === "own" ? "Form of address" : "Customer's own form of address", group, get: (r, cx) => cu(r, cx)?.tonality ?? null, fmt: tone },
    { key: "c_segment", label: "Segment", group, multi: true, get: (r, cx) => cu(r, cx)?.segments ?? [] },
    { key: "c_persona", label: "Persona", group, multi: true, get: (r, cx) => cu(r, cx)?.personas ?? [] },
    { key: "c_pain", label: "Pain", group, multi: true, get: (r, cx) => cu(r, cx)?.pains ?? [] },
    { key: "c_product", label: "Product owned", group, multi: true, get: (r, cx) => cu(r, cx)?.products ?? [] },
    { key: "c_value_tier", label: "Value tier", group, get: (r, cx) => cb(r, cx)?.value_tier ?? cu(r, cx)?.value_tier ?? null },
    { key: "c_churn_band", label: "Churn risk", group, get: (r, cx) => cb(r, cx)?.churn_band ?? null },
    { key: "c_city", label: "City", group, get: (r, cx) => cb(r, cx)?.city ?? cu(r, cx)?.city ?? null },
    { key: "c_app", label: "App installed", group, get: (r, cx) => cb(r, cx)?.app_installed ?? null, fmt: yesNo },
    { key: "c_service_case", label: "Open service case", group, get: (r, cx) => cu(r, cx)?.service_case ?? null, fmt: yesNo },
  ];
}

// ---------- Measures ----------

const count = (label: string): Measure => ({ key: "count", label, format: "int", description: `Number of ${lower(label)}`, calc: (rows) => ({ value: rows.length, n: rows.length }) });
const customers: Measure = {
  key: "customers",
  label: "Customers",
  format: "int",
  description: "Distinct customers",
  calc: (rows) => ({ value: new Set(rows.map((r) => r.customer_id)).size, n: rows.length }),
};
function rate(key: string, label: string, description: string, hit: (r: Row) => boolean, base: (r: Row) => boolean = () => true): Measure {
  return {
    key,
    label,
    format: "pct",
    description,
    calc: (rows) => {
      let n = 0;
      let h = 0;
      for (const r of rows)
        if (base(r)) {
          n++;
          if (hit(r)) h++;
        }
      return { value: n ? h / n : null, n, hits: h };
    },
  };
}
const numbers = (rows: Row[], cx: Ctx, get: (r: Row, cx: Ctx) => unknown) => rows.map((r) => Number(get(r, cx) ?? NaN)).filter((v) => Number.isFinite(v));
function avg(key: string, label: string, format: MeasureFormat, description: string, get: (r: Row, cx: Ctx) => unknown): Measure {
  return {
    key,
    label,
    format,
    description,
    calc: (rows, cx) => {
      const v = numbers(rows, cx, get);
      return { value: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null, n: v.length };
    },
  };
}
function sum(key: string, label: string, format: MeasureFormat, description: string, get: (r: Row, cx: Ctx) => unknown): Measure {
  return {
    key,
    label,
    format,
    description,
    calc: (rows, cx) => {
      const v = numbers(rows, cx, get);
      return { value: v.reduce((a, b) => a + b, 0), n: v.length };
    },
  };
}
const uplift: Measure = {
  key: "uplift",
  label: "Uplift vs control",
  format: "pp",
  description: "Conversion of customers who got the offer minus conversion of the control group, in percentage points",
  calc: (rows) => {
    let n1 = 0;
    let h1 = 0;
    let n2 = 0;
    let h2 = 0;
    for (const r of rows)
      if (isTrue(r.control_group)) {
        n2++;
        if (isTrue(r.converted)) h2++;
      } else {
        n1++;
        if (isTrue(r.converted)) h1++;
      }
    return { value: n1 && n2 ? h1 / n1 - h2 / n2 : null, n: n1, hits: h1, n2, hits2: h2 };
  },
};
const treated = (r: Row) => !isTrue(r.control_group);
const responded = (r: Row) => isTrue(r.converted) || ["viewed", "clicked", "converted"].includes(String(r.response));

// ---------- Sources ----------

const SOURCES: Source[] = [
  {
    key: "offers",
    label: "Offers sent",
    description: "Every offer MAINGAU sent (or held back for the control group) with the response and whether it converted.",
    dataset: "nba_actions",
    fields: [
      own("channel", "Channel", "channel", channel),
      own("tone", "Form of address used in the offer", "tonality", tone),
      { key: "offer", label: "Offer", group: "own", get: (r) => r.offer_id, fmt: (k, cx) => cx.offers.get(k)?.name ?? human(k) },
      { key: "offer_type", label: "Offer type", group: "own", get: (r, cx) => cx.offers.get(String(r.offer_id))?.type ?? null, fmt: (k) => OFFER_TYPE[k] ?? human(k) },
      own("rule", "Trigger rule", "rule_id", (k) => human(k.replace(/^R-/, "").toLowerCase().replace(/-/g, " "))),
      own("variant", "Content variant", "content_variant", (k) => (k === NONE ? "None" : `Variant ${k}`)),
      own("response", "Response", "response"),
      own("control_group", "Control group", "control_group", (k) => (k === "true" ? "Control group" : k === "false" ? "Got the offer" : "Unknown")),
      flag("converted", "Converted", "converted"),
      ...timeFields("decided_at"),
      ...customerFields("customer"),
    ],
    measures: [
      count("Offers"),
      customers,
      rate("conversion_rate", "Conversion rate", "Share of offers that led to a purchase (control group included unless filtered out)", (r) => isTrue(r.converted)),
      rate("response_rate", "Response rate", "Viewed, clicked or bought, among those who got the offer", responded, treated),
      rate("click_rate", "Click rate", "Clicked or bought, among those who got the offer", (r) => isTrue(r.converted) || ["clicked", "converted"].includes(String(r.response)), treated),
      rate("dismiss_rate", "Dismiss rate", "Dismissed, among those who got the offer", (r) => r.response === "dismissed", treated),
      uplift,
    ],
  },
  {
    key: "newsletter",
    label: "Newsletter deliveries",
    description: "One row per newsletter sent to a customer, with how it was opened and what was clicked.",
    dataset: "newsletter",
    fields: [
      own("topic", "Topic", "product_focus"),
      own("tone", "Form of address used in the newsletter", "tonality", tone),
      own("opened", "Opened", "open_client_class", (k) => (k === "human" ? "Opened by a person" : k === "apple_mpp_prefetch" ? "Apple prefetch" : k === NONE ? "Not opened" : human(k))),
      own("click_target", "Click target", "click_target", (k) => (k === NONE ? "No click" : human(k))),
      own("subject", "Subject line", "subject_line", (k) => k),
      month(),
      ...customerFields("customer"),
    ],
    measures: [
      count("Newsletters"),
      customers,
      rate("open_rate", "Open rate", "Opened by a person (Apple's automatic prefetch does not count)", (r) => r.open_client_class === "human"),
      rate("click_rate", "Click rate", "Share of newsletters with a click", (r) => r.click_target != null && r.click_target !== ""),
    ],
  },
  {
    key: "tickets",
    label: "Service tickets",
    description: "Every service contact with category, channel, resolution and CSAT.",
    dataset: "service_tickets",
    fields: [
      own("category", "Reason", "category"),
      own("channel", "Channel", "channel", channel),
      own("status", "Status", "status"),
      own("resolution", "Resolution", "resolution_code"),
      flag("fcr", "Solved on first contact", "first_contact_resolution"),
      flag("repeat", "Repeat contact", "is_repeat"),
      own("csat", "CSAT score", "csat_1to5", (k) => (k === NONE ? "No rating" : `${k} of 5`), { order: (k) => Number(k) || 0, numeric: true }),
      ...timeFields("created_at"),
      ...customerFields("customer"),
    ],
    measures: [
      count("Tickets"),
      customers,
      avg("csat_avg", "Average CSAT", "num", "Average satisfaction, 1 to 5 (tickets with a rating)", (r) => r.csat_1to5),
      rate("fcr_rate", "First-contact resolution", "Share of tickets solved in the first contact", (r) => isTrue(r.first_contact_resolution)),
      rate("repeat_rate", "Repeat contact rate", "Share of tickets that are a repeat contact", (r) => isTrue(r.is_repeat)),
      rate("low_csat_rate", "Unhappy rate (CSAT ≤ 2)", "Share of rated tickets with CSAT 1 or 2", (r) => Number(r.csat_1to5) <= 2, (r) => r.csat_1to5 != null),
    ],
  },
  {
    key: "charging",
    label: "Charging sessions",
    description: "Autostrom charging sessions with type, operator and why a session failed.",
    dataset: "charge_sessions",
    fields: [
      own("charge_type", "Charging type", "charge_type", (k) => k),
      own("status", "Status", "session_status"),
      own("failure_reason", "Failure reason", "failure_reason", (k) => (k === NONE ? "No failure" : human(k))),
      own("operator", "Operator", "cpo_id", (k) => k),
      own("country", "Country", "country", (k) => k),
      own("auth", "Started with", "auth_method"),
      own("cdr_source", "Data source", "cdr_source"),
      ...timeFields("started_at"),
      ...customerFields("customer"),
    ],
    measures: [
      count("Charging sessions"),
      customers,
      rate("failure_rate", "Failure rate", "Failed or aborted sessions", (r) => r.session_status !== "completed"),
    ],
  },
  {
    key: "shop",
    label: "Shop orders",
    description: "Orders in the MAINGAU shop.",
    dataset: "shop_orders",
    fields: [
      own("product", "Product", "product_name", (k) => k),
      own("category", "Category", "product_category"),
      own("status", "Status", "order_status"),
      own("order_channel", "Ordered via", "order_channel", channel),
      flag("guest", "Guest order", "guest"),
      month(),
      ...customerFields("customer"),
    ],
    measures: [count("Orders"), customers, rate("return_rate", "Return rate", "Returned orders", (r) => r.order_status === "returned")],
  },
  {
    key: "portal",
    label: "Portal visits",
    description: "Pages customers opened in the portal and app.",
    dataset: "portal_pages",
    fields: [own("page", "Page", "page"), own("client", "Web or app", "client", channel), flag("banner", "Offer banner shown", "offer_banner_shown"), month(), ...customerFields("customer")],
    measures: [count("Page views"), customers, rate("banner_rate", "Offer banner rate", "Share of page views with an offer banner", (r) => isTrue(r.offer_banner_shown))],
  },
  {
    key: "customers",
    label: "Customers",
    description: "All 750 customers with value, churn risk, segments and pains.",
    dataset: "customers",
    fields: [
      ...customerFields("own"),
      own("language", "Language", "language"),
      own("cohort", "Customer since", "cohort_year", (k) => k, { order: Number, numeric: true }),
      own("lines", "Business lines", "active_business_lines", (k) => k, { order: Number, numeric: true }),
      own("household", "Household size", "household_size", (k) => k, { order: Number, numeric: true }),
      flag("portal_account", "Portal account", "portal_account"),
    ],
    measures: [
      count("Customers"),
      avg("clv_avg", "Average CLV", "eur", "Average customer lifetime value", (r) => r.clv_eur),
      sum("clv_sum", "Total CLV", "eur", "Sum of customer lifetime value", (r) => r.clv_eur),
      avg("churn_avg", "Average churn risk", "pct", "Average probability of leaving within 12 months", (r) => r.churn_prob_12m),
      sum("var_sum", "Value at risk", "eur", "CLV × churn risk, summed", (r, cx) => cu(r, cx)?.value_at_risk_eur),
      sum("margin_sum", "Annual margin", "eur", "Sum of annual margin", (r) => r.annual_margin_eur),
    ],
  },
  {
    key: "consents",
    label: "Consents",
    description: "Each customer's consent per purpose (marketing e-mail, phone, SMS, newsletter, portal, profiling).",
    dataset: "consents",
    fields: [own("consent_type", "Purpose", "consent_type"), own("status", "Status", "status"), own("source", "Given via", "source"), ...customerFields("customer")],
    measures: [count("Consents"), customers, rate("granted_rate", "Granted share", "Share of consents that are granted", (r) => r.status === "granted")],
  },
  {
    key: "energy",
    label: "Energy contracts",
    description: "Electricity and gas contracts with tariff, price guarantee and consumption.",
    dataset: "energy_contracts",
    fields: [
      own("commodity", "Commodity", "commodity"),
      own("tariff", "Tariff", "tariff", (k) => k),
      own("status", "Status", "status"),
      own("meter_type", "Meter", "meter_type"),
      own("payment", "Payment", "payment_method"),
      own("dunning", "Dunning level", "dunning_level", (k) => k, { order: Number, numeric: true }),
      own("guarantee_month", "Guarantee ends", "guarantee_month", monthLabel, { order: (k) => Number(k.replace("-", "")) || 0 }),
      flag("guarantee_expired", "Guarantee expired", "guarantee_expired"),
      own("start_year", "Start year", "start_year", (k) => k, { order: Number, numeric: true }),
      ...customerFields("customer"),
    ],
    measures: [
      count("Contracts"),
      customers,
      avg("consumption_avg", "Average consumption (kWh)", "num", "Average annual consumption in kWh", (r) => r.annual_consumption_kwh),
      avg("price_avg", "Average price (€/kWh)", "num", "Average energy price in €/kWh", (r) => r.energy_price_eur_kwh),
    ],
  },
  {
    key: "mobile",
    label: "Mobile contracts",
    description: "Mobile plans with SIMs, data limit and minimum term.",
    dataset: "mobile_contracts",
    fields: [
      own("plan", "Plan", "plan", (k) => k),
      own("sims", "SIM cards", "sim_count", (k) => k, { order: Number, numeric: true }),
      flag("esim", "eSIM", "esim"),
      flag("data_limit", "Data limit reached (3 months)", "data_limit_reached_3m"),
      flag("past_min_term", "Past minimum term", "past_min_term"),
      ...customerFields("customer"),
    ],
    measures: [count("Contracts"), customers],
  },
  {
    key: "hems",
    label: "Smart home devices",
    description: "HEMS devices: gateways, inverters, wallboxes, batteries, heat pumps.",
    dataset: "hems_devices",
    fields: [own("device_type", "Device", "device_type"), own("manufacturer", "Manufacturer", "manufacturer", (k) => k), own("connection", "Connection", "connection_status"), ...customerFields("customer")],
    measures: [count("Devices"), customers],
  },
  {
    key: "agent_assist",
    label: "Agent suggestions",
    description: "Offers suggested to service agents during calls and chats, and what happened.",
    dataset: "agent_assist",
    fields: [
      { key: "offer", label: "Suggested offer", group: "own", get: (r) => r.suggested_offer_id, fmt: (k, cx) => cx.offers.get(k)?.name ?? human(k) },
      own("channel", "Channel", "channel", channel),
      own("agent_action", "Agent action", "agent_action"),
      own("dismiss_reason", "Why dismissed", "dismiss_reason"),
      own("reaction", "Customer reaction", "customer_reaction"),
      ...customerFields("customer"),
    ],
    measures: [count("Suggestions"), customers, rate("accept_rate", "Acceptance rate", "Share of suggestions the agent used", (r) => r.agent_action === "accepted")],
  },
];

// ---------- Context (customer attributes, offer names) ----------

const TTL_MS = 15 * 60_000;
let ctxCache: { at: number; p: Promise<Ctx> } | null = null;
function context(): Promise<Ctx> {
  if (ctxCache && Date.now() - ctxCache.at < TTL_MS) return ctxCache.p;
  const t = Date.now();
  const p = (async () => {
    const page = (offset: number) => searchCustomers({ audience: {}, sort: "value_at_risk", desc: true, limit: 500, offset });
    const [vocab, base, first] = await Promise.all([
      getVocabulary().catch((e) => {
        log.warn("analytics", "offer names unavailable: charts show offer ids instead", e);
        return null;
      }),
      loadDataset<Row>("customers"),
      page(0),
    ]);
    const items = [...first.items];
    for (let off = 500; off < first.total; off += 500) items.push(...(await page(off)).items);
    log.info("analytics", `customer context ready: ${items.length} customers, ${vocab?.offers.length ?? 0} offers, ${Date.now() - t} ms`);
    return {
      cust: new Map(items.map((c) => [c.customer_id, c])),
      base: new Map(base.map((r) => [String(r.customer_id), r])),
      offers: new Map((vocab?.offers ?? []).map((o) => [o.offer_id, { name: o.product_name, type: o.action_type }])),
    };
  })();
  ctxCache = { at: Date.now(), p };
  p.catch((e) => {
    ctxCache = null;
    log.error("analytics", "could not load the customer context", e);
  });
  return p;
}

// ---------- Catalog ----------

const fieldDef = ({ key, label, group, numeric }: Field): FieldDef => ({ key, label, group, ...(numeric ? { numeric } : {}) });
const measureDef = ({ key, label, format, description }: Measure): MeasureDef => ({ key, label, format, description });

export function catalog(): SourceDef[] {
  return SOURCES.map((s) => ({ key: s.key, label: s.label, description: s.description, fields: s.fields.map(fieldDef), measures: s.measures.map(measureDef) }));
}

/** The catalog as compact text for the agent's tool descriptions. */
export function catalogText() {
  const cust = customerFields("customer").map((f) => f.key);
  return SOURCES.map((s) => {
    const fields = s.fields.filter((f) => s.key === "customers" || !cust.includes(f.key)).map((f) => f.key);
    return `${s.key} (${s.label}): fields ${fields.join(", ")}; measures ${s.measures.map((m) => m.key).join(", ")}`;
  })
    .concat(`Every source except customers also has the customer fields ${cust.join(", ")}.`)
    .join("\n");
}

// ---------- Running a chart ----------

const keysOf = (f: Field, r: Row, cx: Ctx): string[] => {
  const v = f.get(r, cx);
  const arr = Array.isArray(v) ? v : [v];
  return arr.length ? arr.map(keyOf) : [NONE];
};
const labelOf = (f: Field, k: string, cx: Ctx) => (f.fmt ? f.fmt(k, cx) : human(k));

function matches(def: Field, f: ChartFilter, r: Row, cx: Ctx) {
  const ks = keysOf(def, r, cx);
  if (f.values?.length) {
    const want = new Set(f.values.map((v) => String(v).toLowerCase()));
    if (!ks.some((k) => want.has(k.toLowerCase()) || want.has(labelOf(def, k, cx).toLowerCase()))) return false;
  }
  if (f.min != null || f.max != null)
    return ks.some((k) => {
      const n = Number(k);
      return Number.isFinite(n) && (f.min == null || n >= f.min) && (f.max == null || n <= f.max);
    });
  return true;
}

/** Keeps the top values by row count (or all, in natural order) and folds the rest into "Other". */
function bucketer(f: Field, rows: Row[], cx: Ctx, max: number) {
  const n = new Map<string, number>();
  for (const r of rows) for (const k of keysOf(f, r, cx)) n.set(k, (n.get(k) ?? 0) + 1);
  const keys = [...n.keys()];
  if (f.order) {
    keys.sort((a, b) => (a === NONE ? 1 : b === NONE ? -1 : f.order!(a) - f.order!(b)));
    return { keys, map: (k: string) => k, other: 0, natural: true };
  }
  keys.sort((a, b) => n.get(b)! - n.get(a)!);
  const keep = new Set(keys.slice(0, max));
  const other = keys.length - keep.size;
  return { keys: other > 0 ? [...keep, OTHER] : [...keep], map: (k: string) => (keep.has(k) ? k : OTHER), other, natural: false };
}

function phi(z: number) {
  // Abramowitz–Stegun approximation of the normal CDF.
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
/** Two-sided p-value of a two-proportion z-test. */
function zTest(h1: number, n1: number, h2: number, n2: number) {
  if (!n1 || !n2) return 1;
  const p = (h1 + h2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return 1;
  return 2 * (1 - phi(Math.abs(h1 / n1 - h2 / n2) / se));
}

// German number format, the same in the insight sentences and in the browser's chart labels:
// 2.270 · 3,6 % · 72.637 € · 63,46 € · 0,359
const de = (v: number, digits = 0) => v.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const int = (v: number) => de(Math.round(v));
/** Decimals for a plain number: 3,82 (CSAT), 0,359 (€/kWh), 2.870 (kWh). */
const places = (v: number) => (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : Math.abs(v) >= 1 ? 2 : 3);
export function fmtMeasure(format: MeasureFormat, v: number | null) {
  if (v == null || !Number.isFinite(v)) return "–";
  if (format === "pct") return `${de(v * 100, 1)} %`;
  if (format === "pp") {
    const r = Number((v * 100).toFixed(1));
    return `${r > 0 ? "+" : r < 0 ? "−" : ""}${de(Math.abs(r), 1)} pp`;
  }
  if (format === "eur") return `${de(v, Math.abs(v) < 100 ? 2 : 0)} €`;
  if (format === "num") return de(v, places(v));
  return int(v);
}
const pText = (p: number) => (p < 0.001 ? "p < 0,001" : `p = ${de(p, 2)}`);

/** Fewer cases than this behind a rate, an average or a lift: too thin to name a winner (the charts hatch these). */
const MIN_N = 30;
/** Counts and sums are exact; rates, averages and lifts are estimates that need cases behind them. */
const additive = (m: Measure) => m.format === "int" || m.key.endsWith("_sum");
/** The cases behind a number; for a lift, the smaller of the two groups it compares. */
const casesOf = (s: Stat) => (s.n2 != null ? Math.min(s.n, s.n2) : s.n);

function insightFor(m: Measure, groups: { label: string; stat: Stat }[], total: Stat, x: Field | undefined, natural: boolean) {
  const f = (v: number | null) => fmtMeasure(m.format, v);
  const warnings: string[] = [];
  const valid = groups.filter((g) => g.stat.value != null && g.stat.n > 0 && !g.label.startsWith("Other ("));
  if (!x || valid.length < 2) return { text: `Overall: ${f(total.value)} (n = ${int(total.n)}).`, warnings };
  // A 10 % from 12 cases must not be "the best": groups with fewer than 30 cases stay out of best and worst
  // (unless that would leave fewer than two to compare), and the note says who was left out.
  const solid = additive(m) ? valid : valid.filter((g) => casesOf(g.stat) >= MIN_N);
  const ranked = solid.length >= 2 ? solid : valid;
  const left = valid.filter((g) => !ranked.includes(g));
  if (left.length) warnings.push(`Not ranked, fewer than ${MIN_N} cases: ${left.map((g) => `${g.label} (n = ${int(casesOf(g.stat))})`).join(", ")}.`);
  const byValue = [...ranked].sort((a, b) => b.stat.value! - a.stat.value!);
  const hi = byValue[0];
  const lo = byValue[byValue.length - 1];
  if (x.multi) warnings.push(`A customer can be in several ${lower(x.label)} groups, so the groups overlap.`);

  if (m.key === "uplift") {
    const s = hi.stat;
    const p = zTest(s.hits ?? 0, s.n, s.hits2 ?? 0, s.n2 ?? 0);
    const worse = ranked.filter((g) => g.stat.value! < 0).length;
    if ((s.n2 ?? 0) < MIN_N) warnings.push(`The control group for ${hi.label} has only ${int(s.n2 ?? 0)} customers: read with care.`);
    return {
      text: `Best: ${hi.label} lifts conversion by ${f(s.value)} against its control group (n = ${int(s.n)} / ${int(s.n2 ?? 0)}), ${p < 0.05 ? "a significant lift" : "not significant"} (${pText(p)}).${worse ? ` ${worse} of ${ranked.length} do worse than control.` : ""}`,
      warnings,
    };
  }
  if (m.format === "pct" && hi.stat.hits != null && lo.stat.hits != null) {
    const p = zTest(hi.stat.hits, hi.stat.n, lo.stat.hits, lo.stat.n);
    if (hi.stat.n < MIN_N || lo.stat.n < MIN_N) warnings.push(`Fewer than ${MIN_N} cases in ${hi.stat.n < MIN_N ? hi.label : lo.label}: read with care.`);
    const verdict = `${p < 0.05 ? "a significant difference" : "not a significant difference"} (${pText(p)})`;
    if (ranked.length === 2) return { text: `${m.label}: ${hi.label} ${f(hi.stat.value)} vs ${lo.label} ${f(lo.stat.value)} (n = ${int(hi.stat.n)} / ${int(lo.stat.n)}), ${verdict}.`, warnings };
    return { text: `${m.label} is highest for ${hi.label} (${f(hi.stat.value)}) and lowest for ${lo.label} (${f(lo.stat.value)}), n = ${int(hi.stat.n)} / ${int(lo.stat.n)}: ${verdict}.`, warnings };
  }
  if (additive(m)) {
    if (natural) return { text: `Peak: ${hi.label} with ${f(hi.stat.value)}; lowest: ${lo.label} with ${f(lo.stat.value)}.`, warnings };
    const all = total.value ?? 0;
    const share = all ? ` (${Math.round((hi.stat.value! / all) * 100)} % of ${f(all)})` : "";
    const top3 = byValue.slice(0, 3).reduce((a, g) => a + g.stat.value!, 0);
    const tail = ranked.length >= 5 && all && !x.multi ? ` The top 3 make up ${Math.round((top3 / all) * 100)} %.` : "";
    return { text: `Most: ${hi.label} with ${f(hi.stat.value)}${share}.${tail}`, warnings };
  }
  return { text: `Highest: ${hi.label} ${f(hi.stat.value)}, lowest: ${lo.label} ${f(lo.stat.value)} (all: ${f(total.value)}, n = ${int(total.n)}).`, warnings };
}

/** A categorical split keeps its top 5 values plus "Other"; more series than that only come from fields with a natural order. */
const MANY_SERIES = 6;
function pickChart(spec: ChartSpec, x: Field | undefined, split: Field | undefined, m: Measure, series: number): ChartResult["chart"] {
  if (spec.chart && spec.chart !== "auto") return spec.chart;
  if (!x) return "kpi";
  // Grouped bars with that many colours are a wall of bars: stack what adds up, give the rest a table.
  if (split && series > MANY_SERIES) return additive(m) ? "stacked" : "table";
  if (x.group === "time" && x.key !== "weekday") return "line";
  if (split && additive(m)) return "stacked";
  return "bar";
}

function resolve(spec: ChartSpec) {
  const src = SOURCES.find((s) => s.key === spec.source);
  if (!src) throw new AnalyticsError(`There is no data source “${spec.source}”. Pick one of: ${SOURCES.map((s) => `${s.key} (${s.label})`).join(", ")}.`);
  const field = (k: string | undefined) => {
    if (!k) return undefined;
    const f = src.fields.find((x) => x.key === k);
    if (!f) throw new AnalyticsError(`${src.label} has no field “${k}”. Fields: ${src.fields.map((x) => x.key).join(", ")}.`);
    return f;
  };
  const measures = (spec.measures?.length ? spec.measures : ["count"]).map((k) => {
    const m = src.measures.find((x) => x.key === k);
    if (!m) throw new AnalyticsError(`${src.label} has no number “${k}”. Numbers: ${src.measures.map((x) => x.key).join(", ")}.`);
    return m;
  });
  const x = field(spec.x);
  const split = spec.split && spec.split !== spec.x ? field(spec.split) : undefined;
  const filters = (spec.filters ?? []).filter((f) => f.values?.length || f.min != null || f.max != null).map((f) => ({ f, def: field(f.field)! }));
  return { src, x, split, measures, filters };
}

/** Failed and slow runs go to the log with the spec that caused them. */
const SLOW_MS = 3000;
export async function runChart(spec: ChartSpec): Promise<ChartResult> {
  const t = Date.now();
  try {
    const out = await execute(spec);
    const ms = Date.now() - t;
    if (ms > SLOW_MS) log.warn("analytics", `chart took ${ms} ms`, { spec, rows: out.n });
    if (!out.n) log.info("analytics", "chart matched no rows", { spec });
    return out;
  } catch (e) {
    if (e instanceof AnalyticsError) log.warn("analytics", `chart spec rejected: ${e.message}`, { spec });
    else log.error("analytics", `chart failed after ${Date.now() - t} ms`, { spec, error: e });
    throw e;
  }
}

async function execute(spec: ChartSpec): Promise<ChartResult> {
  const { src, x, split, measures, filters } = resolve(spec);
  const [cx, all] = await Promise.all([context(), loadDataset<Row>(src.dataset)]);
  const rows = all.filter((r) => filters.every(({ f, def }) => matches(def, f, r, cx)));
  const m0 = measures[0];

  const xb = x ? bucketer(x, rows, cx, Math.max(2, Math.min(spec.limit ?? 12, 40))) : null;
  const sb = split ? bucketer(split, rows, cx, 5) : null;
  const push = (m: Map<string, Row[]>, k: string, r: Row) => {
    const a = m.get(k);
    if (a) a.push(r);
    else m.set(k, [r]);
  };
  const cells = new Map<string, Row[]>();
  const perX = new Map<string, Row[]>();
  for (const r of rows) {
    const xs = xb ? [...new Set(keysOf(x!, r, cx).map(xb.map))] : ["all"];
    const ss = sb ? [...new Set(keysOf(split!, r, cx).map(sb.map))] : [""];
    for (const xk of xs) {
      push(perX, xk, r);
      for (const sk of ss) push(cells, `${xk}\u0000${sk}`, r);
    }
  }
  const lab = (f: Field, b: { other: number }, k: string) => (k === OTHER ? `Other (${b.other})` : labelOf(f, k, cx));

  let xKeys = xb ? xb.keys : ["all"];
  const xStat = new Map(xKeys.map((k) => [k, m0.calc(perX.get(k) ?? [], cx)]));
  // Categories without a natural order are sorted by the first number, "Other" last.
  if (xb && !xb.natural) xKeys = [...xKeys].sort((a, b) => (a === OTHER ? 1 : b === OTHER ? -1 : (xStat.get(b)!.value ?? -Infinity) - (xStat.get(a)!.value ?? -Infinity)));
  const sKeys = sb ? sb.keys : [""];

  // Each row's n is the number of cases behind its first number (for a lift: the smaller of its two groups),
  // so the charts can flag small samples.
  const out: ChartRow[] = [];
  for (const xk of xKeys)
    for (const sk of sKeys) {
      const cell = cells.get(`${xk}\u0000${sk}`);
      if (!cell?.length) continue;
      const stats = measures.map((m) => m.calc(cell, cx));
      out.push({
        x: xb ? lab(x!, xb, xk) : "All",
        ...(sb ? { split: lab(split!, sb, sk) } : {}),
        values: Object.fromEntries(measures.map((m, i) => [m.key, stats[i].value])),
        n: casesOf(stats[0]),
      });
    }

  const totals = Object.fromEntries(measures.map((m) => [m.key, m.calc(rows, cx).value]));
  const total0 = m0.calc(rows, cx);
  const groups = xKeys.map((k) => ({ label: xb ? lab(x!, xb, k) : "All", stat: xStat.get(k)! }));
  const { text, warnings } = insightFor(m0, groups, total0, x, !!xb?.natural);
  if (!rows.length) warnings.push("No rows match these filters.");

  // "Number of offers sent by channel, split by form of address used in the offer, where control group is Got the offer"
  const filterText = filters.map(({ f, def }) => `${lower(def.label)} is ${f.values?.length ? f.values.map((v) => labelOf(def, String(v), cx)).join(" or ") : `${f.min ?? "…"}–${f.max ?? "…"}`}`);
  const phrase = (m: Measure) => (m.key === "count" ? "number" : m.key === "customers" ? "distinct customers" : lower(m.label));
  const what = measures.length === 1 && m0.key === "count" ? src.label : `${cap(measures.map(phrase).join(" and "))} ${m0.key === "customers" ? "in" : "of"} ${lower(src.label)}`;
  const sentence = `${what}${x ? ` by ${lower(x.label)}` : ""}${split ? `, split by ${lower(split.label)}` : ""}${filterText.length ? `, where ${filterText.join(" and ")}` : ""}`;

  const nSeries = sb ? sKeys.length : measures.filter((m) => m.format === m0.format).length;
  return {
    title: spec.title?.trim() || sentence,
    sentence,
    chart: pickChart(spec, x, split, m0, nSeries),
    source: src.key,
    ...(x ? { x: fieldDef(x) } : {}),
    ...(split ? { split: fieldDef(split) } : {}),
    measures: measures.map(measureDef),
    categories: xKeys.map((k) => (xb ? lab(x!, xb, k) : "All")),
    series: sb ? sKeys.map((k) => lab(split!, sb, k)) : measures.map((m) => m.label),
    rows: out,
    ...(sb ? { xTotals: xKeys.map((k) => ({ x: xb ? lab(x!, xb, k) : "All", values: Object.fromEntries(measures.map((m) => [m.key, m.calc(perX.get(k) ?? [], cx).value])), n: casesOf(xStat.get(k)!) })) } : {}),
    totals,
    n: rows.length,
    insight: text,
    warnings,
  };
}

/** The values of one field with their row counts, for the filter checkboxes. */
export async function fieldValues(source: string, fieldKey: string): Promise<FieldValue[]> {
  try {
    const { src, x } = resolve({ source, x: fieldKey, measures: [] });
    const [cx, all] = await Promise.all([context(), loadDataset<Row>(src.dataset)]);
    const b = bucketer(x!, all, cx, 60);
    const n = new Map<string, number>();
    for (const r of all) for (const k of keysOf(x!, r, cx)) n.set(k, (n.get(k) ?? 0) + 1);
    return b.keys.filter((k) => k !== OTHER).map((k) => ({ value: k, label: labelOf(x!, k, cx), n: n.get(k) ?? 0 }));
  } catch (e) {
    if (e instanceof AnalyticsError) log.warn("analytics", `field values rejected: ${e.message}`, { source, field: fieldKey });
    else log.error("analytics", "field values failed", { source, field: fieldKey, error: e });
    throw e;
  }
}
