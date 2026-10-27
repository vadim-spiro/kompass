// Home: what needs you today. Approvals first, then campaigns, automation hits and rising problems.
import { Check, ChevronDown, ChevronRight, ClipboardList, Inbox, Mail, Play, Radio, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { Proposal } from "../../../shared/types";
import { api } from "../api/client";
import { ApproveAllDialog, proposalIcon, ProposalRow, ReviewSheet } from "../components/approvals";
import { Badge, Button, Card, ErrorNote, Figure, PageBar, SectionTitle, Skeleton, Spinner } from "../components/ui";
import { evLabel, fmtDelta, fmtEur, fmtInt, fmtPp, humanize, plural } from "../lib/format";
import { beforeDay, clockLabel, useLive } from "../lib/live";
import { emitDataChanged, useAsync, useDataChanged } from "../lib/useAsync";

export function HomePage() {
  const nav = useNavigate();
  const home = useAsync(() => api.home(), []);
  const pending = useAsync(() => api.proposals("pending"), []);
  const [running, setRunning] = useState(false);
  const [review, setReview] = useState<Proposal | null>(null);
  const [params, setParams] = useSearchParams();
  const reviewId = params.get("review");
  const live = useLive();
  const reload = useCallback(() => {
    home.reload();
    pending.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useDataChanged(reload);

  // "/?review=<id>" (a decision in the live stream links here) opens that draft's review once it is loaded.
  useEffect(() => {
    if (!reviewId || !pending.data) return;
    const p = pending.data.find((x) => x.id === reviewId);
    if (p) setReview(p);
    setParams(
      (q) => {
        q.delete("review");
        return q;
      },
      { replace: true },
    );
  }, [reviewId, pending.data, setParams]);

  const groups = useMemo(() => {
    const m = new Map<string, { source: Proposal["source"]; items: Proposal[] }>();
    for (const p of pending.data ?? []) {
      const g = m.get(p.source.id) ?? { source: p.source, items: [] };
      g.items.push(p);
      m.set(p.source.id, g);
    }
    return [...m.values()].sort((a, b) => b.items.length - a.items.length);
  }, [pending.data]);

  const runToday = async () => {
    setRunning(true);
    try {
      await api.runAutomations();
      emitDataChanged();
    } finally {
      setRunning(false);
    }
  };

  const d = home.data;
  const ls = live.state;
  const idle = beforeDay(ls);

  return (
    <>
      <PageBar
        title="Today"
        subtitle={idle ? "Customer data as of 30.09.2026 · press play to replay 01.10. as it arrives" : `Live stream at ${clockLabel(ls!.clock)} · ${plural(ls!.counts.decisions, "decision")} so far`}
        actions={
          <>
            <Button size="sm" variant="ghost" icon={running ? undefined : Workflow} onClick={runToday} disabled={running} title="Run every automation on all of the day's events at once">
              {running ? (
                <>
                  <Spinner /> Running…
                </>
              ) : (
                "Run all at once"
              )}
            </Button>
            <Button size="sm" variant="primary" icon={live.playing ? undefined : idle ? Play : Radio} onClick={() => (live.playing ? nav("/live") : idle ? (live.play(), nav("/live")) : nav("/live"))}>
              {live.playing ? "Watching live…" : idle ? "Play today's events" : "Open the live stream"}
            </Button>
          </>
        }
      />
      <div className="flex-1 overflow-y-auto page-scroll scroll-thin">
        <div className="@container mx-auto max-w-[1280px] space-y-5 px-6 py-5">
          <ErrorNote error={home.error ?? pending.error} />
          {d ? (
            <Card className="grid grid-cols-2 gap-5 p-5 @2xl:grid-cols-3 @5xl:grid-cols-6">
              <Figure label="Customers" value={fmtInt(d.kpis.customers)} />
              <Figure label="Revenue at risk (CLV × churn)" value={fmtEur(d.kpis.valueAtRiskEur)} tone="warn" />
              <Figure label="Open service cases" value={fmtInt(d.kpis.serviceCases)} tone={d.kpis.serviceCases ? "bad" : undefined} />
              <Figure label="Customers with a good next step" value={fmtInt(d.kpis.customersWithAction)} />
              <Figure label="CLV if all are taken" value={fmtDelta(d.kpis.opportunityEur)} tone="good" />
              <Figure label="Customers could save, per year" value={fmtEur(d.kpis.savingsEur)} />
            </Card>
          ) : (
            <Skeleton className="h-24" />
          )}

          <div className="grid gap-5 @5xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 space-y-3">
              <SectionTitle>Waiting for your approval{pending.data ? ` · ${pending.data.length}` : ""}</SectionTitle>
              {!pending.data && <Skeleton className="h-64" />}
              {pending.data && groups.length === 0 && (
                <Card className="flex items-center gap-3 px-4 py-3.5">
                  <Inbox size={18} className="shrink-0 text-ink-400" />
                  <p className="text-[13px] text-ink-600">Nothing waiting. Automations and campaigns put their drafts here; play today's events to watch them arrive.</p>
                </Card>
              )}
              {groups.map((g) => (
                <ApprovalGroup key={g.source.id} source={g.source} items={g.items} onChanged={emitDataChanged} onOpen={setReview} />
              ))}
              <ReviewSheet p={review} onClose={() => setReview(null)} onChanged={emitDataChanged} />
            </div>

            <div className="min-w-0 space-y-5">
              <Card className="p-5">
                <SectionTitle action={<Link to="/campaigns" className="text-[12px] text-ink-500 hover:text-ink-800">All campaigns</Link>}>Campaigns</SectionTitle>
                {!d && <Skeleton className="h-20" />}
                {d && d.campaignsInReview.length + d.running.length === 0 && <p className="text-[13px] text-ink-400">No campaign in review or running.</p>}
                <ul className="space-y-2.5">
                  {d?.campaignsInReview.map((c) => (
                    <li key={c.id}>
                      <button onClick={() => nav(`/campaigns/${c.id}?step=review`)} className="flex w-full items-center justify-between gap-2 text-left">
                        <span className="min-w-0">
                          <span className="block truncate text-[13.5px] font-medium text-ink-900">{c.name}</span>
                          <span className="text-[12px] text-ink-500">
                            {c.approvals.length >= 2 ? "Both approvals in" : `${c.approvals.length} of 2 approvals`}
                            {c.plan ? ` · ${plural(c.plan.summary.contacts, "contact")}` : ""}
                          </span>
                        </span>
                        {c.approvals.length >= 2 ? <Badge tint="good">Ready to send</Badge> : <Badge tint="warn">In review</Badge>}
                      </button>
                    </li>
                  ))}
                  {d?.running.map((c) => (
                    <li key={c.id}>
                      <button onClick={() => nav(`/campaigns/${c.id}?step=results`)} className="flex w-full items-center justify-between gap-2 text-left">
                        <span className="min-w-0">
                          <span className="block truncate text-[13.5px] font-medium text-ink-900">{c.name}</span>
                          {c.results && (
                            <span className="text-[12px] text-ink-500">
                              {fmtPp(c.results.upliftPp)} vs control · {fmtDelta(c.results.realisedDclvEur)} CLV
                            </span>
                          )}
                        </span>
                        <Badge tint="good">Running</Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card className="p-5">
                <SectionTitle action={<Link to="/automations" className="text-[12px] text-ink-500 hover:text-ink-800">Automations</Link>}>What the automations did</SectionTitle>
                {!d && <Skeleton className="h-20" />}
                {d && d.recentHits.length === 0 && <p className="text-[13px] text-ink-400">Nothing yet today.</p>}
                <ul className="space-y-2">
                  {d?.recentHits.slice(0, 8).map((h, i) => (
                    <li key={i} className="flex gap-2.5">
                      <Workflow size={14} className="mt-0.5 shrink-0 text-ink-400" />
                      <div className="min-w-0 text-[12.5px]">
                        <div className="truncate text-ink-800">
                          <Link to={`/customers/${h.customerId}`} className="font-medium hover:underline">
                            {h.customerName}
                          </Link>{" "}
                          · {h.automationName}
                        </div>
                        <div className="truncate text-ink-500" title={h.outcome}>
                          {evLabel(h.event)} → {[...new Set(h.outcome.split("; "))].join("; ")}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card className="p-5">
                <SectionTitle>Biggest problems</SectionTitle>
                {!d && <Skeleton className="h-20" />}
                <ul className="space-y-2">
                  {d?.topPains.map((p) => (
                    <li key={p.key}>
                      <Link to={`/customers?pain=${p.key}`} className="flex items-baseline justify-between gap-3 text-[13px] hover:underline">
                        <span className="min-w-0 truncate text-ink-800">{humanize(p.key)}</span>
                        <span className="num shrink-0 text-ink-500">
                          {fmtInt(p.customers)} · {fmtEur(p.valueAtRiskEur)} at risk
                        </span>
                      </Link>
                      <div className="truncate text-[11.5px] text-ink-400">{p.label}</div>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ApprovalGroup({ source, items, onChanged, onOpen }: { source: Proposal["source"]; items: Proposal[]; onChanged: () => void; onOpen: (p: Proposal) => void }) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bulk = async (approve: boolean) => {
    setBusy("all");
    try {
      const r = await api.bulkProposals({ ids: items.map((p) => p.id), approve });
      setConfirm(false);
      setNotice(r.cancelled.length ? `${plural(r.updated, "draft")} ${approve ? "approved" : "rejected"}. ${plural(r.cancelled.length, "draft")} stopped instead: ${r.cancelled[0].reason}${r.cancelled.length > 1 ? " …" : ""}` : null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const decide = async (p: Proposal, approve: boolean) => {
    setBusy(p.id);
    try {
      await (approve ? api.approveProposal(p.id) : api.rejectProposal(p.id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      onChanged();
    }
  };
  const Icon = source.kind === "automation" ? Workflow : source.kind === "campaign" ? Mail : ClipboardList;
  const shown = showAll ? items : items.slice(0, 5);
  const channels = useMemo(() => {
    const m = new Map<string, { icon: ReturnType<typeof proposalIcon>["icon"]; n: number }>();
    for (const p of items) {
      const ic = proposalIcon(p);
      m.set(ic.label, { icon: ic.icon, n: (m.get(ic.label)?.n ?? 0) + 1 });
    }
    return [...m.entries()];
  }, [items]);
  return (
    <Card>
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown size={15} className="text-ink-400" /> : <ChevronRight size={15} className="text-ink-400" />}
          <Icon size={15} className="shrink-0 text-ink-500" />
          <span className="truncate text-[14px] font-semibold text-ink-900">{source.name}</span>
          <span className="flex shrink-0 items-center gap-2 text-[12px] text-ink-500">
            {channels.map(([label, c]) => (
              <span key={label} className="inline-flex items-center gap-1" title={label}>
                <c.icon size={13} />
                <span className="num">{c.n}</span>
              </span>
            ))}
          </span>
        </button>
        <Button size="sm" variant="ghost" onClick={() => bulk(false)} disabled={!!busy}>
          Reject all
        </Button>
        <Button size="sm" variant="primary" icon={Check} onClick={() => setConfirm(true)} disabled={!!busy}>
          Approve all {items.length}
        </Button>
      </div>
      <ErrorNote error={error} className="mx-4 mb-3" />
      {notice && <p className="mx-4 mb-3 rounded-lg bg-warn-50 px-3 py-2 text-[12.5px] text-warn-600">{notice}</p>}
      {open && (
        <ul className="divide-y divide-ink-100 border-t border-ink-100">
          {shown.map((p) => (
            <ProposalRow key={p.id} p={p} busy={busy === p.id || busy === "all"} onOpen={() => onOpen(p)} onDecide={(a) => decide(p, a)} />
          ))}
          {items.length > 5 && (
            <li className="px-4 py-2 text-center">
              <button onClick={() => setShowAll((v) => !v)} className="text-[12.5px] font-medium text-ink-500 hover:text-ink-800">
                {showAll ? "Show fewer" : `Show all ${items.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
      {confirm && <ApproveAllDialog items={items} busy={busy === "all"} onCancel={() => setConfirm(false)} onConfirm={() => bulk(true)} />}
    </Card>
  );
}
