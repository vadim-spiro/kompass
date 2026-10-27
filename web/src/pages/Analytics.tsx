// Analytics: a board of saved questions answered with charts, a drag-and-drop builder (shelves, a
// sentence view, chart and table), and the standard reports. The Kompass bubble builds and changes
// charts here through the same controls the user sees.
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import clsx from "clsx";
import { ArrowLeft, ArrowUpRight, BarChart3, Check, ChevronDown, Clock, Copy, Filter, Hash, Plus, Tag, Trash2, User, Users, X, Zap, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { ChartFilter, ChartKind, ChartResult, ChartSpec, FieldDef, FieldValue, MeasureDef, SavedChart, SourceDef } from "../../../shared/types";
import { api, reportIssue } from "../api/client";
import { ChartCard, ChartVis, ExportButtons, Insight, plotted } from "../components/analytics/ChartView";
import { AnimatePresence, EASE, motion, Stagger, StaggerItem } from "../components/motion";
import { Badge, Button, Empty, ErrorNote, PageBar, Segmented, Skeleton, Spinner, Tabs } from "../components/ui";
import { screenStore, useScreen, type UiArgs, type UiHandlerDef } from "../lib/screen";
import { fmtAgo, fmtInt } from "../lib/format";
import { StandardReports } from "./Performance";

let catalogCache: Promise<SourceDef[]> | null = null;
function useCatalog() {
  const [cat, setCat] = useState<SourceDef[] | null>(null);
  useEffect(() => {
    catalogCache ??= api.analyticsCatalog().catch((e) => {
      catalogCache = null;
      throw e;
    });
    catalogCache.then(setCat, () => undefined);
  }, []);
  return cat;
}

const valuesCache = new Map<string, Promise<FieldValue[]>>();
function useFieldValues(source: string, field: string) {
  const [vals, setVals] = useState<FieldValue[] | null>(null);
  useEffect(() => {
    const k = `${source}|${field}`;
    if (!valuesCache.has(k)) valuesCache.set(k, api.fieldValues(source, field));
    let live = true;
    valuesCache.get(k)!.then(
      (v) => live && setVals(v),
      () => valuesCache.delete(k),
    );
    return () => {
      live = false;
    };
  }, [source, field]);
  return vals;
}

/** A label inside a sentence starts in lower case, but "CSAT score" and "SMS" keep their capitals. */
const lower = (s: string) => (/^[A-Z]{2,}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The spec without its title, so two specs compare equal whatever they are called. */
const stripTitle = (s: ChartSpec): ChartSpec => ({ ...s, title: undefined });
const specKey = (s: ChartSpec) => JSON.stringify(stripTitle(s));

// ---------- Board ----------

export function AnalyticsPage() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") === "reports" ? "reports" : "charts";
  const nav = useNavigate();
  const [charts, setCharts] = useState<SavedChart[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api.charts().then(
        (c) => {
          setCharts(c);
          setError(null);
        },
        (e: Error) => setError(e.message),
      ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const fail = (what: string, c: SavedChart, e: unknown) => {
    setError(`Could not ${what} “${c.title}”: ${(e as Error).message}`);
    reportIssue("warn", "analytics", `${what} chart failed`, { id: c.id, error: (e as Error).message });
  };
  const duplicate = async (c: SavedChart) => {
    try {
      await api.createChart({ title: `${c.title} (copy)`, spec: c.spec });
      await load();
    } catch (e) {
      fail("duplicate", c, e);
    }
  };
  // The card asks "Delete? Yes / No" itself; this runs after the Yes.
  const remove = async (c: SavedChart) => {
    try {
      await api.deleteChart(c.id);
      setCharts((cs) => cs?.filter((x) => x.id !== c.id) ?? null);
    } catch (e) {
      fail("delete", c, e);
    }
  };

  // The bubble's chart actions open the builder first, then run there.
  const viaBuilder = (name: string, target: (a: UiArgs) => string): UiHandlerDef => ({
    prepare: async () => {
      nav("/analytics/new");
      await waitForBuilder();
    },
    target,
    run: async (a) => (await waitForBuilder()).actions[name].run(a),
  });
  useScreen(
    "analytics",
    { view: "analytics", title: `Analytics · ${charts?.length ?? 0} charts`, data: { screen: tab === "charts" ? "board" : "standard reports", charts: charts?.map((c) => ({ id: c.id, title: c.title })) } },
    {
      set_chart: viaBuilder("set_chart", () => "chart-shelves"),
      add_field: viaBuilder("add_field", (a) => `shelf:${String(a.shelf)}`),
      set_chart_type: viaBuilder("set_chart_type", () => "chart-type"),
    },
  );

  // An odd last card spans both columns, so no card sits alone in its row.
  const spanLast = !!charts && charts.length > 2 && charts.length % 2 === 1;
  return (
    <>
      <PageBar
        title="Analytics"
        subtitle="Answer questions with charts: drag fields, or ask Kompass. Measured on MAINGAU's data from 30.09.2026."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => nav("/analytics/new")}>
            New chart
          </Button>
        }
      />
      <div className="shrink-0 bg-white px-6 pt-3">
        <Tabs
          value={tab}
          onChange={(t) => setSp(t === "charts" ? {} : { tab: t }, { replace: true })}
          options={[
            { value: "charts", label: "Your charts", count: charts?.length },
            { value: "reports", label: "Standard reports" },
          ]}
        />
      </div>
      {tab === "reports" ? (
        <StandardReports />
      ) : (
        <div className="flex-1 overflow-y-auto page-scroll px-6 py-5 scroll-thin">
          <ErrorNote error={error} className="mb-4" />
          {!charts && !error && (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-72 rounded-xl" />
              ))}
            </div>
          )}
          {charts?.length === 0 && <Empty icon={BarChart3} title="No charts yet" hint="Create one, or ask Kompass a question about the data." />}
          {charts && charts.length > 0 && (
            <Stagger className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {charts.map((c, i) => (
                <StaggerItem key={c.id} className={clsx(spanLast && i === charts.length - 1 && "xl:col-span-2")}>
                  <BoardCard chart={c} onDuplicate={() => duplicate(c)} onDelete={() => remove(c)} />
                </StaggerItem>
              ))}
            </Stagger>
          )}
        </div>
      )}
    </>
  );
}

