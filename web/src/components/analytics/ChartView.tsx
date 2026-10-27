// Charts for Analytics and the bubble: one renderer for every ChartResult (bar, stacked, line, KPI,
// table), the pivot table with "Copy for Excel" and CSV, and a self-running card for proposals.
import clsx from "clsx";
import { AlertTriangle, ClipboardCopy, Download, Sparkles } from "lucide-react";
import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, Rectangle, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type BarShapeProps, type DotItemDotProps } from "recharts";
import type { ChartResult, ChartRow, ChartSpec, MeasureDef, MeasureFormat } from "../../../../shared/types";
import { api } from "../../api/client";
import { fmtEur, fmtInt } from "../../lib/format";
import { motion } from "../motion";
import { Skeleton } from "../ui";

// ---------- German number format: 2.270 · 3,6 % · 72.637 € (the insight sentences from the server match) ----------

const formats = new Map<number, Intl.NumberFormat>();
/** A number with a fixed count of decimals and a decimal comma. */
export function dec(v: number, digits = 0) {
  let f = formats.get(digits);
  if (!f) formats.set(digits, (f = new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits })));
  return f.format(v);
}
/** A share (0.036) as "3,6 %". */
export const pct = (v: number, digits = 0) => `${dec(v * 100, digits)} %`;
/** Percentage points that already are points (3.6) as "+3,6 pp". */
export function pts(v: number, digits = 1) {
  const r = Number(v.toFixed(digits));
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${dec(Math.abs(r), digits)} pp`;
}
/** Decimals for a plain number: 3,82 (CSAT), 0,359 (€/kWh), 2.870 (kWh). */
const places = (v: number) => (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : Math.abs(v) >= 1 ? 2 : 3);

export function fmtValue(format: MeasureFormat, v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return "–";
  switch (format) {
    case "pct":
      return pct(v, 1);
    case "pp":
      return pts(v * 100, 1);
    case "eur":
      return fmtEur(v);
    case "num":
      return dec(v, places(v));
    default:
      return fmtInt(Math.round(v));
  }
}

// ---------- Colour ----------

// Categorical order validated for CVD and contrast (dataviz validator, light surface); brand navy first.
const PALETTE = ["#1650b0", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#6d43d1"];
const NEUTRAL = "#b9c2d3";
const NEUTRAL_DARK = "#8b96ab";
const NEGATIVE = "#eb6834";
/** Colour follows the entity: Sie and Du keep the colours they have everywhere in Kompass. */
const ENTITY: Record<string, string> = { Sie: "#1650b0", Du: "#6d43d1" };
/** Values that mean good, so-so or bad wear the status colours (fixed, never a series hue). */
const STATUS = { good: "#0ca30c", caution: "#ec835a", bad: "#d03b3b" };
const isNeutral = (s: string) => /^(Other \(|None$|Unknown$|No click$|No failure$|Not opened$|No rating$|Not given$|Ignored$|Held out$|Control group$|Apple prefetch$)/i.test(s);

type Meaning = "good" | "caution" | "bad" | "none";
const MEANING: Record<string, Meaning> = {
  granted: "good",
  completed: "good",
  delivered: "good",
  accepted: "good",
  converted: "good",
  active: "good",
  online: "good",
  interested: "good",
  clicked: "good",
  "opened by a person": "good",
  aborted: "caution",
  returned: "caution",
  dismissed: "caution",
  declined: "caution",
  "cancellation pending": "caution",
  withdrawn: "bad",
  failed: "bad",
  cancelled: "bad",
  offline: "bad",
  annoyed: "bad",
  rejected: "bad",
};
/** Yes/No fields where "Yes" is the bad answer, where neither answer is good or bad, or where "No" is just the normal case. */
const YES_IS_BAD = new Set(["c_service_case", "repeat", "guarantee_expired", "data_limit"]);
const NO_MEANING = new Set(["guest", "esim", "past_min_term", "banner", "portal_account"]);
const NO_IS_NORMAL = new Set(["converted"]);

function meaning(label: string, field?: string): Meaning | undefined {
  if (isNeutral(label)) return "none";
  const k = label.toLowerCase();
  if (k === "yes" || k === "no") {
    if (!field || NO_MEANING.has(field)) return undefined;
    if (YES_IS_BAD.has(field)) return k === "yes" ? "bad" : "good";
    if (k === "no" && NO_IS_NORMAL.has(field)) return "none";
    return k === "yes" ? "good" : "bad";
  }
  return MEANING[k];
}

/** A hex colour mixed with white (t = 0: unchanged, 1: white). */
function tint(hex: string, t: number) {
  const c = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t) + 255 * t));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Status colours when every value of the series means something (Granted, Not given, Withdrawn); never mixed with series hues. */
function semanticColors(series: string[], field?: string): string[] | null {
  const m = series.map((s) => meaning(s, field));
  if (m.some((x) => x === undefined) || !m.some((x) => x && x !== "none")) return null;
  const seen: Partial<Record<Meaning, number>> = {};
  return series.map((_, i) => {
    const k = m[i]!;
    const n = (seen[k] = (seen[k] ?? 0) + 1);
    if (k === "none") return n === 1 ? NEUTRAL : NEUTRAL_DARK;
    return n === 1 ? STATUS[k] : tint(STATUS[k], 0.45 * (n - 1));
  });
}

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h;
};

/**
 * One colour per series. Values with a meaning get status colours; Sie and Du keep theirs; "None",
 * "Unknown" and "Other" are grey. With a split field every other value gets its colour from its name,
 * not from its rank, so a filter that drops a series never repaints the others. Numbers (no field)
 * take the palette in its fixed order.
 */
export function seriesColors(series: string[], field?: string): string[] {
  const sem = semanticColors(series, field);
  if (sem) return sem;
  const free = PALETTE.filter((c) => !series.some((s) => ENTITY[s] === c));
  const out = series.map(() => "");
  let greys = 0;
  series.forEach((s, i) => {
    if (ENTITY[s]) out[i] = ENTITY[s];
    else if (isNeutral(s)) out[i] = greys++ ? NEUTRAL_DARK : NEUTRAL;
  });
  const rest = series.map((_, i) => i).filter((i) => !out[i]);
  if (!field) rest.forEach((i, k) => (out[i] = free[k] ?? NEUTRAL));
  else {
    const taken = new Set<number>();
    [...rest]
      .sort((a, b) => series[a].localeCompare(series[b]))
      .forEach((i) => {
        let k = hash(series[i]) % free.length;
        for (let tries = 0; taken.has(k) && tries < free.length; tries++) k = (k + 1) % free.length;
        if (taken.has(k)) out[i] = NEUTRAL_DARK;
        else {
          taken.add(k);
          out[i] = free[k];
        }
      });
  }
  return out;
}

// ---------- Data ----------

/** Fewer cases than this behind a rate, an average or a lift: hatched and flagged as a small sample (the server's insight skips them too). */
export const MIN_N = 30;
/** Counts and sums are exact; rates, averages and lifts are estimates that need cases behind them. */
const isAdditive = (m: MeasureDef) => m.format === "int" || m.key.endsWith("_sum");
const UNIT: Record<MeasureFormat, string> = { pct: " (%)", pp: " (pp)", eur: " (€)", num: "", int: "" };
const KIND_TITLE: Record<MeasureFormat, string> = { pct: "Rate (%)", pp: "Difference (pp)", eur: "Amount (€)", num: "Value", int: "Count" };

const isResult = (r: unknown): r is ChartResult => !!r && typeof r === "object" && Array.isArray((r as ChartResult).rows) && Array.isArray((r as ChartResult).categories);

/** The measures drawn on one axis: the first one, plus any others of the same kind (rates with rates, counts with counts). */
export function plotted(r: ChartResult): MeasureDef[] {
  if (r.split) return [r.measures[0]];
  const first = r.measures[0];
  // Plain numbers (CSAT, €/kWh, kWh…) have different units, and an average next to a sum is a different scale.
  return r.measures.filter((m, i) => i === 0 || (m.format === first.format && m.format !== "num" && isAdditive(m) === isAdditive(first)));
}

type Datum = Record<string, string | number | null>;
const nKey = (series: string) => `__n|${series}`;

/** Wide rows for recharts: one object per category, one key per series (and the cases behind each). */
function wide(r: ChartResult) {
  const ms = plotted(r);
  const series = r.split ? r.series : ms.map((m) => m.label);
  const estimated = ms.some((m) => !isAdditive(m));
  const byCat = new Map<string, ChartRow[]>();
  for (const row of r.rows) byCat.set(row.x, [...(byCat.get(row.x) ?? []), row]);
  let small = false;
  const data: Datum[] = r.categories.map((cat) => {
    const o: Datum = { x: cat, __n: 0 };
    for (const row of byCat.get(cat) ?? []) {
      o.__n = Number(o.__n) + row.n;
      if (estimated && row.n > 0 && row.n < MIN_N) small = true;
      if (r.split) {
        o[row.split ?? ""] = row.values[ms[0].key];
        o[nKey(row.split ?? "")] = row.n;
      } else
        for (const m of ms) {
          o[m.label] = row.values[m.key];
          o[nKey(m.label)] = row.n;
        }
    }
    return o;
  });
  return { data, series, format: ms[0].format, estimated, small };
}

// ---------- Axis ----------

/** A value axis on "nice" steps (1, 2 or 5 × 10ⁿ): every label is exact and the top tick is never an odd maximum. */
function niceAxis(format: MeasureFormat, lo: number, hi: number, room: { top: number; bottom: number }) {
  const k = format === "pct" || format === "pp" ? 100 : 1; // work in what the reader sees: percent, not fractions
  const min = Math.min(0, lo * k);
  let max = Math.max(0, hi * k);
  if (max === min) max = min + 1;
  const span = max - min;
  const top = max > 0 ? max + span * room.top : max;
  const bottom = min < 0 ? min - span * room.bottom : min;
  const raw = (top - bottom) / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  let step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * pow;
  if (format === "int") step = Math.max(1, step);
  const first = Math.floor(bottom / step + 1e-9) * step;
  const last = Math.ceil(top / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; first + i * step <= last + step * 1e-6; i++) ticks.push(Number((first + i * step).toFixed(10)) / k);
  return { ticks, domain: [first / k, last / k] as [number, number], digits: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) };
}

/** An axis label: the step decides the decimals, so no tick is ever rounded ("1,5 %" stays "1,5 %"). */
function tickText(format: MeasureFormat, v: number, digits: number) {
  const z = Math.abs(v) < 1e-9 ? 0 : v;
  switch (format) {
    case "pct":
      return `${dec(z * 100, digits)} %`;
    case "pp":
      return z === 0 ? "0 pp" : `${z > 0 ? "+" : "−"}${dec(Math.abs(z) * 100, digits)} pp`;
    case "eur":
      return `${dec(z, digits)} €`;
    default:
      return dec(z, digits);
  }
}

/** The lowest and highest value drawn; stacked bars add up what sits on the same side of zero. */
function extent(data: Datum[], series: string[], stacked: boolean) {
  let lo = 0;
  let hi = 0;
  for (const d of data) {
    let up = 0;
    let down = 0;
    for (const s of series) {
      const v = d[s];
      if (v == null || !Number.isFinite(Number(v))) continue;
      if (!stacked) {
        hi = Math.max(hi, Number(v));
        lo = Math.min(lo, Number(v));
      } else if (Number(v) >= 0) up += Number(v);
      else down += Number(v);
    }
    hi = Math.max(hi, up);
    lo = Math.min(lo, down);
  }
  return { lo, hi };
}

// ---------- Pieces ----------

function TooltipCard({
  active,
  payload,
  label,
  format,
  colors,
  series,
  estimated,
  split,
}: {
  active?: boolean;
  payload?: { dataKey?: unknown; value?: unknown; payload?: Record<string, unknown> }[];
  label?: unknown;
  format: MeasureFormat;
  colors: string[];
  series: string[];
  estimated: boolean;
  split: boolean;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload ?? {};
  const total = Number(row.__n ?? 0);
  const thin = (n: number) => estimated && n > 0 && n < MIN_N;
  // For a lift the cases are those of the smaller of the two groups it compares.
  const cases = (n: number) => `${thin(n) ? "small sample, " : ""}n = ${fmtInt(n)}${format === "pp" ? " (smaller group)" : ""}`;
  return (
    <div className="min-w-[150px] rounded-lg border border-ink-200 bg-white px-3 py-2 text-[12px] shadow-lg">
      <div className="mb-1 font-semibold text-ink-900">{String(label)}</div>
      {payload.map((p) => {
        const key = String(p.dataKey);
        const i = series.indexOf(key);
        const n = Number(row[nKey(key)] ?? 0);
        return (
          <div key={key}>
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-ink-600">
                <span className="h-2 w-2 rounded-sm" style={{ background: colors[i] ?? NEUTRAL }} />
                {key}
              </span>
              <span className="num whitespace-nowrap font-medium text-ink-900">{fmtValue(format, p.value as number)}</span>
            </div>
            {estimated && split && n > 0 && <div className={clsx("text-right text-[11px]", thin(n) ? "text-warn-600" : "text-ink-400")}>{cases(n)}</div>}
          </div>
        );
      })}
      {total > 0 && !(estimated && split) && <div className={clsx("mt-1 border-t border-ink-100 pt-1 text-[11px]", thin(total) && !split ? "text-warn-600" : "text-ink-400")}>{split ? `n = ${fmtInt(total)}` : cases(total)}</div>}
    </div>
  );
}

function Legend({ series, colors, title }: { series: string[]; colors: string[]; title?: string }) {
  if (series.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-600">
      {title && <span className="font-medium text-ink-500">{title}:</span>}
      {series.map((s, i) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colors[i] }} />
          {s}
        </span>
      ))}
    </div>
  );
}

/** An axis title, set as text next to its axis (names the field or number the axis shows). */
function AxisTitle({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div style={style} className={clsx("truncate text-[11px] leading-4 text-ink-400", className)}>
      {children}
    </div>
  );
}

const AXIS = { fill: "#64718a", fontSize: 11 };

interface EndLabelProps {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  value?: unknown;
}
/** A value label just past the end of its bar, on the side the value points to. */
function EndLabel({ x = 0, y = 0, width = 0, height = 0, value, horizontal, format }: EndLabelProps & { horizontal: boolean; format: MeasureFormat }) {
  const [nx, ny, w, h] = [Number(x), Number(y), Number(width), Number(height)];
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const text = fmtValue(format, v);
  if (horizontal) {
    const neg = v < 0;
    return (
      <text x={neg ? Math.min(nx, nx + w) - 5 : Math.max(nx, nx + w) + 5} y={ny + h / 2} dy={4} textAnchor={neg ? "end" : "start"} fill="#344056" fontSize={11}>
        {text}
      </text>
    );
  }
  return (
    <text x={nx + w / 2} y={v < 0 ? Math.max(ny, ny + h) + 13 : Math.min(ny, ny + h) - 5} textAnchor="middle" fill="#344056" fontSize={11}>
      {text}
    </text>
  );
}

/** What the hatching and hollow dots mean. */
function SmallNote({ dots }: { dots: boolean }) {
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-400">
      {dots ? (
        <span className="inline-block h-2 w-2 rounded-full border-[1.5px] border-ink-400 bg-white" />
      ) : (
        <span className="inline-block h-2.5 w-3.5 rounded-sm" style={{ background: "repeating-linear-gradient(135deg, #8b96ab 0 1.5px, #e8ecf3 1.5px 4px)" }} />
      )}
      {dots ? "Hollow dot" : "Hatched"}: small sample, n &lt; {MIN_N}
    </div>
  );
}

/** One big number per tile: the totals, or (with a field to compare) one tile per group after the total. */
function Tiles({ result: r }: { result: ChartResult }) {
  const m = r.measures[0];
  const estimated = !isAdditive(m);
  if (!r.x)
    return (
      <div className="grid gap-3 py-2" style={{ gridTemplateColumns: `repeat(${Math.min(r.measures.length, 3)}, minmax(0, 1fr))` }}>
        {r.measures.map((x) => (
          <Tile key={x.key} label={x.label} value={fmtValue(x.format, r.totals[x.key])} n={r.n} />
        ))}
      </div>
    );
  const groups = r.categories.map((cat) => {
    const t = r.split ? r.xTotals?.find((x) => x.x === cat) : r.rows.find((x) => x.x === cat);
    return { label: cat, value: t?.values[m.key] ?? null, n: t?.n ?? 0 };
  });
  return (
    <div className="grid gap-3 py-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
      <Tile label={`All · ${m.label}`} value={fmtValue(m.format, r.totals[m.key])} n={r.n} strong />
      {groups.map((g) => (
        <Tile key={g.label} label={g.label} value={fmtValue(m.format, g.value)} n={g.n} thin={estimated && g.n > 0 && g.n < MIN_N} />
      ))}
    </div>
  );
}

function Tile({ label, value, n, strong, thin }: { label: string; value: string; n: number; strong?: boolean; thin?: boolean }) {
  return (
    <div className={clsx("rounded-xl px-4 py-4", strong ? "bg-navy-50" : "bg-ink-50")}>
      <div className="truncate text-[12px] text-ink-500" title={label}>
        {label}
      </div>
      <div className={clsx("num mt-1 whitespace-nowrap text-[30px] font-semibold leading-none tracking-tight", thin ? "text-ink-500" : "text-ink-950")}>{value}</div>
      <div className={clsx("mt-1.5 text-[11.5px]", thin ? "text-warn-600" : "text-ink-400")}>
        {thin ? "small sample, " : ""}n = {fmtInt(n)}
      </div>
    </div>
  );
}

export function ChartVis({ result: r, height = 280 }: { result: ChartResult; height?: number }) {
  const { data, series, format, estimated, small } = useMemo(() => wide(r), [r]);
  const colors = useMemo(() => seriesColors(series, r.split?.key), [series, r.split?.key]);
  const uid = useId().replace(/\W/g, "");
  if (r.chart === "table") return <PivotTable result={r} />;
  if (r.chart === "kpi" || !r.x) return <Tiles result={r} />;

  const line = r.chart === "line";
  const stacked = r.chart === "stacked";
  const hasNegative = data.some((d) => series.some((s) => Number(d[s]) < 0));
  // Categories without a natural order read best as horizontal bars, sorted by value.
  const horizontal = !line && r.x.group !== "time" && !r.x.numeric;
  const single = series.length === 1;
  const label = single && data.length <= 14 && !stacked && !line;
  const { lo, hi } = extent(data, series, stacked);
  const ax = niceAxis(format, lo, hi, { top: label ? 0.16 : 0.05, bottom: hasNegative ? (label ? 0.24 : 0.05) : 0 });
  const tick = (v: number) => tickText(format, v, ax.digits);
  const yWidth = Math.max(40, Math.max(...ax.ticks.map((t) => tick(t).length)) * 6.3 + 12);
  const catWidth = Math.min(190, Math.max(84, Math.max(...data.map((d) => String(d.x).length)) * 6.2 + 14));
  const h = horizontal ? Math.max(160, data.length * (single ? 30 : 22 + series.length * 8) + 36) : height;

  // Axis titles: what the bars (or the line) measure, and what the categories are.
  const ms = plotted(r);
  const valueTitle = ms.length === 1 ? `${ms[0].label}${UNIT[ms[0].format]}` : KIND_TITLE[format];
  const topTitle = horizontal ? r.x.label : valueTitle;
  const bottomTitle = horizontal ? valueTitle : r.x.label;

  const tooltip = <Tooltip cursor={line ? { stroke: "#b9c2d3", strokeDasharray: "3 3" } : { fill: "rgba(22,80,176,0.06)" }} content={<TooltipCard format={format} colors={colors} series={series} estimated={estimated} split={!!r.split} />} />;
  const frame = (chart: ReactNode) => (
    <div>
      <Legend series={series} colors={colors} title={r.split?.label} />
      <AxisTitle>{topTitle}</AxisTitle>
      {chart}
      <AxisTitle className="text-center" style={{ marginLeft: horizontal ? catWidth : yWidth }}>
        {bottomTitle}
      </AxisTitle>
      {small && <SmallNote dots={line} />}
    </div>
  );

  if (line)
    return frame(
      <ResponsiveContainer width="100%" height={h}>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="#edf1f7" />
          <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: "#dde3ee" }} interval="preserveStartEnd" minTickGap={12} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={tick} width={yWidth} domain={ax.domain} ticks={ax.ticks} />
          {hasNegative && <ReferenceLine y={0} stroke="#8b96ab" />}
          {tooltip}
          {series.map((s, i) => (
            <Line
              key={s}
              type="monotone"
              dataKey={s}
              stroke={colors[i]}
              strokeWidth={2}
              // Points from fewer than 30 cases are drawn hollow.
              dot={(p: DotItemDotProps) => {
                const n = Number((p.payload as Datum | undefined)?.[nKey(s)] ?? 0);
                return estimated && n > 0 && n < MIN_N ? <circle cx={p.cx} cy={p.cy} r={4} fill="#fff" stroke={colors[i]} strokeWidth={2} /> : null;
              }}
              activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }}
              connectNulls
              animationDuration={600}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>,
    );

  // Bars from fewer than 30 cases are hatched in their own colour.
  const hatches = [...new Set([...colors, NEGATIVE])];
  const hatch = (c: string) => `url(#${uid}-h${hatches.indexOf(c)})`;
  return frame(
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 14, right: 12, bottom: 0, left: 0 }} barCategoryGap={horizontal ? "22%" : "18%"} barGap={2}>
        {small && (
          <defs>
            {hatches.map((c, i) => (
              <pattern key={c} id={`${uid}-h${i}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill={c} fillOpacity={0.2} />
                <rect width="2.4" height="6" fill={c} />
              </pattern>
            ))}
          </defs>
        )}
        <CartesianGrid horizontal={!horizontal} vertical={horizontal} stroke="#edf1f7" />
        {horizontal ? (
          <>
            <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={tick} domain={ax.domain} ticks={ax.ticks} />
            <YAxis type="category" dataKey="x" tick={AXIS} tickLine={false} axisLine={false} width={catWidth} interval={0} />
          </>
        ) : (
          <>
            <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: "#dde3ee" }} interval="preserveStartEnd" minTickGap={8} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={tick} width={yWidth} domain={ax.domain} ticks={ax.ticks} />
          </>
        )}
        {hasNegative && (horizontal ? <ReferenceLine x={0} stroke="#8b96ab" /> : <ReferenceLine y={0} stroke="#8b96ab" />)}
        {tooltip}
        {series.map((s, i) => (
          <Bar
            key={s}
            dataKey={s}
            stackId={stacked ? "a" : undefined}
            fill={colors[i]}
            maxBarSize={horizontal ? 22 : 36}
            radius={stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
            stroke={stacked ? "#fff" : undefined}
            strokeWidth={stacked ? 1 : 0}
            animationDuration={600}
            shape={(p: BarShapeProps) => {
              const d = p.payload as Datum;
              const n = Number(d?.[nKey(s)] ?? 0);
              const c = single && hasNegative && Number(d?.[s]) < 0 ? NEGATIVE : colors[i];
              return <Rectangle {...p} fill={estimated && n > 0 && n < MIN_N ? hatch(c) : c} />;
            }}
          >
            {label && <LabelList dataKey={s} content={(p) => <EndLabel {...(p as EndLabelProps)} horizontal={horizontal} format={format} />} />}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>,
  );
}

// ---------- Table ----------

/** Numbers for spreadsheets: display units, no grouping, the reader's decimal separator. */
function sheetNumber(format: MeasureFormat, v: number | null | undefined, comma: boolean) {
  if (v == null || !Number.isFinite(v)) return "";
  const n = format === "pct" || format === "pp" ? v * 100 : v;
  const s = String(Math.round(n * 100) / 100);
  return comma ? s.replace(".", ",") : s;
}

interface TableRow {
  label: string;
  cells: (number | null)[];
  /** The cases behind each cell. */
  ns: number[];
  n: number;
}

function tableModel(r: ChartResult) {
  const m = r.measures[0];
  let model: { head: string; cols: string[]; formats: MeasureFormat[]; estimated: boolean[]; rows: TableRow[]; total: { cells: (number | null)[]; n: number } };
  if (r.split) {
    const cols = [...r.series, "Total"];
    const rows = r.categories.map((cat) => {
      const cells = r.series.map((s) => r.rows.find((x) => x.x === cat && x.split === s));
      const t = r.xTotals?.find((x) => x.x === cat);
      return { label: cat, cells: [...cells.map((c) => c?.values[m.key] ?? null), t?.values[m.key] ?? null], ns: [...cells.map((c) => c?.n ?? 0), t?.n ?? 0], n: t?.n ?? 0 };
    });
    model = { head: r.x?.label ?? "", cols, formats: cols.map(() => m.format), estimated: cols.map(() => !isAdditive(m)), rows, total: { cells: [...r.series.map(() => null), r.totals[m.key]], n: r.n } };
  } else {
    const rows = r.categories.map((cat) => {
      const row = r.rows.find((x) => x.x === cat);
      return { label: cat, cells: r.measures.map((x) => row?.values[x.key] ?? null), ns: r.measures.map(() => row?.n ?? 0), n: row?.n ?? 0 };
    });
    model = { head: r.x?.label ?? "", cols: r.measures.map((x) => x.label), formats: r.measures.map((x) => x.format), estimated: r.measures.map((x) => !isAdditive(x)), rows, total: { cells: r.measures.map((x) => r.totals[x.key]), n: r.n } };
  }
  // A count is its own n: the column would only repeat the numbers next to it.
  const showN = !(model.rows.length > 0 && model.rows.every((row) => row.cells.some((v) => v != null && Math.round(v) === row.n)));
  return { ...model, showN, nHead: m.format === "pp" ? "n (smaller group)" : "n" };
}

export function exportTable(r: ChartResult, kind: "tsv" | "csv") {
  const t = tableModel(r);
  const comma = new Intl.NumberFormat(navigator.language).format(1.5).includes(",");
  const sep = kind === "tsv" ? "\t" : comma ? ";" : ",";
  const q = (s: string) => (kind === "csv" && /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [
    [t.head || "Group", ...t.cols.map((c, i) => `${c}${UNIT[t.formats[i]]}`), ...(t.showN ? [t.nHead] : [])].map(q).join(sep),
    ...t.rows.map((row) => [q(row.label), ...row.cells.map((v, i) => sheetNumber(t.formats[i], v, comma)), ...(t.showN ? [String(row.n)] : [])].join(sep)),
    ["Total", ...t.total.cells.map((v, i) => sheetNumber(t.formats[i], v, comma)), ...(t.showN ? [String(t.total.n)] : [])].map(q).join(sep),
  ];
  return lines.join("\n");
}

export function PivotTable({ result: r, maxHeight = 420 }: { result: ChartResult; maxHeight?: number }) {
  const t = tableModel(r);
  const thin = (row: TableRow, i: number) => t.estimated[i] && row.ns[i] > 0 && row.ns[i] < MIN_N;
  const anyThin = t.rows.some((row) => row.cells.some((_, i) => thin(row, i)));
  return (
    <div>
      <div className="overflow-auto rounded-lg border border-ink-200 scroll-thin" style={{ maxHeight }}>
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 bg-ink-50 text-left text-[11.5px] text-ink-500">
            <tr>
              <th className="whitespace-nowrap px-3 py-2 font-medium">{t.head || "All"}</th>
              {t.cols.map((c) => (
                <th key={c} className="whitespace-nowrap px-3 py-2 text-right font-medium">
                  {c}
                </th>
              ))}
              {t.showN && <th className="whitespace-nowrap px-3 py-2 text-right font-medium">{t.nHead}</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {t.rows.map((row) => (
              <tr key={row.label} className="hover:bg-ink-50/60">
                <td className="px-3 py-1.5 text-ink-800">{row.label}</td>
                {row.cells.map((v, i) => (
                  <td
                    key={i}
                    title={thin(row, i) ? `small sample, n = ${fmtInt(row.ns[i])}` : undefined}
                    className={clsx("num whitespace-nowrap px-3 py-1.5 text-right", thin(row, i) ? "italic text-ink-400" : i === t.cols.length - 1 && r.split ? "font-medium text-ink-900" : "text-ink-700")}
                  >
                    {fmtValue(t.formats[i], v)}
                  </td>
                ))}
                {t.showN && <td className={clsx("num whitespace-nowrap px-3 py-1.5 text-right", t.estimated[0] && row.n > 0 && row.n < MIN_N ? "text-warn-600" : "text-ink-400")}>{fmtInt(row.n)}</td>}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-ink-200 bg-ink-50/60 font-medium">
            <tr>
              <td className="px-3 py-1.5 text-ink-900">Total</td>
              {t.total.cells.map((v, i) => (
                <td key={i} className="num whitespace-nowrap px-3 py-1.5 text-right text-ink-900">
                  {v == null ? "" : fmtValue(t.formats[i], v)}
                </td>
              ))}
              {t.showN && <td className="num whitespace-nowrap px-3 py-1.5 text-right text-ink-500">{fmtInt(t.total.n)}</td>}
            </tr>
          </tfoot>
        </table>
      </div>
      {anyThin && <div className="mt-1.5 text-[11px] text-ink-400">Grey italics: small sample, n &lt; {MIN_N}</div>}
    </div>
  );
}

export function ExportButtons({ result, name }: { result: ChartResult; name: string }) {
  const [copied, setCopied] = useState<"" | "ok" | "failed">("");
  const copy = async () => {
    const text = exportTable(result, "tsv");
    let ok = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    if (!ok) {
      // Older browsers and unfocused windows: copy through a hidden text area.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    }
    setCopied(ok ? "ok" : "failed");
    setTimeout(() => setCopied(""), 1800);
  };
  const download = () => {
    const blob = new Blob([`﻿${exportTable(result, "csv")}`], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60) || "chart"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="flex items-center gap-1">
      <button onClick={copy} className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-600 hover:bg-ink-100">
        <ClipboardCopy size={13} /> {copied === "ok" ? "Copied: paste into Excel" : copied === "failed" ? "Copy failed: use CSV" : "Copy for Excel"}
      </button>
      <button onClick={download} className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-600 hover:bg-ink-100">
        <Download size={13} /> CSV
      </button>
    </div>
  );
}

export function Insight({ result, className }: { result: ChartResult; className?: string }) {
  return (
    <div className={clsx("space-y-1", className)}>
      <div className="flex items-start gap-2 text-[12.5px] leading-snug text-ink-800">
        <Sparkles size={13} className="mt-0.5 shrink-0 text-violet-600" />
        <span>{result.insight}</span>
      </div>
      {result.warnings.map((w) => (
        <div key={w} className="flex items-start gap-2 text-[11.5px] text-warn-600">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {w}
        </div>
      ))}
    </div>
  );
}

/** A chart that runs its own spec when no result is given (bubble answers, proposals, the board). */
export function ChartCard({ spec, result, compact, bare, onResult }: { spec: Record<string, unknown> | ChartSpec; result?: unknown; compact?: boolean; bare?: boolean; onResult?: (r: ChartResult) => void }) {
  const [r, setR] = useState<ChartResult | null>(isResult(result) ? result : null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(spec);
  useEffect(() => {
    if (isResult(result)) return setR(result);
    let live = true;
    api.runChart(spec as unknown as ChartSpec).then(
      (x) => {
        if (!live) return;
        setR(x);
        onResult?.(x);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, result]);
  if (error) return <div className="rounded-lg bg-bad-50 px-3 py-2 text-[12px] text-bad-600">{error}</div>;
  if (!r) return <Skeleton className={compact ? "h-40 rounded-lg" : "h-64 rounded-xl"} />;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={clsx(!bare && "rounded-xl border border-ink-200 bg-white p-3")}>
      {!bare && <div className="mb-2 text-[13px] font-semibold text-ink-950">{r.title}</div>}
      <ChartVis result={r.chart === "table" && compact ? { ...r, chart: r.x ? "bar" : "kpi" } : r} height={compact ? 170 : 260} />
      <Insight result={r} className="mt-2" />
    </motion.div>
  );
}
