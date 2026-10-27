// One automation on the drag-and-drop canvas, with a plain-language summary and a test run.
import { ArrowLeft, Check, Play, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Flow, RunReport, Settings } from "../../../shared/types";
import { ApiError, api, reportIssue, type AutomationView } from "../api/client";
import { FlowCanvas, type FlowCatalog } from "../components/FlowCanvas";
import { Button, ErrorNote, PageBar, Skeleton, Spinner, Toggle } from "../components/ui";
import { useVocabulary } from "../lib/catalog";
import { emitDataChanged } from "../lib/useAsync";
import { RunReportView } from "./Automations";
import { InlineConfirm, NotFound } from "./Emails";

export function AutomationEditorPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const vocab = useVocabulary();
  const [a, setA] = useState<AutomationView | null>(null);
  const [missing, setMissing] = useState(false);
  const [cat, setCat] = useState<FlowCatalog | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const [test, setTest] = useState<RunReport | null>(null);
  const [testing, setTesting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<Partial<AutomationView>>({});

  useEffect(() => {
    setA(null);
    setMissing(false);
    api.automation(id).then(setA, (e) => (e instanceof ApiError && e.status === 404 ? setMissing(true) : setError(e.message)));
    api.nodeCatalog().then(setCat, () => undefined);
    api.settings().then(setSettings, () => undefined);
  }, [id]);

  const save = (patch: Partial<AutomationView>) => {
    setA((prev) => (prev ? { ...prev, ...patch } : prev));
    pending.current = { ...pending.current, ...patch };
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const body = pending.current;
      pending.current = {};
      try {
        const res = await api.updateAutomation(id, { name: body.name, description: body.description, enabled: body.enabled, flow: body.flow });
        setSaved(true);
        // The server re-adds the consent gate or approval if a flow lost them.
        setA((prev) => {
          if (!prev) return res;
          const local = new Set(prev.flow.nodes.map((n) => n.id));
          const added = res.flow.nodes.some((n) => !local.has(n.id));
          return { ...prev, summary: res.summary, flow: added ? res.flow : prev.flow };
        });
      } catch (e) {
        setError((e as Error).message);
      }
    }, 600);
  };

  const runTest = async () => {
    setTesting(true);
    try {
      if (!a?.enabled) save({ enabled: true });
      await new Promise((r) => setTimeout(r, 700));
      setTest(await api.runAutomations(id));
      emitDataChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    // A save that is still waiting would only come back for a deleted automation.
    clearTimeout(timer.current);
    pending.current = {};
    try {
      await api.deleteAutomation(id);
      emitDataChanged();
      nav("/automations");
    } catch (e) {
      setError((e as Error).message);
      reportIssue("warn", "automations", `delete ${id} failed`, { error: String(e) });
    }
  };

  if (missing) return <NotFound what="Automation" backTo="/automations" backLabel="Back to Automations" />;
  if (!a) return <>{error ? <ErrorNote error={error} className="m-6" /> : <Skeleton className="m-6 h-96" />}</>;

  return (
    <>
      <PageBar
        title={
          <span className="flex items-center gap-2">
            <Link to="/automations" className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700" aria-label="Back to automations">
              <ArrowLeft size={16} />
            </Link>
            <input
              value={a.name}
              onChange={(e) => save({ name: e.target.value })}
              style={{ width: `${Math.max(10, a.name.length + 2)}ch` }}
              className="no-drag min-w-0 max-w-[520px] rounded px-1 font-semibold hover:bg-ink-100 focus:bg-white focus:outline-none focus:ring-2 focus:ring-navy-100"
            />
          </span>
        }
        actions={
          <>
            <span className="flex items-center gap-1 text-[12px] text-ink-400">{saved ? <><Check size={13} /> Saved</> : "Saving…"}</span>
            <label className="flex items-center gap-2 text-[12.5px] text-ink-600">
              <Toggle checked={a.enabled} onChange={(v) => save({ enabled: v })} label="Enabled" /> {a.enabled ? "On" : "Off"}
            </label>
            <InlineConfirm
              onConfirm={remove}
              render={(ask) => (
                <Button size="sm" variant="ghost" icon={Trash2} onClick={ask}>
                  Delete
                </Button>
              )}
            />
            <Button size="sm" variant="primary" icon={testing ? undefined : Play} onClick={runTest} disabled={testing}>
              {testing && <Spinner />}
              Test on today's events
            </Button>
          </>
        }
      />
      <div className="shrink-0 border-b border-ink-200 bg-white px-6 py-2.5">
        <div className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-400">In plain words</div>
        <div className="text-[13px] text-ink-800">{a.summary}</div>
      </div>
      <ErrorNote error={error} className="mx-6 mt-3" />
      <div className="relative min-h-0 flex-1">
        <FlowCanvas flow={a.flow} onChange={(flow: Flow) => save({ flow })} catalog={cat} settings={settings} vocab={vocab} />
        {test && (
          <div className="absolute inset-x-4 bottom-4 z-10 max-h-[45%] overflow-y-auto rounded-xl border border-ink-200 bg-white p-4 shadow-2xl scroll-thin">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[13px] font-semibold text-ink-950">Test run on the 01.10.2026 event stream</div>
              <button onClick={() => setTest(null)} className="rounded p-1 text-ink-400 hover:bg-ink-100" aria-label="Close test results">
                <X size={14} />
              </button>
            </div>
            <RunReportView report={test} onlyAutomation={id} />
          </div>
        )}
      </div>
    </>
  );
}