async function waitForBuilder() {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const cur = screenStore.get();
    if (cur?.snapshot.data?.builder) return cur;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error("The chart builder did not open.");
}

/** The whole card opens the chart (Enter works too); the two small buttons and the delete question stay out of that. */
function BoardCard({ chart, onDuplicate, onDelete }: { chart: SavedChart; onDuplicate: () => void; onDelete: () => void }) {
  const nav = useNavigate();
  const [res, setRes] = useState<ChartResult | null>(null);
  const [asking, setAsking] = useState(false);
  const open = () => nav(`/analytics/${chart.id}`);
  const icon = "grid h-7 w-7 place-items-center rounded-md text-ink-500 transition-colors";
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Open chart: ${chart.title}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === "Enter") open();
      }}
      className="group flex h-full cursor-pointer flex-col rounded-xl border border-ink-200 bg-white p-4 transition-[border-color,box-shadow] hover:border-navy-700/40 hover:shadow-[0_2px_10px_rgba(10,42,102,0.06)] focus-visible:rounded-xl"
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1 text-[14.5px] font-semibold leading-snug text-ink-950 group-hover:text-navy-800">
            {chart.title}
            <ArrowUpRight size={14} className="shrink-0 text-navy-700 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </h3>
          <p className="mt-0.5 line-clamp-2 min-h-[18px] text-[12px] leading-snug text-ink-500" title={res?.sentence}>
            {res ? cap(res.sentence) : " "}
          </p>
        </div>
        {chart.origin === "kompass" && <Badge tint="violet">By Kompass</Badge>}
      </div>
      <div className="flex-1">
        <ChartCard spec={chart.spec} compact bare onResult={setRes} />
      </div>
      <div
        className="mt-3 flex min-h-[36px] items-center gap-1.5 border-t border-ink-100 pt-2.5 text-[12px] text-ink-400"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") setAsking(false);
        }}
      >
        <span className="num min-w-0 flex-1 truncate">{[res ? `n = ${fmtInt(res.n)}` : "", chart.origin === "starter" ? "" : `Edited ${fmtAgo(chart.updatedAt)}`].filter(Boolean).join(" · ")}</span>
        {asking ? (
          <div className="flex items-center gap-1.5" role="group" aria-label="Confirm delete">
            <span className="font-medium text-bad-600">Delete?</span>
            <button
              onClick={() => {
                setAsking(false);
                onDelete();
              }}
              aria-label={`Yes, delete ${chart.title}`}
              className="rounded-md bg-bad-600 px-2.5 py-1 font-medium text-white hover:bg-bad-600/90"
            >
              Yes
            </button>
            <button onClick={() => setAsking(false)} autoFocus aria-label="No, keep the chart" className="rounded-md border border-ink-200 bg-white px-2.5 py-1 font-medium text-ink-700 hover:bg-ink-50">
              No
            </button>
          </div>
        ) : (
          <>
            <button onClick={onDuplicate} title="Duplicate chart" aria-label={`Duplicate ${chart.title}`} className={clsx(icon, "hover:bg-ink-100 hover:text-ink-800")}>
              <Copy size={15} />
            </button>
            <button onClick={() => setAsking(true)} title="Delete chart" aria-label={`Delete ${chart.title}`} className={clsx(icon, "ml-1 hover:bg-bad-50 hover:text-bad-600")}>
              <Trash2 size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Builder ----------

type Shelf = "x" | "split" | "measure" | "filter";
interface DragItem {
  kind: "field" | "measure";
  key: string;
  label: string;
}
const DEFAULT_SPEC: ChartSpec = { source: "offers", measures: ["count"] };
const CHART_TYPES: { value: ChartKind; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "bar", label: "Bars" },
  { value: "stacked", label: "Stacked" },
  { value: "line", label: "Line" },
  { value: "kpi", label: "Number" },
  { value: "table", label: "Table" },
];
const KIND_NAME: Record<Exclude<ChartKind, "auto">, string> = { bar: "bars", stacked: "stacked bars", line: "line", kpi: "number", table: "table" };

/** Questions an empty builder starts from; a click fills the shelves. */
const STARTERS: { title: string; hint: string; icon: LucideIcon; spec: ChartSpec }[] = [
  { title: "Conversion by channel vs control", hint: "Which channels beat the customers we held back?", icon: BarChart3, spec: { source: "offers", x: "channel", split: "control_group", measures: ["conversion_rate"] } },
  {
    title: "Du vs Sie in retention",
    hint: "Does the form of address change who converts?",
    icon: Users,
    spec: { source: "offers", x: "tone", measures: ["conversion_rate"], filters: [{ field: "offer_type", values: ["retention"] }, { field: "control_group", values: ["false"] }] },
  },
  { title: "Best hour to reach customers", hint: "When do customers respond to an offer?", icon: Clock, spec: { source: "offers", x: "hour", measures: ["response_rate"] } },
  { title: "Why charging fails", hint: "Failed charging sessions, by reason.", icon: Zap, spec: { source: "charging", x: "failure_reason", measures: ["count"], filters: [{ field: "status", values: ["failed"] }] } },
];

/** Applies one shelf drop to a spec, the way a drag or the bubble's add_field does it. */
function withField(spec: ChartSpec, shelf: Shelf, key: string, values?: string[]): ChartSpec {
  if (shelf === "measure") return spec.measures.includes(key) ? spec : { ...spec, measures: [...spec.measures.filter((m) => m !== "count" || spec.measures.length > 1), key] };
  if (shelf === "x") return { ...spec, x: key, split: spec.split === key ? undefined : spec.split };
  if (shelf === "split") return key === spec.x ? spec : { ...spec, split: key };
  const filters = (spec.filters ?? []).filter((f) => f.field !== key);
  return { ...spec, filters: [...filters, { field: key, values: values ?? [] }] };
}

/** Keeps only what exists in the source, so switching sources never breaks the chart. */
function fitSource(spec: ChartSpec, src: SourceDef): ChartSpec {
  const has = (k?: string) => !!k && src.fields.some((f) => f.key === k);
  const measures = spec.measures.filter((m) => src.measures.some((x) => x.key === m));
  return { ...spec, source: src.key, x: has(spec.x) ? spec.x : undefined, split: has(spec.split) ? spec.split : undefined, measures: measures.length ? measures : ["count"], filters: (spec.filters ?? []).filter((f) => has(f.field)) };
}

const fieldIcon = (f: FieldDef): LucideIcon => (f.group === "time" ? Clock : f.group === "customer" ? User : Tag);

/** Nothing chosen yet: just "number of …" of the source. */
const isPristine = (s: ChartSpec) => !s.x && !s.split && !s.filters?.length && s.measures.length === 1 && s.measures[0] === "count" && (s.chart ?? "auto") === "auto";

export function ChartBuilderPage() {
  const { id = "new" } = useParams();
  // One builder per chart: opening another chart (or a new one) never carries over a title or a spec.
  return <ChartBuilder key={id} id={id} />;
}

function ChartBuilder({ id }: { id: string }) {
  const isNew = id === "new";
  const nav = useNavigate();
  const location = useLocation();
  const catalog = useCatalog();
  // A report can hand over a spec ("Open as editable chart"); it is read once and then dropped from the
  // history entry, so a reload or /analytics/new on its own always starts empty.
  const [seed] = useState(() => (isNew ? ((location.state as { spec?: ChartSpec } | null)?.spec ?? null) : null));
  const [spec, setSpec] = useState<ChartSpec | null>(isNew ? (seed ? stripTitle(seed) : DEFAULT_SPEC) : null);
  // The title follows the chart until the person types their own. A saved title is theirs; a title that comes with a
  // spec (a report, a starter, the bubble) lasts for exactly that spec.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const pinned = useRef<{ key: string; title: string } | null>(seed?.title ? { key: specKey(seed), title: seed.title } : null);
  const savedTitle = useRef<string | null>(null);
  const savedKey = useRef("");
  const [result, setResult] = useState<ChartResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const lastKey = useRef("");

  useEffect(() => {
    if (isNew && location.state) nav(`${location.pathname}${location.search}`, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isNew) return;
    api.chart(id).then(
      (c) => {
        savedKey.current = JSON.stringify([c.title, stripTitle(c.spec)]);
        savedTitle.current = c.title;
        setTitleDraft(c.title);
        setSpec(c.spec);
      },
      (e: Error) => {
        setError(e.message);
        reportIssue("warn", "analytics", "could not open chart", { id, error: e.message });
      },
    );
  }, [id, isNew]);

  const run = useCallback(async (s: ChartSpec) => {
    const k = JSON.stringify(s);
    lastKey.current = k;
    setRunning(true);
    try {
      const r = await api.runChart({ ...s, title: undefined });
      if (lastKey.current === k) {
        setResult(r);
        setError(null);
      }
      return r;
    } catch (e) {
      if (lastKey.current === k) setError((e as Error).message);
      throw e;
    } finally {
      if (lastKey.current === k) setRunning(false);
    }
  }, []);

  useEffect(() => {
    if (!spec) return;
    const k = JSON.stringify(spec);
    if (k === lastKey.current) return;
    const t = setTimeout(() => run(spec).catch(() => undefined), 120);
    return () => clearTimeout(t);
  }, [spec, run]);

  // A saved title that is just what the chart would be called anyway keeps following the chart.
  useEffect(() => {
    if (!result || savedTitle.current == null) return;
    if (result.title === savedTitle.current) setTitleDraft(null);
    savedTitle.current = null;
  }, [result]);

  const key = spec ? specKey(spec) : "";
  const pristine = !!spec && isNew && isPristine(spec);
  // Nothing chosen yet: the title stays empty instead of calling the starting point "Offers sent".
  const autoTitle = pristine ? "" : ((pinned.current?.key === key ? pinned.current.title : result?.title) ?? "");
  const shownTitle = titleDraft ?? autoTitle;
  const effTitle = shownTitle.trim() || result?.title || "Untitled chart";

  // Saved charts save themselves; a new chart is saved with the button.
  useEffect(() => {
    if (isNew || !spec) return;
    const k = JSON.stringify([effTitle, stripTitle(spec)]);
    if (k === savedKey.current) {
      setSaved(true);
      return;
    }
    setSaved(false);
    const t = setTimeout(
      () =>
        api.updateChart(id, { title: effTitle, spec: stripTitle(spec) }).then(
          () => {
            savedKey.current = k;
            setSaved(true);
          },
          (e: Error) => {
            setError(`Could not save: ${e.message}`);
            reportIssue("warn", "analytics", "auto-save failed", { id, error: e.message });
          },
        ),
      600,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, effTitle]);

  const src = catalog?.find((s) => s.key === spec?.source);
  const fieldOf = (k?: string) => src?.fields.find((f) => f.key === k);
  const measureOf = (k: string) => src?.measures.find((m) => m.key === k);
  const update = (next: ChartSpec) => setSpec(next);

  /** For the bubble: validate by running, then show it. A title given with the spec lasts for that spec. */
  const applyNow = async (next: ChartSpec, title?: string | null) => {
    const r = await run(next);
    if (title !== undefined) {
      pinned.current = title ? { key: specKey(next), title } : null;
      setTitleDraft(null);
    }
    setSpec(next);
    return `The chart now shows: ${r.sentence} (n = ${r.n}). Insight: ${r.insight}`;
  };

  useScreen(
    "analytics",
    {
      view: "analytics",
      title: `Analytics · ${shownTitle || "New chart"}`,
      data: {
        builder: true,
        chart_id: isNew ? null : id,
        spec,
        sentence: result?.sentence,
        insight: result?.insight,
        n: result?.n,
        rows: result?.rows.slice(0, 10),
        fields: src?.fields.map((f) => f.key),
        measures: src?.measures.map((m) => m.key),
      },
    },
    {
      set_chart: {
        target: () => "chart-shelves",
        run: async (a) => {
          const raw = (a.spec ?? a) as ChartSpec;
          // The model sometimes sends filter values as booleans or numbers (c_service_case: [true]); the builder works with text.
          const filters = raw.filters?.map((f) => (Array.isArray(f.values) ? { ...f, values: f.values.map(String) } : f));
          const next: ChartSpec = { ...raw, filters, measures: raw.measures?.length ? raw.measures : ["count"] };
          return applyNow({ ...next, title: undefined }, raw.title ?? null);
        },
      },
      add_field: {
        target: (a) => `shelf:${String(a.shelf)}`,
        run: async (a) => {
          if (!spec) throw new Error("No chart is open.");
          const shelf = String(a.shelf) as Shelf;
          return applyNow(withField(spec, shelf, String(a.field), Array.isArray(a.values) ? a.values.map(String) : undefined));
        },
      },
      set_chart_type: {
        target: () => "chart-type",
        run: async (a) => {
          if (!spec) throw new Error("No chart is open.");
          return applyNow({ ...spec, chart: String(a.chart) as ChartKind });
        },
      },
    },
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragStart = (e: DragStartEvent) => setDragging((e.active.data.current as DragItem) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    const item = e.active.data.current as DragItem | undefined;
    setDragging(null);
    const shelf = e.over?.id as Shelf | undefined;
    if (!item || !shelf || !spec) return;
    if ((shelf === "measure") !== (item.kind === "measure")) return;
    update(withField(spec, shelf, item.key));
    if (shelf === "filter") setOpenFilter(item.key);
  };
  const clickField = (key: string) => {
    if (!spec) return;
    update(withField(spec, !spec.x ? "x" : !spec.split && key !== spec.x ? "split" : "x", key));
  };
  const clickMeasure = (key: string) => {
    if (!spec) return;
    if (spec.measures.includes(key)) {
      if (spec.measures.length > 1) update({ ...spec, measures: spec.measures.filter((m) => m !== key) });
    } else update(withField(spec, "measure", key));
  };
  const setFilter = (f: ChartFilter | null, field: string) => {
    if (!spec) return;
    const rest = (spec.filters ?? []).filter((x) => x.field !== field);
    update({ ...spec, filters: f ? [...rest, f] : rest });
  };
  const pickStarter = (s: (typeof STARTERS)[number]) => {
    pinned.current = { key: specKey(s.spec), title: s.title };
    setTitleDraft(null);
    update(s.spec);
  };

  const fail = (what: string, e: unknown) => {
    setError(`Could not ${what}: ${(e as Error).message}`);
    reportIssue("warn", "analytics", `${what} failed`, { id, error: (e as Error).message });
  };
  const save = async () => {
    if (!spec) return;
    try {
      const c = await api.createChart({ title: effTitle, spec: stripTitle(spec) });
      nav(`/analytics/${c.id}`, { replace: true });
    } catch (e) {
      fail("save the chart", e);
    }
  };
  const duplicate = async () => {
    if (!spec) return;
    try {
      const c = await api.createChart({ title: `${effTitle} (copy)`, spec: stripTitle(spec) });
      nav(`/analytics/${c.id}`);
    } catch (e) {
      fail("duplicate the chart", e);
    }
  };
  const remove = async () => {
    try {
      await api.deleteChart(id);
      nav("/analytics");
    } catch (e) {
      setAsking(false);
      fail("delete the chart", e);
    }
  };

  return (
    <>
      <PageBar
        title={
          <span className="flex items-center gap-2">
            <Link to="/analytics" className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700" aria-label="Back to Analytics">
              <ArrowLeft size={16} />
            </Link>
            <input
              value={shownTitle}
              placeholder={(!pristine && result?.title) || "New chart"}
              title="The title follows the chart until you type your own"
              aria-label="Chart title"
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => titleDraft != null && !titleDraft.trim() && setTitleDraft(null)}
              style={{ width: `${Math.max(16, (shownTitle || result?.title || "").length + 2)}ch` }}
              className="no-drag min-w-0 max-w-[620px] rounded px-1 font-semibold placeholder:text-ink-400 hover:bg-ink-100 focus:bg-white focus:outline-none focus:ring-2 focus:ring-navy-100"
            />
          </span>
        }
        actions={
          isNew ? (
            <Button variant="primary" icon={Check} onClick={save} disabled={!result || pristine} title={pristine ? "Pick a question or a field first" : undefined}>
              Save chart
            </Button>
          ) : (
            <>
              <span className="flex items-center gap-1 text-[12px] text-ink-400">{saved ? <><Check size={13} /> Saved</> : "Saving…"}</span>
              <Button variant="ghost" size="sm" icon={Copy} onClick={duplicate}>
                Duplicate
              </Button>
              {asking ? (
                <span className="flex items-center gap-1.5 text-[12.5px]" role="group" aria-label="Confirm delete">
                  <span className="font-medium text-bad-600">Delete?</span>
                  <Button variant="danger" size="sm" onClick={remove} aria-label="Yes, delete this chart">
                    Yes
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setAsking(false)} autoFocus aria-label="No, keep the chart">
                    No
                  </Button>
                </span>
              ) : (
                <Button variant="ghost" size="sm" icon={Trash2} onClick={() => setAsking(true)}>
                  Delete
                </Button>
              )}
            </>
          )
        }
      />
      {!spec || !catalog || !src ? (
        <div className="p-6">
          <ErrorNote error={error} />
          {!error && <Skeleton className="h-96 rounded-xl" />}
        </div>
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
          <div className="flex min-h-0 flex-1">
            <FieldPalette catalog={catalog} src={src} spec={spec} onSource={(s) => update(fitSource(spec, s))} onField={clickField} onMeasure={clickMeasure} />
            <div className="min-w-0 flex-1 overflow-y-auto page-scroll scroll-thin">
              <div className="mx-auto max-w-[1080px] space-y-4 px-6 py-5">
                <div data-ai="chart-shelves" className="space-y-1.5 rounded-xl border border-ink-200 bg-white p-3">
                  <ShelfRow id="x" label="Compare" role="rows" tip="Like Rows in an Excel pivot table: one bar for each value of this field" hint="Drop a field here, e.g. Channel or Hour of day" dragging={dragging}>
                    {spec.x && <PlacedChip icon={fieldIcon(fieldOf(spec.x)!)} label={fieldOf(spec.x)?.label ?? spec.x} onRemove={() => update({ ...spec, x: undefined, split: undefined })} />}
                  </ShelfRow>
                  <ShelfRow id="split" label="Split by" role="colour" tip="Like Columns in an Excel pivot table: each value of this field becomes a colour" hint="Optional: a second field, shown as colours" dragging={dragging}>
                    {spec.split && <PlacedChip icon={fieldIcon(fieldOf(spec.split)!)} label={fieldOf(spec.split)?.label ?? spec.split} onRemove={() => update({ ...spec, split: undefined })} />}
                  </ShelfRow>
                  <ShelfRow id="measure" label="Show" role="values" tip="Like Values in an Excel pivot table: the number to calculate for each bar" hint="Drop a number here" dragging={dragging}>
                    {spec.measures.map((m) => (
                      <PlacedChip key={m} icon={Hash} tone="navy" label={measureOf(m)?.label ?? m} onRemove={spec.measures.length > 1 ? () => update({ ...spec, measures: spec.measures.filter((x) => x !== m) }) : undefined} />
                    ))}
                  </ShelfRow>
                  <ShelfRow id="filter" label="Only include" role="filter" tip="Like Filters in an Excel pivot table: keep only rows with these values" hint="Drop a field to keep only some of its values" dragging={dragging}>
                    {(spec.filters ?? []).map((f) => (
                      <FilterChip key={f.field} source={spec.source} field={fieldOf(f.field)} filter={f} open={openFilter === f.field} onToggle={() => setOpenFilter((o) => (o === f.field ? null : f.field))} onChange={(nf) => setFilter(nf, f.field)} />
                    ))}
                  </ShelfRow>
                </div>

                <Sentence src={src} catalog={catalog} spec={spec} onChange={update} result={result} />

                {pristine ? (
                  <StarterPanel onPick={pickStarter} />
                ) : (
                  <div className="rounded-xl border border-ink-200 bg-white">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-2.5">
                      <div className="flex items-center gap-2 text-[12.5px] text-ink-500">
                        {running ? <Spinner /> : null}
                        {result ? (
                          <span>
                            n = <b className="num text-ink-800">{fmtInt(result.n)}</b> {lower(src.label)}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        {result && <ExportButtons result={result} name={shownTitle || result.title} />}
                        <div data-ai="chart-type">
                          <Segmented
                            value={spec.chart ?? "auto"}
                            options={CHART_TYPES.map((t) => (t.value === "auto" && result && (spec.chart ?? "auto") === "auto" ? { ...t, label: `Auto · ${result.chart === "bar" && result.split ? "grouped bars" : KIND_NAME[result.chart]}` } : t))}
                            onChange={(v) => update({ ...spec, chart: v })}
                          />
                        </div>
                      </div>
                    </div>
                    <div className={clsx("relative px-4 py-4 transition-opacity", running && result && "opacity-60")}>
                      <ErrorNote error={error} className="mb-3" />
                      {!result && !error && <Skeleton className="h-72 rounded-lg" />}
                      <AnimatePresence mode="wait" initial={false}>
                        {result && (
                          <motion.div key={`${result.source}|${result.chart}|${result.x?.key}|${result.split?.key}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.25, ease: EASE }}>
                            <ChartVis result={result} height={320} />
                            {result.chart !== "table" && result.chart !== "kpi" && plotted(result).length < result.measures.length && (
                              <div className="mt-2 text-[11.5px] text-ink-400">The chart shows {plotted(result).map((m) => lower(m.label)).join(" and ")}; the table has all of them.</div>
                            )}
                            {result.chart === "kpi" && result.x && (
                              <div className="mt-2 text-[11.5px] text-ink-400">Number shows {result.split ? "each group as a whole, without the split" : `${lower(result.measures[0].label)} for each group`}. Pick Bars or Table to compare them side by side.</div>
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    {result && <Insight result={result} className="border-t border-ink-100 px-4 py-3" />}
                  </div>
                )}
              </div>
            </div>
          </div>
          <DragOverlay dropAnimation={null}>{dragging && <div className="rounded-md border border-navy-700 bg-white px-2 py-1 text-[12.5px] font-medium text-navy-800 shadow-lg">{dragging.label}</div>}</DragOverlay>
        </DndContext>
      )}
    </>
  );
}

/** What an empty builder offers instead of one lonely number. */
function StarterPanel({ onPick }: { onPick: (s: (typeof STARTERS)[number]) => void }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-white px-5 py-5">
      <div className="text-[14.5px] font-semibold text-ink-950">What do you want to find out?</div>
      <p className="mt-0.5 text-[12.5px] text-ink-500">Start from a question, or drag a field onto Compare above.</p>
      <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
        {STARTERS.map((s) => (
          <button key={s.title} onClick={() => onPick(s)} className="group flex items-start gap-3 rounded-lg border border-ink-200 px-3.5 py-3 text-left transition-colors hover:border-navy-700/40 hover:bg-navy-50/50">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-navy-50 text-navy-700 group-hover:bg-white">
              <s.icon size={16} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-semibold text-ink-900">{s.title}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-ink-500">{s.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function FieldPalette({ catalog, src, spec, onSource, onField, onMeasure }: { catalog: SourceDef[]; src: SourceDef; spec: ChartSpec; onSource: (s: SourceDef) => void; onField: (k: string) => void; onMeasure: (k: string) => void }) {
  const used = new Set([spec.x, spec.split, ...(spec.filters ?? []).map((f) => f.field)].filter(Boolean));
  const groups: { title: string; fields: FieldDef[] }[] = [
    { title: `About the ${lower(src.label)}`, fields: src.fields.filter((f) => f.group === "own") },
    { title: "When", fields: src.fields.filter((f) => f.group === "time") },
    { title: "About the customer", fields: src.fields.filter((f) => f.group === "customer") },
  ].filter((g) => g.fields.length);
  return (
    <aside className="w-[272px] shrink-0 overflow-y-auto border-r border-ink-200 bg-white px-4 py-4 scroll-thin">
      <label className="mb-1 block text-[11.5px] font-semibold uppercase tracking-wider text-ink-400">Data</label>
      <select
        data-ai="source"
        value={src.key}
        onChange={(e) => onSource(catalog.find((s) => s.key === e.target.value)!)}
        className="w-full rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-[13.5px] font-medium text-ink-900 focus:outline-none focus:ring-2 focus:ring-navy-100"
      >
        {catalog.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
      <p className="mt-1.5 text-[11.5px] leading-snug text-ink-500">{src.description}</p>

      <div className="mt-4 text-[11.5px] font-semibold uppercase tracking-wider text-ink-400">Numbers</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {src.measures.map((m) => (
          <PaletteChip key={m.key} item={{ kind: "measure", key: m.key, label: m.label }} icon={Hash} active={spec.measures.includes(m.key)} title={m.description} onClick={() => onMeasure(m.key)} />
        ))}
      </div>
      <div className="mt-4 text-[11.5px] font-semibold uppercase tracking-wider text-ink-400">Compare by</div>
      <p className="text-[11.5px] text-ink-400">Drag onto a shelf, or click.</p>
      {groups.map((g) => (
        <div key={g.title} className="mt-2.5">
          <div className="mb-1 text-[11.5px] font-medium text-ink-500">{g.title}</div>
          <div className="flex flex-wrap gap-1.5">
            {g.fields.map((f) => (
              <PaletteChip key={f.key} item={{ kind: "field", key: f.key, label: f.label }} icon={fieldIcon(f)} active={used.has(f.key)} onClick={() => onField(f.key)} />
            ))}
          </div>
        </div>
      ))}
    </aside>
  );
}

function PaletteChip({ item, icon: Icon, active, title, onClick }: { item: DragItem; icon: LucideIcon; active: boolean; title?: string; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `${item.kind}:${item.key}`, data: item });
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onClick}
      title={title}
      data-ai={`${item.kind}:${item.key}`}
      className={clsx(
        "flex cursor-grab items-center gap-1 rounded-md border px-2 py-1 text-[12.5px] transition-colors active:cursor-grabbing",
        isDragging && "opacity-40",
        active ? (item.kind === "measure" ? "border-navy-700 bg-navy-900 text-white" : "border-navy-700/50 bg-navy-50 text-navy-800") : "border-ink-200 bg-white text-ink-700 hover:border-ink-300 hover:bg-ink-50",
      )}
    >
      <Icon size={12} className={active && item.kind === "measure" ? "text-white/80" : "text-ink-400"} />
      {item.label}
    </button>
  );
}

/** One shelf: its name, the pivot-table word for it (rows, colour, values, filter) and what to drop. */
function ShelfRow({ id, label, role, tip, hint, dragging, children }: { id: Shelf; label: string; role: string; tip: string; hint: string; dragging: DragItem | null; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const fits = !!dragging && (id === "measure") === (dragging.kind === "measure");
  const empty = !children || (Array.isArray(children) && children.length === 0);
  return (
    <div
      ref={setNodeRef}
      data-ai={`shelf:${id}`}
      className={clsx(
        "flex min-h-[46px] items-center gap-3 rounded-lg border border-dashed px-2.5 py-1.5 transition-colors",
        fits && isOver ? "border-navy-700 bg-navy-50" : fits ? "border-navy-700/40 bg-navy-50/40" : "border-ink-200",
      )}
    >
      <span className="w-[96px] shrink-0 leading-tight" title={tip}>
        <span className="block text-[11px] font-semibold uppercase tracking-wider text-ink-400">{label}</span>
        <span className="block text-[11.5px] text-ink-400">{role}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        <AnimatePresence initial={false}>{children}</AnimatePresence>
        {empty && <span className="text-[12px] text-ink-400">{hint}</span>}
      </div>
    </div>
  );
}

function PlacedChip({ icon: Icon, label, tone = "neutral", onRemove }: { icon: LucideIcon; label: string; tone?: "neutral" | "navy"; onRemove?: () => void }) {
  return (
    <motion.span
      layout
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.85 }}
      transition={{ duration: 0.2, ease: EASE }}
      className={clsx("flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] font-medium", tone === "navy" ? "bg-navy-900 text-white" : "bg-navy-50 text-navy-800 ring-1 ring-navy-700/30")}
    >
      <Icon size={12} className="opacity-70" />
      {label}
      {onRemove && (
        <button onClick={onRemove} className="-mr-0.5 ml-0.5 rounded p-0.5 opacity-60 hover:bg-white/20 hover:opacity-100" aria-label={`Remove ${label}`}>
          <X size={12} />
        </button>
      )}
    </motion.span>
  );
}

function FilterChip({ source, field, filter, open, onToggle, onChange }: { source: string; field?: FieldDef; filter: ChartFilter; open: boolean; onToggle: () => void; onChange: (f: ChartFilter | null) => void }) {
  const values = useFieldValues(source, filter.field);
  const labelOf = (v: string) => values?.find((x) => x.value === v || String(x.label).toLowerCase() === String(v).toLowerCase())?.label ?? v;
  const picked = (filter.values ?? []).map(String);
  const range = filter.min != null || filter.max != null ? `${filter.min ?? "…"}–${filter.max ?? "…"}` : "";
  const text = picked.length ? (picked.length <= 2 ? picked.map(labelOf).join(", ") : `${picked.length} values`) : range || "pick values";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onToggle();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, onToggle]);
  const toggle = (v: string) => {
    const on = picked.some((p) => p === v || labelOf(p) === labelOf(v));
    onChange({ ...filter, values: on ? picked.filter((p) => p !== v && labelOf(p) !== labelOf(v)) : [...picked, v] });
  };
  return (
    <motion.div layout initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} className="relative" ref={ref}>
      <span className="flex items-center gap-1 rounded-md bg-sun-100 px-2 py-1 text-[12.5px] text-navy-950 ring-1 ring-sun-400/70">
        <button onClick={onToggle} className="flex items-center gap-1">
          <Filter size={11} className="opacity-60" />
          <span className="font-medium">{field?.label ?? filter.field}:</span> {text}
        </button>
        <button onClick={() => onChange(null)} className="ml-0.5 rounded p-0.5 opacity-60 hover:bg-white/50 hover:opacity-100" aria-label="Remove filter">
          <X size={12} />
        </button>
      </span>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="absolute left-0 top-full z-30 mt-1 w-[260px] rounded-xl border border-ink-200 bg-white p-2 shadow-xl"
          >
            {field?.numeric && (
              <div className="mb-2 flex items-center gap-1.5 border-b border-ink-100 px-1 pb-2 text-[12px] text-ink-600">
                From
                <input type="number" value={filter.min ?? ""} onChange={(e) => onChange({ ...filter, min: e.target.value === "" ? undefined : Number(e.target.value) })} className="w-16 rounded border border-ink-200 px-1.5 py-0.5" />
                to
                <input type="number" value={filter.max ?? ""} onChange={(e) => onChange({ ...filter, max: e.target.value === "" ? undefined : Number(e.target.value) })} className="w-16 rounded border border-ink-200 px-1.5 py-0.5" />
              </div>
            )}
            <div className="max-h-[260px] overflow-y-auto scroll-thin">
              {!values && <Skeleton className="h-24" />}
              {values?.map((v) => {
                const on = picked.some((p) => p === v.value || labelOf(p) === v.label);
                return (
                  <label key={v.value} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px] hover:bg-ink-50">
                    <input type="checkbox" checked={on} onChange={() => toggle(v.value)} className="accent-navy-700" />
                    <span className="flex-1 truncate text-ink-800">{v.label}</span>
                    <span className="num text-[11.5px] text-ink-400">{fmtInt(v.n)}</span>
                  </label>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** What a number is called inside the sentence: "number" of offers, "distinct customers" in offers, "conversion rate" of offers. */
const phrase = (m: MeasureDef) => (m.key === "count" ? "number" : m.key === "customers" ? "distinct customers" : lower(m.label));

/** The chart as a sentence; every bold word is a dropdown, and clauses that are empty stay out of the sentence. */
function Sentence({ src, catalog, spec, onChange, result }: { src: SourceDef; catalog: SourceDef[]; spec: ChartSpec; onChange: (s: ChartSpec) => void; result: ChartResult | null }) {
  const m0 = spec.measures[0];
  const fields = (skip?: string) => src.fields.filter((f) => f.key !== skip).map((f) => ({ value: f.key, label: lower(f.label) }));
  const filterText = useMemo(() => {
    const s = result?.sentence ?? "";
    const i = s.indexOf(", where ");
    return i >= 0 ? s.slice(i + 2) : "";
  }, [result]);
  return (
    <p data-ai="chart-sentence" className="px-1 text-[15px] leading-loose text-ink-600">
      Show{" "}
      <Pick value={m0} options={src.measures.map((m: MeasureDef) => ({ value: m.key, label: phrase(m) }))} onChange={(v) => onChange({ ...spec, measures: [v, ...spec.measures.slice(1).filter((x) => x !== v)] })} /> {m0 === "customers" ? "in" : "of"}{" "}
      <Pick value={src.key} options={catalog.map((s) => ({ value: s.key, label: lower(s.label) }))} onChange={(v) => onChange(fitSource(spec, catalog.find((s) => s.key === v)!))} />
      {spec.x && (
        <>
          {" "}
          by <Pick value={spec.x} options={[{ value: "", label: "no comparison (one number)" }, ...fields()]} onChange={(v) => onChange({ ...spec, x: v || undefined, split: v && v !== spec.split ? spec.split : undefined })} />
        </>
      )}
      {spec.x && spec.split && (
        <>
          , split by <Pick value={spec.split} options={[{ value: "", label: "no split" }, ...fields(spec.x)]} onChange={(v) => onChange({ ...spec, split: v || undefined })} />
        </>
      )}
      {filterText && <span className="text-ink-500">, {filterText}</span>}.
      {/* Empty clauses are not written out; a quiet dropdown after the sentence adds them. */}
      {!spec.x && (
        <span className="ml-2">
          <Pick ghost value="" options={[{ value: "", label: "+ compare by…" }, ...fields()]} onChange={(v) => v && onChange({ ...spec, x: v, split: v === spec.split ? undefined : spec.split })} />
        </span>
      )}
      {spec.x && !spec.split && (
        <span className="ml-2">
          <Pick ghost value="" options={[{ value: "", label: "+ split by…" }, ...fields(spec.x)]} onChange={(v) => v && onChange({ ...spec, split: v })} />
        </span>
      )}
    </p>
  );
}

function Pick({ value, options, onChange, ghost }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; ghost?: boolean }) {
  return (
    <span className="relative inline-block max-w-full align-baseline">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(
          "field-sizing-content max-w-full cursor-pointer appearance-none rounded bg-transparent py-0.5 pl-0.5 pr-4 focus:outline-none focus:ring-2 focus:ring-navy-100",
          ghost
            ? "border border-dashed border-ink-300 pl-1.5 text-[12.5px] font-medium text-ink-500 hover:border-navy-700/50 hover:text-navy-800"
            : "font-semibold text-navy-800 underline decoration-navy-700/40 decoration-dotted underline-offset-4 hover:bg-navy-50",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={ghost ? 12 : 13} className={clsx("pointer-events-none absolute right-1 top-1/2 -translate-y-1/2", ghost ? "text-ink-400" : "text-navy-700/70")} />
    </span>
  );
}
