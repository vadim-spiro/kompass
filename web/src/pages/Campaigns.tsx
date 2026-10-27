// Campaign list: Kompass campaigns next to the past untargeted newsletters, for comparison.
import clsx from "clsx";
import { Megaphone, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Campaign } from "../../../shared/types";
import { api } from "../api/client";
import { approvalsNeeded, campaignStatus, DEFAULT_NAME, fmtWhen, plural, uniqueName } from "../components/outreach/copy";
import { Badge, Button, Empty, ErrorNote, PageBar, Skeleton, Tabs } from "../components/ui";
import { fmtDelta, fmtInt, fmtPct, fmtPp } from "../lib/format";
import { useAsync } from "../lib/useAsync";

function rate(c: Campaign, key: string) {
  const f = c.results?.funnel;
  const sent = f?.find((x) => x.key === "sent")?.count ?? 0;
  const n = f?.find((x) => x.key === key)?.count ?? 0;
  return sent ? n / sent : 0;
}

/** Where a campaign opens: a launched one on its results, one in review on the review (where approving and sending happen). */
const stepOf = (c: Campaign) => (c.source === "legacy_newsletter" ? "" : c.status === "review" ? "?step=review" : c.status === "running" || c.status === "done" ? "?step=results" : "");

export function CampaignsPage() {
  const nav = useNavigate();
  const { data, error, loading } = useAsync(() => api.campaigns(), []);
  // How many approvals a campaign needs depends on Settings; until they are known, two.
  const { data: settings } = useAsync(() => api.settings(), []);
  const need = approvalsNeeded(settings);
  const [tab, setTab] = useState<"active" | "done">("active");
  const [createError, setCreateError] = useState<string | null>(null);

  const kompass = (data ?? []).filter((c) => c.source === "kompass");
  const legacy = (data ?? []).filter((c) => c.source === "legacy_newsletter");
  const active = kompass.filter((c) => c.status !== "done");
  const done = [...kompass.filter((c) => c.status === "done"), ...legacy];
  const rows = tab === "active" ? active : done;

  // Baseline: what the untargeted newsletters achieved.
  const base = useMemo(() => {
    const sum = (k: string) => legacy.reduce((s, c) => s + (c.results?.funnel.find((x) => x.key === k)?.count ?? 0), 0);
    const sent = sum("sent");
    return { sent, open: sent ? sum("opened") / sent : 0, conv: sent ? sum("converted") / sent : 0, unsub: sent ? sum("unsubscribed") / sent : 0 };
  }, [legacy]);

  const create = async () => {
    setCreateError(null);
    try {
      // A second new campaign is "New campaign (2)", not a twin of the first.
      const c = await api.createCampaign({ name: uniqueName(DEFAULT_NAME, (data ?? []).map((x) => x.name)) });
      nav(`/campaigns/${c.id}?step=who`);
    } catch (e) {
      setCreateError((e as Error).message);
    }
  };

  return (
    <>
      <PageBar
        title="Campaigns"
        subtitle="Pick who, let the engine pick what, build the email from smart blocks, approve, measure against a control group."
        actions={
          <Button variant="primary" icon={Plus} onClick={create}>
            New campaign
          </Button>
        }
      />
      <div className="flex-1 overflow-y-auto page-scroll px-6 py-5 scroll-thin">
        {legacy.length > 0 && (
          <div className="mb-5 flex items-center gap-6 rounded-xl border border-ink-200 bg-white px-5 py-3.5">
            <div className="min-w-0 flex-1 text-[13px] text-ink-600">
              <b className="text-ink-900">Before Kompass:</b> {plural(legacy.length, "newsletter")} went to every subscriber with the same text. There was no control group, so nobody can say if {legacy.length === 1 ? "it" : "they"} worked.
            </div>
            <div className="flex shrink-0 gap-6 text-right">
              <div>
                <div className="num text-[17px] font-semibold">{fmtInt(base.sent)}</div>
                <div className="text-[11.5px] text-ink-500">sent</div>
              </div>
              <div>
                <div className="num text-[17px] font-semibold">{fmtPct(base.open, 1)}</div>
                <div className="text-[11.5px] text-ink-500">human opens</div>
              </div>
              <div>
                <div className="num text-[17px] font-semibold">{fmtPct(base.conv, 1)}</div>
                <div className="text-[11.5px] text-ink-500">converted</div>
              </div>
              <div>
                <div className="num text-[17px] font-semibold">{fmtPct(base.unsub, 1)}</div>
                <div className="text-[11.5px] text-ink-500">unsubscribed</div>
              </div>
            </div>
          </div>
        )}

        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { value: "active", label: "Active", count: active.length },
            { value: "done", label: "Finished", count: done.length },
          ]}
        />
        <ErrorNote error={error} className="mt-4" />
        <ErrorNote error={createError} className="mt-4" />
        {loading && !data && <Skeleton className="mt-4 h-40" />}
        {data && rows.length === 0 && (
          <Empty icon={Megaphone} title={tab === "active" ? "No active campaigns" : "Nothing finished yet"} hint="Start one here, or ask Kompass: “Plan a campaign for customers whose price guarantee ends soon.”" />
        )}
        {rows.length > 0 && (
          <table className="mt-3 w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11.5px] font-medium uppercase tracking-wider text-ink-400">
                <th className="py-2 pr-3 font-medium">Campaign</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 text-right font-medium">Reach</th>
                <th className="py-2 pr-3 text-right font-medium">Opens</th>
                <th className="py-2 pr-3 text-right font-medium">Converted</th>
                <th className="py-2 pr-3 text-right font-medium">vs control</th>
                <th className="py-2 text-right font-medium">CLV</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100 border-t border-ink-200">
              {rows.map((c) => {
                const r = c.results;
                const legacyRow = c.source === "legacy_newsletter";
                const st = campaignStatus(c, need);
                return (
                  <tr key={c.id} onClick={() => nav(`/campaigns/${c.id}${stepOf(c)}`)} className="cursor-pointer hover:bg-white">
                    <td className="max-w-[420px] py-2.5 pr-3">
                      <div className="truncate font-medium text-ink-900">{c.name}</div>
                      <div className="truncate text-[12px] text-ink-500">
                        {c.audienceLabel || "No audience yet"}
                        {c.launchedAt ? ` · Sent ${fmtWhen(c.launchedAt, false)}` : c.updatedAt ? ` · Edited ${fmtWhen(c.updatedAt, false)}` : ""}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      {legacyRow ? (
                        <Badge tint="neutral">Newsletter</Badge>
                      ) : (
                        <>
                          <Badge tint={st.tint}>{st.label}</Badge>
                          {c.status === "review" && !st.ready && (
                            <span className="ml-1 text-[11px] text-ink-400">
                              {c.approvals.length} of {need} approved
                            </span>
                          )}
                        </>
                      )}
                      {r?.simulated && <span className="ml-1 text-[11px] text-ink-400">simulated</span>}
                    </td>
                    <td className="num py-2.5 pr-3 text-right">{r ? fmtInt(r.funnel.find((x) => x.key === "sent")?.count ?? 0) : c.plan ? `${fmtInt(c.plan.summary.contacts)} planned` : "–"}</td>
                    <td className="num py-2.5 pr-3 text-right">{r ? fmtPct(rate(c, "opened"), 1) : "–"}</td>
                    <td className="num py-2.5 pr-3 text-right">{r ? fmtPct(rate(c, "converted"), 1) : "–"}</td>
                    <td className={clsx("num py-2.5 pr-3 text-right", r && !legacyRow && (r.upliftPp > 0 ? "text-good-600" : "text-bad-600"))}>{r ? (legacyRow ? <span className="text-ink-400">no control</span> : fmtPp(r.upliftPp)) : "–"}</td>
                    <td className="num py-2.5 text-right">{r && !legacyRow ? fmtDelta(r.realisedDclvEur) : c.plan ? <span className="text-ink-500">{fmtDelta(c.plan.summary.expected_dclv_eur)} exp.</span> : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
