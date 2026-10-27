// Automations: event-triggered flows. "Run on today's events" replays the 01.10. event stream.
import clsx from "clsx";
import { Play, Plus, TriangleAlert, Workflow } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RunReport } from "../../../shared/types";
import { api } from "../api/client";
import { unconnectedSteps } from "../components/FlowCanvas";
import { Badge, Button, Empty, ErrorNote, PageBar, Skeleton, Spinner, Toggle } from "../components/ui";
import { evLabel, fmtDateTime, fmtInt } from "../lib/format";
import { emitDataChanged, useAsync } from "../lib/useAsync";

/** The singular or plural word for a count: "1 hit", "2 hits". */
const noun = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** The runner's outcome text with channel keys and other snake_case words made plain. */
const plainOutcome = (o: string) =>
  o
    .replace(/\bportal[_ ]popup\b/g, "portal pop-up")
    .replace(/\boutbound[_ ]call\b/g, "call")
    .replace(/\bafter (\d+) d\b/g, (_, n: string) => `after ${n} ${noun(Number(n), "day")}`)
    .replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g, (k) => k.replace(/_/g, " "));

export function RunReportView({ report, onlyAutomation }: { report: RunReport; onlyAutomation?: string }) {
  const hits = onlyAutomation ? report.hits.filter((h) => h.automationId === onlyAutomation) : report.hits;
  const groups = new Map<string, RunReport["hits"]>();
  for (const h of hits) groups.set(h.automationName, [...(groups.get(h.automationName) ?? []), h]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px] text-ink-500">
        <span>
          <b className="num text-ink-900">{fmtInt(report.events)}</b> {noun(report.events, "event")} on 01.10.2026
        </span>
        <span>
          <b className="num text-ink-900">{fmtInt(report.duplicates)}</b> {noun(report.duplicates, "duplicate")} ignored
        </span>
        <span>
          <b className="num text-ink-900">{fmtInt(report.late)}</b> arrived late, processed in event order
        </span>
        <span>
          <b className="num text-good-600">{fmtInt(report.proposalsCreated)}</b> {noun(report.proposalsCreated, "message or task", "messages and tasks")} waiting for approval
        </span>
        {report.cancelled > 0 && (
          <span>
            <b className="num text-warn-600">{fmtInt(report.cancelled)}</b> queued {noun(report.cancelled, "message")} cancelled
          </span>
        )}
      </div>
      <div className="divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white">
        {[...groups.entries()].map(([name, list]) => (
          <div key={name}>
            <button onClick={() => setOpen((o) => (o === name ? null : name))} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-ink-50" aria-expanded={open === name}>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-900">
                {name}
                <span className="ml-2 text-[12px] font-normal text-ink-400">{[...new Set(list.map((h) => evLabel(h.event)))].join(", ")}</span>
              </span>
              <span className="num text-[12.5px] text-ink-500">
                {fmtInt(list.length)} {noun(list.length, "hit")}
              </span>
            </button>
            {open === name && (
              <ul className="max-h-72 space-y-1 overflow-y-auto border-t border-ink-100 bg-ink-50/50 px-4 py-2 text-[12.5px] scroll-thin">
                {list.map((h, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="num w-24 shrink-0 text-ink-400">{h.at.slice(11, 16) || "00:00"}</span>
                    <span className="w-44 shrink-0 truncate text-ink-800">
                      {h.customerName} <span className="text-ink-400">{h.customerId}</span>
                    </span>
                    <span className={clsx("min-w-0 flex-1", h.outcome.startsWith("cancelled") ? "text-warn-600" : h.outcome.includes("blocked") || h.outcome.includes("no consent") || h.outcome.includes("silent") || h.outcome.includes("contact limit") ? "text-ink-400" : "text-ink-700")}>{plainOutcome(h.outcome)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {groups.size === 0 && <p className="px-4 py-3 text-[12.5px] text-ink-500">No automation matched an event.</p>}
      </div>
    </div>
  );
}

export function AutomationsPage() {
  const nav = useNavigate();
  const { data, error, loading, reload, setData } = useAsync(() => api.automations(), []);
  const last = useAsync(() => api.lastRun(), []);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setErr(null);
    try {
      const r = await api.runAutomations();
      last.setData(r);
      reload();
      emitDataChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  const create = async () => {
    const a = await api.createAutomation({ name: "New automation" });
    nav(`/automations/${a.id}`);
  };
  const toggle = async (id: string, enabled: boolean) => {
    setData((list) => list?.map((a) => (a.id === id ? { ...a, enabled } : a)));
    await api.updateAutomation(id, { enabled });
  };

  return (
    <>
      <PageBar
        title="Automations"
        subtitle="When something happens to a customer, react personally. Every message waits for approval."
        actions={
          <>
            <Button icon={Plus} onClick={create}>
              New automation
            </Button>
            <Button variant="primary" icon={running ? undefined : Play} onClick={run} disabled={running}>
              {running && <Spinner />}
              Run on today's events
            </Button>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto page-scroll px-6 py-5 scroll-thin">
        <ErrorNote error={error ?? err} className="mb-4" />
        {loading && !data && <Skeleton className="h-48" />}
        {data?.length === 0 && <Empty icon={Workflow} title="No automations" hint="Create one and drag steps onto the canvas." />}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-3">
          {data?.map((a) => {
            const orphans = unconnectedSteps(a.flow).length;
            return (
              <div key={a.id} onClick={() => nav(`/automations/${a.id}`)} className={clsx("cursor-pointer rounded-xl border bg-white p-4 hover:border-navy-700/40", a.enabled ? "border-ink-200" : "border-dashed border-ink-200 opacity-75")}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-ink-950">{a.name}</div>
                    <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-500">{a.description}</div>
                  </div>
                  <span onClick={(e) => e.stopPropagation()}>
                    <Toggle checked={a.enabled} onChange={(v) => toggle(a.id, v)} label={a.enabled ? "Disable" : "Enable"} />
                  </span>
                </div>
                <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-[12px] leading-relaxed text-ink-600">{a.summary}</div>
                {orphans > 0 && (
                  <div className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-warn-600">
                    <TriangleAlert size={13} className="shrink-0" />
                    {orphans} {noun(orphans, "step is", "steps are")} not connected and will never run
                  </div>
                )}
                <div className="mt-2.5 flex items-center gap-2 text-[12px] text-ink-500">
                  {a.stats.lastRunAt ? (
                    <>
                      <Badge tint={a.stats.hits ? "navy" : "neutral"}>
                        {fmtInt(a.stats.hits)} {noun(a.stats.hits, "hit")}
                      </Badge>
                      <Badge tint={a.stats.proposals ? "good" : "neutral"}>{a.stats.proposals} to approve</Badge>
                      <span className="ml-auto text-ink-400">ran {fmtDateTime(a.stats.lastRunAt)}</span>
                    </>
                  ) : (
                    <span className="text-ink-400">{a.enabled ? "Not run yet" : "Off"}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {last.data && (
          <div className="mt-8">
            <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-ink-400">Last run</div>
            <RunReportView report={last.data} />
          </div>
        )}
      </div>
    </>
  );
}
