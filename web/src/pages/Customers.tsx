// Customer list: who they are, what is wrong, what they are worth and what to do next.
import clsx from "clsx";
import { AlertTriangle, Search, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Audience, CustomerRow, Page } from "../../../shared/types";
import { api } from "../api/client";
import { Badge, Button, Empty, ErrorNote, Input, PageBar, Select, Skeleton } from "../components/ui";
import { useVocabulary } from "../lib/catalog";
import { chLabel, fmtEur, fmtInt, fmtPct, humanize, plainWhy, plural } from "../lib/format";
import { useScreen } from "../lib/screen";

const SORTS = [
  { value: "value_at_risk", label: "Most value at risk" },
  { value: "clv", label: "Highest CLV" },
  { value: "churn", label: "Highest churn risk" },
  { value: "best_dclv", label: "Biggest opportunity" },
];

export function CustomersPage({ base = "/customers" }: { base?: string } = {}) {
  const nav = useNavigate();
  const vocab = useVocabulary();
  const [sp, setSp] = useSearchParams();
  const q = sp.get("q") ?? "";
  const segment = sp.get("segment") ?? "";
  const pain = sp.get("pain") ?? "";
  const problems = sp.get("problems") === "1";
  const sort = sp.get("sort") ?? "value_at_risk";
  const [text, setText] = useState(q);
  const [page, setPage] = useState<Page<CustomerRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v);
    else next.delete(k);
    setSp(next, { replace: true });
  };

  const audience: Audience = { ...(segment ? { segments: [segment] } : {}), ...(pain ? { pains: [pain] } : {}), ...(problems ? { service_case: true } : {}) };
  const key = JSON.stringify({ q, audience, sort });
  const load = async (offset = 0) => {
    setLoading(true);
    try {
      const res = await api.customers({ audience, q, sort, desc: true, limit: 50, offset });
      setPage((prev) => (offset && prev ? { ...res, items: [...prev.items, ...res.items] } : res));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const t = setTimeout(() => text !== q && set("q", text), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useScreen(
    "customers",
    {
      view: "customers",
      title: page ? `Customers · ${fmtInt(page.total)}${segment || pain || problems || q ? " match" : ""}` : "Customers",
      data: {
        filters: { q, segment, pain, problems, sort },
        total: page?.total,
        top: page?.items.slice(0, 5).map((c) => ({ id: c.customer_id, clv: c.clv_eur, churn: c.churn_prob_12m, pains: c.pains, best_action: c.best_action?.product_name })),
      },
    },
    {
      set_filters: {
        target: () => "customer-filters",
        run: async (a) => {
          const next = new URLSearchParams();
          const f = { q: a.q ?? q, segment: a.segment ?? segment, pain: a.pain ?? pain, problems: a.problems ?? problems, sort: a.sort ?? sort };
          if (f.q) next.set("q", String(f.q));
          if (f.segment) next.set("segment", String(f.segment));
          if (f.pain) next.set("pain", String(f.pain));
          if (f.problems) next.set("problems", "1");
          if (f.sort && f.sort !== "value_at_risk") next.set("sort", String(f.sort));
          setText(String(f.q ?? ""));
          setSp(next, { replace: true });
          const aud: Audience = { ...(f.segment ? { segments: [String(f.segment)] } : {}), ...(f.pain ? { pains: [String(f.pain)] } : {}), ...(f.problems ? { service_case: true } : {}) };
          const res = await api.customers({ audience: aud, q: String(f.q ?? ""), sort: String(f.sort), desc: true, limit: 5 });
          return `${plural(res.total, "customer")} match${res.total === 1 ? "es" : ""}`;
        },
      },
    },
  );

  return (
    <>
      <PageBar title="Customers" subtitle={page ? `${plural(page.total, "customer")}${segment || pain || problems || q ? (page.total === 1 ? " matches" : " match") : ""}` : "Loading…"} />
      <div data-ai="customer-filters" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ink-200 bg-white px-6 py-2.5">
        <div className="relative w-72">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, email, city, product, MG-…" className="w-72 pl-8" />
        </div>
        <Select value={segment} onChange={(e) => set("segment", e.target.value)} className="w-56" options={[{ value: "", label: "All segments" }, ...(vocab?.segments ?? []).map((s) => ({ value: s.key, label: humanize(s.key) }))]} />
        <Select value={pain} onChange={(e) => set("pain", e.target.value)} className="w-48" options={[{ value: "", label: "Any pain point" }, ...(vocab?.pains ?? []).map((s) => ({ value: s.key, label: humanize(s.key) }))]} />
        <Button size="sm" variant={problems ? "primary" : "secondary"} icon={AlertTriangle} onClick={() => set("problems", problems ? "" : "1")}>
          Open service case
        </Button>
        <Select value={sort} onChange={(e) => set("sort", e.target.value)} className="ml-auto w-48" options={SORTS} />
      </div>
      <div className="flex-1 overflow-y-auto page-scroll px-6 py-3 scroll-thin">
        <ErrorNote error={error} className="my-3" />
        {!page && loading && <Skeleton className="h-96" />}
        {page && page.items.length === 0 && <Empty icon={Users} title="No customers match" hint="Try fewer filters." />}
        {page && page.items.length > 0 && (
          <table className={clsx("w-full text-[13px] transition-opacity", loading && "opacity-60")}>
            <thead>
              <tr className="text-left text-[11.5px] uppercase tracking-wider text-ink-400">
                <th className="py-2 pr-3 font-medium">Customer</th>
                <th className="py-2 pr-3 font-medium">Problems</th>
                <th className="py-2 pr-3 text-right font-medium">CLV</th>
                <th className="py-2 pr-3 text-right font-medium">Churn</th>
                <th className="py-2 pr-3 font-medium">Next best action</th>
                <th className="py-2 font-medium">Reach</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100 border-t border-ink-200">
              {page.items.map((c) => (
                <tr key={c.customer_id} onClick={() => nav(`${base}/${c.customer_id}`)} className="cursor-pointer hover:bg-white">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-ink-900">{c.identity.name}</div>
                    <div className="text-[12px] text-ink-500">
                      {c.customer_id} · {c.city ?? "–"} · {c.products.join(", ") || "no active product"}
                    </div>
                  </td>
                  <td className="max-w-[260px] py-2 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {c.sales_blockers.map((b) => (
                        <Badge key={b} tint="bad">
                          {humanize(b)}
                        </Badge>
                      ))}
                      {c.pains
                        .filter((p) => p !== "upset" || !c.sales_blockers.length)
                        .slice(0, 3)
                        .map((p) => (
                          <Badge key={p} tint="warn">
                            {humanize(p)}
                          </Badge>
                        ))}
                      {!c.sales_blockers.length && !c.pains.length && <span className="text-ink-400">–</span>}
                    </div>
                  </td>
                  <td className="num py-2 pr-3 text-right">
                    {c.clv_eur != null ? fmtEur(c.clv_eur) : "–"}
                    <div className="text-[11.5px] text-ink-400">{c.value_tier}</div>
                  </td>
                  <td className={clsx("num py-2 pr-3 text-right", (c.churn_prob_12m ?? 0) >= 0.3 ? "text-bad-600" : "text-ink-700")}>{c.churn_prob_12m != null ? fmtPct(c.churn_prob_12m) : "–"}</td>
                  <td className="min-w-[220px] max-w-[340px] py-2 pr-3">
                    {c.best_action ? (
                      <>
                        <div className={clsx("truncate", c.best_action.action_type === "service" ? "text-good-600" : "text-ink-800")}>{c.best_action.action_type === "service" ? "Service first, no offer" : c.best_action.product_name}</div>
                        <div className="line-clamp-2 text-[11.5px] leading-snug text-ink-500" title={plainWhy(c.best_action.reason)}>
                          {plainWhy(c.best_action.reason)}
                        </div>
                      </>
                    ) : (
                      <span className="text-ink-400">Leave alone</span>
                    )}
                  </td>
                  <td className="py-2 text-[12.5px] text-ink-600">
                    {c.contact_channel ? chLabel(c.contact_channel) : <span className="text-ink-400">no consent</span>}
                    <span className="ml-1.5 text-ink-400">{c.tonality === "du" ? "Du" : "Sie"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {page && page.items.length < page.total && (
          <div className="py-4 text-center">
            <Button size="sm" onClick={() => load(page.items.length)} disabled={loading}>
              Show more ({fmtInt(page.total - page.items.length)} left)
            </Button>
          </div>
        )}
        <p className="py-3 text-[11.5px] text-ink-400">Names, emails and street addresses are synthetic (the data is anonymised). Everything else is the customer's data on 30.09.2026.</p>
      </div>
    </>
  );
}
