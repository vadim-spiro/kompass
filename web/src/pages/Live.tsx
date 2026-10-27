// Live stream: the 01.10.2026 events as they reach Kompass, and every decision it takes on them.
import clsx from "clsx";
import { FastForward, Pause, Play, Radio, RotateCcw, SkipForward } from "lucide-react";
import { useMemo, useState } from "react";
import { DecisionCard, EventRow, lag } from "../components/live";
import { AnimatePresence, motion } from "../components/motion";
import { Button, Card, Empty, ErrorNote, Figure, PageBar, SectionTitle, Segmented, Skeleton } from "../components/ui";
import { beforeDay, clockLabel, SPEEDS, useLive } from "../lib/live";
import { fmtInt } from "../lib/format";
import { useScreen } from "../lib/screen";

type EventFilter = "signals" | "all" | "traps";

export function LivePage() {
  const live = useLive();
  const s = live.state;
  const [filter, setFilter] = useState<EventFilter>("signals");
  const freshIds = useMemo(() => new Set(live.fresh.map((d) => d.id)), [live.fresh]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of s?.decisions ?? []) if (d.customerName) m.set(d.customerId, d.customerName);
    for (const d of s?.desk ?? []) m.set(d.customerId, d.customerName);
    return m;
  }, [s?.decisions, s?.desk]);

  const events = useMemo(() => {
    const all = [...(s?.events ?? [])].reverse();
    if (filter === "signals") return all.filter((e) => e.signal && !e.flags.includes("duplicate"));
    if (filter === "traps") return all.filter((e) => e.flags.length > 0);
    return all;
  }, [s?.events, filter]);

  useScreen("live", {
    view: "live",
    title: s ? `Live stream · ${clockLabel(s.clock)}` : "Live stream",
    data: s ? { clock: s.clock, counts: s.counts, latestDecisions: s.decisions.slice(0, 8).map((d) => ({ at: d.at, customer: d.customerId, event: d.eventLabel, outcome: d.headline })) } : {},
  });

  const progress = s ? Math.min(1, Math.max(0, (ms(s.clock) - ms(s.start)) / (ms(s.end) - ms(s.start)))) : 0;
  const idle = beforeDay(s);
  const done = !!s && s.clock >= s.end;

  return (
    <>
      <PageBar
        title="Live stream"
        subtitle="01.10.2026 replayed as the systems delivered it: late batches, duplicates and all. Each signal makes Kompass decide again."
        actions={
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={live.reset} disabled={live.busy || idle}>
            Start over
          </Button>
        }
      />
      <div className="flex-1 overflow-y-auto page-scroll scroll-thin">
        <div className="@container mx-auto max-w-[1280px] space-y-5 px-6 py-5">
          <ErrorNote error={live.error} />
          {!s ? (
            <Skeleton className="h-40" />
          ) : (
            <>
              <Card className="p-5">
                <div className="flex flex-wrap items-center gap-4">
                  <button
                    onClick={() => (live.playing ? live.pause() : live.play())}
                    disabled={done}
                    className={clsx("grid h-12 w-12 shrink-0 place-items-center rounded-full text-white shadow-sm transition-colors disabled:bg-ink-300", live.playing ? "bg-violet-600" : "bg-navy-900 hover:bg-navy-800")}
                    aria-label={live.playing ? "Pause" : "Play"}
                  >
                    {live.playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
                  </button>
                  <div className="min-w-[180px]">
                    <div className="num text-[22px] font-semibold leading-tight tracking-tight text-ink-950">{idle ? "30.09. 23:59" : clockLabel(s.clock)}</div>
                    <div className="text-[12.5px] text-ink-500">{idle ? "Snapshot before the day. Press play." : done ? "Every event has arrived." : live.playing ? "Playing…" : "Paused"}</div>
                  </div>
                  <Segmented value={String(live.speed)} options={SPEEDS.map((x) => ({ value: String(x.minutes), label: x.label }))} onChange={(v) => live.setSpeed(Number(v))} />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" icon={SkipForward} onClick={live.nextDecision} disabled={!s.next || live.busy || live.playing} title={s.next ? `${s.next.label} (${s.next.customerId})` : undefined}>
                      Next decision{s.next ? ` · ${clockLabel(s.next.at, false).slice(s.next.at.startsWith(s.day) ? 7 : 0)}` : ""}
                    </Button>
                    <Button size="sm" icon={FastForward} onClick={() => live.step(60)} disabled={done || live.busy || live.playing}>
                      +1 hour
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => live.jumpTo(s.end)} disabled={done || live.busy || live.playing}>
                      To the end
                    </Button>
                  </div>
                </div>
                <div className="mt-4">
                  <div className="relative h-2 overflow-hidden rounded-full bg-ink-100">
                    <motion.div className="absolute inset-y-0 left-0 rounded-full bg-violet-600" animate={{ width: `${progress * 100}%` }} transition={{ duration: 0.4 }} />
                  </div>
                  <div className="mt-1.5 flex justify-between text-[11px] text-ink-400">
                    <span>01.10. 00:00</span>
                    <span>The day ends at midnight; late batches keep arriving until {clockLabel(s.end)}</span>
                  </div>
                </div>
              </Card>

              <Card className="grid grid-cols-2 gap-5 p-5 @2xl:grid-cols-4 @5xl:grid-cols-7">
                <Figure label="Events received" value={`${fmtInt(s.counts.applied)} / ${fmtInt(s.counts.total)}`} />
                <Figure label="Duplicates dropped" value={fmtInt(s.counts.duplicates)} />
                <Figure label="Arrived late (> 1 h)" value={fmtInt(s.counts.late)} tone={s.counts.late ? "warn" : undefined} />
                <Figure label="Out of order" value={fmtInt(s.counts.outOfOrder)} />
                <Figure label="Decisions taken" value={fmtInt(s.counts.decisions)} />
                <Figure label="Queued messages stopped" value={fmtInt(s.counts.cancelled)} tone={s.counts.cancelled ? "bad" : undefined} />
                <Figure label="Drafts for approval" value={fmtInt(s.counts.created)} tone={s.counts.created ? "good" : undefined} />
              </Card>

              <div className="grid gap-5 @5xl:grid-cols-[minmax(0,1fr)_400px]">
                <div className="min-w-0 space-y-3">
                  <SectionTitle>Decisions · newest first</SectionTitle>
                  {s.decisions.length === 0 ? (
                    <Card className="p-6">
                      <Empty icon={Radio} title="No decisions yet" hint="Press play. Each consent change, ticket, call, cart or failed charge makes Kompass decide again for that customer, and the reason lands here." />
                    </Card>
                  ) : (
                    <ul className="space-y-2.5">
                      <AnimatePresence initial={false}>
                        {s.decisions.slice(0, 80).map((d) => (
                          <motion.div key={d.id} layout initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
                            <DecisionCard d={d} fresh={freshIds.has(d.id)} />
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </ul>
                  )}
                </div>

                <div className="min-w-0 space-y-5">
                  <Card>
                    <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
                      <h3 className="text-[14px] font-semibold text-ink-900">Event stream</h3>
                      <Segmented
                        value={filter}
                        options={[
                          { value: "signals", label: "Signals" },
                          { value: "traps", label: "Traps" },
                          { value: "all", label: "All" },
                        ]}
                        onChange={setFilter}
                      />
                    </div>
                    {events.length === 0 ? (
                      <p className="px-4 py-6 text-center text-[13px] text-ink-400">{idle ? "Nothing has arrived yet." : "No events of this kind so far."}</p>
                    ) : (
                      <ul className="max-h-[520px] divide-y divide-ink-100 overflow-y-auto px-4 scroll-thin">
                        {events.slice(0, 150).map((e) => (
                          <EventRow key={e.id} e={e} name={names.get(e.customerId)} />
                        ))}
                      </ul>
                    )}
                  </Card>

                  <Card>
                    <div className="border-b border-ink-100 px-4 py-3">
                      <h3 className="text-[14px] font-semibold text-ink-900">Learned from agents</h3>
                      <p className="mt-0.5 text-[12px] text-ink-500">Feedback on suggestions changes what Kompass offers that customer next.</p>
                    </div>
                    {s.feedback.length === 0 ? (
                      <p className="px-4 py-5 text-center text-[13px] text-ink-400">No feedback yet. Agents give it on the service desk.</p>
                    ) : (
                      <ul className="divide-y divide-ink-100 px-4">
                        {s.feedback.slice(0, 8).map((f) => (
                          <li key={f.id} className="py-2 text-[12.5px]">
                            <span className="font-medium text-ink-900">{f.product}</span>
                            <span className="text-ink-600"> · {FEEDBACK_LABEL[f.action]}</span>
                            <div className="text-[11.5px] text-ink-500">
                              {names.get(f.customerId) ?? f.customerId} · {f.source === "stream" ? "from the CRM" : "on the desk"} · {f.at.slice(11, 16)}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>

                  <Card>
                    <div className="border-b border-ink-100 px-4 py-3">
                      <h3 className="text-[14px] font-semibold text-ink-900">How fresh is each source?</h3>
                      <p className="mt-0.5 text-[12px] text-ink-500">Delay between an event happening and reaching Kompass, so far today.</p>
                    </div>
                    {s.freshness.length === 0 ? (
                      <p className="px-4 py-6 text-center text-[13px] text-ink-400">Fills as events arrive.</p>
                    ) : (
                      <table className="w-full text-[12.5px]">
                        <thead>
                          <tr className="text-left text-[11px] uppercase tracking-wide text-ink-500">
                            <th className="px-4 py-2 font-medium">Source</th>
                            <th className="px-2 py-2 text-right font-medium">Typical</th>
                            <th className="px-2 py-2 text-right font-medium">Worst</th>
                            <th className="px-4 py-2 text-right font-medium">Late</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-ink-100">
                          {s.freshness.map((f) => (
                            <tr key={f.source} title={f.refresh}>
                              <td className="px-4 py-2">
                                <div className="font-medium text-ink-800">{f.label}</div>
                                <div className="text-[11px] text-ink-500">{f.refresh}</div>
                              </td>
                              <td className="num px-2 py-2 text-right text-ink-700">{lag(f.medianLagMin)}</td>
                              <td className={clsx("num px-2 py-2 text-right", f.maxLagMin > 60 ? "font-semibold text-warn-600" : "text-ink-700")}>{lag(f.maxLagMin)}</td>
                              <td className="num px-4 py-2 text-right text-ink-700">{f.late ? `${f.late} of ${f.events}` : "–"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </Card>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

const FEEDBACK_LABEL: Record<string, string> = { mentioned: "mentioned to the customer", not_relevant: "not relevant: no longer suggested", upset: "customer upset: no sales for 30 days", has_it: "already has it: dropped" };

const ms = (s: string) => new Date(`${s.replace(" ", "T")}Z`).getTime();
