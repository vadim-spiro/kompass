// Audience filters in plain language, mapped 1:1 to the insights service's Audience schema.
import clsx from "clsx";
import { Search } from "lucide-react";
import type { Audience, Vocabulary } from "../../../shared/types";
import { fmtInt } from "../lib/format";
import { channelName, driverLabel, holdingLabel, painLabel, plural, segmentLabel, tierLabel } from "./outreach/copy";
import { Field, Input } from "./ui";

type ListKey = "segments" | "pains" | "personas" | "holds" | "lacks" | "value_tiers" | "reachable_via";

function Chips({ label, hint, options, value, onChange, tint = "navy" }: { label: string; hint?: string; options: { key: string; label: string; title?: string }[]; value: string[]; onChange: (v: string[]) => void; tint?: "navy" | "bad" }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[12px] font-medium text-ink-600">{label}</span>
        {hint && <span className="text-[11.5px] text-ink-400">{hint}</span>}
      </div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => {
          const on = value.includes(o.key);
          return (
            <button
              key={o.key}
              title={o.title}
              onClick={() => onChange(on ? value.filter((x) => x !== o.key) : [...value, o.key])}
              className={clsx(
                "rounded-md border px-2 py-0.5 text-[12.5px] transition-colors",
                on ? (tint === "bad" ? "border-bad-600/40 bg-bad-50 text-bad-600" : "border-navy-700 bg-navy-900 text-white") : "border-ink-200 bg-white text-ink-700 hover:border-ink-300 hover:bg-ink-50",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Short description of an audience, e.g. for the campaign list. Offers are named when the vocabulary is at hand. */
export function describeAudience(a: Audience, vocab?: Vocabulary | null): string {
  const parts: string[] = [];
  const offers = (ids: string[]) => ids.map((id) => vocab?.offers.find((o) => o.offer_id === id)?.product_name ?? "a chosen offer").join(" / ");
  if (a.segments?.length) parts.push(a.segments.map(segmentLabel).join(" or "));
  if (a.segments_all?.length) parts.push(a.segments_all.map(segmentLabel).join(" and "));
  if (a.exclude_segments?.length) parts.push(`not ${a.exclude_segments.map(segmentLabel).join(" or ")}`);
  if (a.pains?.length) parts.push(`pain: ${a.pains.map(painLabel).join(" / ")}`);
  if (a.personas?.length) parts.push(a.personas.map(segmentLabel).join(" / "));
  if (a.churn_drivers?.length) parts.push(`churn signal: ${a.churn_drivers.map(driverLabel).join(" / ")}`);
  if (a.holds?.length) parts.push(`has ${a.holds.map(holdingLabel).join(", ")}`);
  if (a.lacks?.length) parts.push(`without ${a.lacks.map(holdingLabel).join(", ")}`);
  if (a.value_tiers?.length) parts.push(`${a.value_tiers.map(tierLabel).join("/")} value`);
  if (a.reachable_via?.length) parts.push(`reachable by ${a.reachable_via.map(channelName).join("/")}`);
  if (a.guarantee_ends_within_days) parts.push(`price guarantee ends within ${plural(a.guarantee_ends_within_days, "day")}`);
  if (a.tonality) parts.push(`${a.tonality === "du" ? "Du" : "Sie"} customers`);
  if (a.min_churn != null) parts.push(`churn risk at least ${Math.round(a.min_churn * 100)} %`);
  if (a.max_churn != null) parts.push(`churn risk at most ${Math.round(a.max_churn * 100)} %`);
  if (a.min_clv != null) parts.push(`CLV at least ${fmtInt(a.min_clv)} €`);
  if (a.max_clv != null) parts.push(`CLV at most ${fmtInt(a.max_clv)} €`);
  if (a.cities?.length) parts.push(`in ${a.cities.join(", ")}`);
  if (a.service_case != null) parts.push(a.service_case ? "with an open problem" : "without an open problem");
  if (a.profiling_allowed != null) parts.push(a.profiling_allowed ? "with profiling consent" : "without profiling consent");
  if (a.has_positive_action != null) parts.push(a.has_positive_action ? "with a worthwhile next step" : "without a next step");
  if (a.best_action_in?.length) parts.push(`best next step: ${offers(a.best_action_in)}`);
  if (a.eligible_for?.length) parts.push(`eligible for ${offers(a.eligible_for)}`);
  if (a.customer_ids?.length) parts.push(plural(a.customer_ids.length, "selected customer"));
  if (a.query) parts.push(`“${a.query}”`);
  return parts.join(" · ") || "All customers";
}

export function AudienceBuilder({ value, onChange, vocab }: { value: Audience; onChange: (a: Audience) => void; vocab: Vocabulary | null }) {
  const list = (k: ListKey) => (value[k] as string[] | undefined) ?? [];
  const setList = (k: ListKey) => (v: string[]) => onChange({ ...value, [k]: v.length ? v : undefined });
  const opts = (items: { key: string; description: string }[] | undefined, fmt: (key: string) => string) => (items ?? []).map((x) => ({ key: x.key, label: fmt(x.key), title: x.description }));

  return (
    <div className="space-y-4">
      <Field label="Describe who you want to reach (optional)" hint="Matched by meaning against each customer's profile, tickets and behaviour.">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
          <Input value={value.query ?? ""} onChange={(e) => onChange({ ...value, query: e.target.value || undefined })} placeholder="e.g. families who complained about their bill but are otherwise happy" className="pl-8" />
        </div>
      </Field>
      <Chips label="Segment" hint="any of" options={opts(vocab?.segments, segmentLabel)} value={list("segments")} onChange={setList("segments")} />
      <Chips label="Problem or interest" hint="any of" options={opts(vocab?.pains, painLabel)} value={list("pains")} onChange={setList("pains")} />
      <div className="grid grid-cols-2 gap-4">
        <Chips label="Has" options={opts(vocab?.holdings, holdingLabel)} value={list("holds")} onChange={setList("holds")} />
        <Chips label="Does not have" options={opts(vocab?.holdings, holdingLabel)} value={list("lacks")} onChange={setList("lacks")} tint="bad" />
      </div>
      <Chips label="Persona" options={opts(vocab?.personas, segmentLabel)} value={list("personas")} onChange={setList("personas")} />
      <div className="grid grid-cols-2 gap-4">
        <Chips label="Value" options={opts(vocab?.value_tiers, tierLabel)} value={list("value_tiers")} onChange={setList("value_tiers")} />
        <Chips label="Reachable by" hint="consent given" options={(vocab?.channels ?? []).map((c) => ({ key: c.key, label: channelName(c.key), title: c.description }))} value={list("reachable_via")} onChange={setList("reachable_via")} />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Field label="Price guarantee ends within">
          <div className="flex items-center gap-1.5">
            <Input type="number" min={0} max={365} value={value.guarantee_ends_within_days ?? ""} onChange={(e) => onChange({ ...value, guarantee_ends_within_days: e.target.value ? Number(e.target.value) : undefined })} className="w-20" placeholder="–" />
            <span className="text-[12.5px] text-ink-500">days</span>
          </div>
        </Field>
        <Field label="Addressed as">
          <div className="flex gap-1">
            {[undefined, "sie", "du"].map((t) => (
              <button
                key={t ?? "any"}
                onClick={() => onChange({ ...value, tonality: t as Audience["tonality"] })}
                className={clsx("rounded-md border px-2 py-0.5 text-[12.5px]", value.tonality === t ? "border-navy-700 bg-navy-900 text-white" : "border-ink-200 bg-white text-ink-700 hover:bg-ink-50")}
              >
                {t === undefined ? "Any" : t === "du" ? "Du" : "Sie"}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Churn risk at least">
          <div className="flex items-center gap-1.5">
            <Input type="number" min={0} max={100} value={value.min_churn != null ? Math.round(value.min_churn * 100) : ""} onChange={(e) => onChange({ ...value, min_churn: e.target.value ? Number(e.target.value) / 100 : undefined })} className="w-20" placeholder="–" />
            <span className="text-[12.5px] text-ink-500">%</span>
          </div>
        </Field>
      </div>
    </div>
  );
}
