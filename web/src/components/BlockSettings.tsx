// Settings of one email block, shown inline when the block is selected in the builder.
import clsx from "clsx";
import { Plus, X } from "lucide-react";
import { useRef } from "react";
import type { Block, BlockDef, ShowIf, ShowIfOp, Vocabulary } from "../../../shared/types";
import type { ShowIfField } from "../api/client";
import { useVocabulary } from "../lib/catalog";
import { humanize } from "../lib/format";
import { painLabel, plainText, plural, SAVING_LABEL, segmentLabel, tierLabel } from "./outreach/copy";
import { Button, Field, Input, Segmented, Select, Textarea, Toggle } from "./ui";

const ARTICLE_TOPICS = [
  { value: "auto", label: "Matched per customer" },
  { value: "wallbox", label: "Wallbox at home" },
  { value: "heat_pump", label: "Heat pumps and wallboxes" },
  { value: "charging", label: "Smart charging" },
  { value: "moving", label: "Moving house" },
  { value: "smart_meter", label: "Smart meter" },
  { value: "balcony", label: "Balcony solar" },
  { value: "data", label: "Saving mobile data" },
  { value: "prices", label: "Energy prices 2026" },
];

/** One-line summary of a block's settings for the canvas. */
export function blockSummary(b: Block, def: BlockDef | undefined, vocab: Vocabulary | null): string {
  const p = b.props;
  const offerName = (id: unknown) => vocab?.offers.find((o) => o.offer_id === id)?.product_name ?? "a chosen offer";
  switch (b.type) {
    case "offer":
      return p.mode === "pinned" ? `Fixed offer: ${offerName(p.offerId)}` : "The engine picks the best offer per customer";
    case "last_contact":
      return `Recaps a contact from the last ${plural(Number(p.maxDays ?? 120), "day")}`;
    case "guarantee":
      return `If the guarantee ends within ${plural(Number(p.withinDays ?? 120), "day")}`;
    case "savings":
      return p.allowAssumptions ? "From own data, or typical values" : "Only savings from the customer's own data";
    case "article":
      return ARTICLE_TOPICS.find((t) => t.value === (p.topic ?? "auto"))?.label ?? String(p.topic);
    case "survey":
      return p.voucher ? `Rating 1–5 with a ${p.voucherEur ?? 5} € voucher` : "Rating 1–5";
    case "ai_text": {
      const g = p.generated as { sie?: string } | null;
      return g?.sie ? g.sie : "Empty paragraph: replace it with a text block";
    }
    case "text":
      return `${p.title ? `${String(p.title)}: ` : ""}${String(p.sie || p.du || "Empty: click to write")}`;
    case "objections":
      return "What this customer may say, with a fair answer";
    case "hero":
      return String(p.title ?? "");
    case "button":
      return `${p.label ?? "Button"} → ${String(p.url ?? "").replace(/^https?:\/\/(www\.)?/, "")}`;
    case "service_status":
      return "Only for customers with an open case; replaces the offer";
    default:
      return def?.description ?? "";
  }
}

const OPS: Record<ShowIfField["kind"], { value: ShowIfOp; label: string }[]> = {
  bool: [
    { value: "is", label: "is" },
    { value: "is_not", label: "is not" },
  ],
  number: [
    { value: "gt", label: "greater than" },
    { value: "lt", label: "less than" },
    { value: "is", label: "equals" },
  ],
  text: [
    { value: "is", label: "is" },
    { value: "is_not", label: "is not" },
  ],
  list: [
    { value: "contains", label: "includes" },
    { value: "not_contains", label: "does not include" },
  ],
};

/** Values a rule can pick instead of typing: the keys the engine compares with, in plain words. */
function valueOptions(field: string, vocab: Vocabulary | null) {
  switch (field) {
    case "segments":
      return vocab?.segments.map((x) => ({ value: x.key, label: segmentLabel(x.key) })) ?? null;
    case "pains":
      return vocab?.pains.map((x) => ({ value: x.key, label: painLabel(x.key) })) ?? null;
    case "value_tier":
      return ["high", "medium", "low", "negative", "unknown"].map((k) => ({ value: k, label: tierLabel(k) }));
    case "tonality":
      return [
        { value: "sie", label: "Sie" },
        { value: "du", label: "Du" },
      ];
    default:
      return null;
  }
}

export function ShowIfEditor({ rules, fields, onChange, title = "Show this block only if" }: { rules: ShowIf[]; fields: ShowIfField[]; onChange: (r: ShowIf[]) => void; title?: string }) {
  const vocab = useVocabulary();
  const kindOf = (f: string) => fields.find((x) => x.field === f)?.kind ?? "text";
  const set = (i: number, patch: Partial<ShowIf>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div>
      <div className="mb-1.5 text-[12px] font-medium text-ink-600">{title}</div>
      <div className="space-y-1.5">
        {rules.map((r, i) => {
          const kind = kindOf(r.field);
          const picks = kind === "bool" ? null : valueOptions(r.field, vocab);
          return (
            <div key={i} className="flex items-center gap-1.5">
              <Select
                value={r.field}
                onChange={(e) => {
                  const k = kindOf(e.target.value);
                  set(i, { field: e.target.value, op: OPS[k][0].value, value: k === "bool" ? true : "" });
                }}
                options={fields.map((f) => ({ value: f.field, label: f.label }))}
                className="min-w-0 flex-[2]"
              />
              <Select value={r.op} onChange={(e) => set(i, { op: e.target.value as ShowIfOp })} options={OPS[kind]} className="w-auto flex-1" />
              {kind === "bool" ? (
                <Select
                  value={String(r.value ?? true)}
                  onChange={(e) => set(i, { value: e.target.value === "true" })}
                  options={[
                    { value: "true", label: "yes" },
                    { value: "false", label: "no" },
                  ]}
                  className="w-20 flex-none"
                />
              ) : picks ? (
                <Select
                  value={String(r.value ?? "")}
                  onChange={(e) => set(i, { value: e.target.value })}
                  // A value from an older rule that is not on the list stays selectable.
                  options={[{ value: "", label: "Choose…" }, ...picks, ...(r.value && !picks.some((o) => o.value === String(r.value)) ? [{ value: String(r.value), label: humanize(String(r.value)) }] : [])]}
                  className="min-w-0 flex-1"
                />
              ) : (
                <Input
                  value={String(r.value ?? "")}
                  type={kind === "number" ? "number" : "text"}
                  onChange={(e) => set(i, { value: kind === "number" ? Number(e.target.value) : e.target.value })}
                  className="min-w-0 flex-1"
                  placeholder={kind === "list" ? "e.g. StromAktiv" : ""}
                />
              )}
              <button onClick={() => onChange(rules.filter((_, j) => j !== i))} className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700" aria-label="Remove condition">
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        onClick={() => onChange([...rules, { field: fields[0]?.field ?? "service_case", op: "is", value: true }])}
        className="mt-1.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-navy-700 hover:underline"
      >
        <Plus size={13} /> Add condition
      </button>
    </div>
  );
}

/** Textarea with placeholder chips that insert at the cursor. */
function PlaceholderText({ label, value, onChange, placeholders, rows = 3 }: { label: string; value: string; onChange: (v: string) => void; placeholders: string[]; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (ph: string) => {
    const el = ref.current;
    const token = `{{${ph}}}`;
    if (!el) return onChange(value + token);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <Field label={label}>
      <Textarea ref={ref} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      <div className="mt-1 flex flex-wrap gap-1">
        {placeholders.map((ph) => (
          <button key={ph} type="button" onClick={() => insert(ph)} className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-600 hover:bg-navy-100 hover:text-navy-800">
            {`{{${ph}}}`}
          </button>
        ))}
      </div>
    </Field>
  );
}

export function BlockSettings({
  block,
  def,
  fields,
  placeholders,
  vocab,
  onChange,
}: {
  block: Block;
  def: BlockDef | undefined;
  fields: ShowIfField[];
  placeholders: string[];
  vocab: Vocabulary | null;
  onChange: (b: Block) => void;
}) {
  const p = block.props;
  const set = (patch: Record<string, unknown>) => onChange({ ...block, props: { ...p, ...patch } });

  let body: React.ReactNode = null;
  switch (block.type) {
    case "offer":
      body = (
        <div className="space-y-2.5">
          <Segmented
            value={(p.mode as string) === "pinned" ? "pinned" : "engine"}
            onChange={(v) => set({ mode: v, offerId: v === "pinned" ? (p.offerId ?? vocab?.offers.find((o) => !o.disabled)?.offer_id) : undefined })}
            options={[
              { value: "engine", label: "Best per customer" },
              { value: "pinned", label: "One fixed offer" },
            ]}
          />
          {p.mode === "pinned" && (
            <Field label="Offer" hint="Shown only to customers who are eligible for it.">
              <Select
                value={String(p.offerId ?? "")}
                onChange={(e) => set({ offerId: e.target.value })}
                options={(vocab?.offers ?? []).filter((o) => !o.disabled).map((o) => ({ value: o.offer_id, label: o.product_name }))}
              />
            </Field>
          )}
          <p className="text-[12px] text-ink-500">Hidden automatically when sales are paused (dunning, complaint, cancellation) or the expected CLV gain is not positive.</p>
        </div>
      );
      break;
    case "last_contact":
      body = (
        <Field label="Only contacts from the last … days">
          <Input type="number" min={7} max={365} value={Number(p.maxDays ?? 120)} onChange={(e) => set({ maxDays: Number(e.target.value) })} className="w-28" />
        </Field>
      );
      break;
    case "guarantee":
      body = (
        <Field label="Show if the price guarantee ends within … days">
          <Input type="number" min={7} max={365} value={Number(p.withinDays ?? 120)} onChange={(e) => set({ withinDays: Number(e.target.value) })} className="w-28" />
        </Field>
      );
      break;
    case "savings":
      body = (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-[13px]">
            <Toggle checked={!!p.allowAssumptions} onChange={(v) => set({ allowAssumptions: v })} /> Also use typical values when the customer's own data is missing
          </label>
          {vocab && (
            <Field label="Kinds of saving (empty = any)">
              <div className="flex flex-wrap gap-1">
                {vocab.saving_kinds.map((k) => {
                  const kinds = (p.kinds as string[] | undefined) ?? [];
                  const on = kinds.includes(k.key);
                  return (
                    <button
                      key={k.key}
                      title={k.description}
                      onClick={() => set({ kinds: on ? kinds.filter((x) => x !== k.key) : [...kinds, k.key] })}
                      className={clsx("rounded-md border px-1.5 py-0.5 text-[12px]", on ? "border-navy-700 bg-navy-50 text-navy-800" : "border-ink-200 text-ink-600 hover:bg-ink-50")}
                    >
                      {SAVING_LABEL[k.key] ?? humanize(k.key)}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
        </div>
      );
      break;
    case "article":
      body = (
        <Field label="Guide">
          <Select value={String(p.topic ?? "auto")} onChange={(e) => set({ topic: e.target.value })} options={ARTICLE_TOPICS} />
        </Field>
      );
      break;
    case "survey":
      body = (
        <div className="space-y-2">
          <Field label="Question (Sie)">
            <Input value={String(p.question ?? "")} onChange={(e) => set({ question: e.target.value })} />
          </Field>
          <Field label="Question (Du)">
            <Input value={String(p.questionDu ?? "")} onChange={(e) => set({ questionDu: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 text-[13px]">
            <Toggle checked={!!p.voucher} onChange={(v) => set({ voucher: v })} /> Thank-you voucher
            {!!p.voucher && <Input type="number" min={1} max={50} value={Number(p.voucherEur ?? 5)} onChange={(e) => set({ voucherEur: Number(e.target.value) })} className="w-20" />}
            {!!p.voucher && <span className="text-ink-500">€, the same for everyone</span>}
          </label>
        </div>
      );
      break;
    case "ai_text": {
      // Paragraphs from before the bubble: keep their text as an ordinary text block.
      const g = (p.generated as { sie?: string; du?: string } | null) ?? null;
      body = (
        <div className="space-y-2">
          <p className="text-[12.5px] text-ink-500">An older AI paragraph. Kompass now writes ordinary text blocks; ask it in the bubble below.</p>
          <Button size="sm" onClick={() => onChange({ ...block, type: "text", props: { sie: g?.sie ?? "", du: g?.du ?? "" } })}>
            Turn into a text block
          </Button>
        </div>
      );
      break;
    }
    case "text":
      body = (
        <div className="grid gap-2">
          <Field label="Heading (optional)" hint="e.g. a section of the call script">
            <Input value={String(p.title ?? "")} onChange={(e) => set({ title: e.target.value || undefined })} />
          </Field>
          <PlaceholderText label="Sie version" value={String(p.sie ?? "")} onChange={(v) => set({ sie: v })} placeholders={placeholders} />
          <PlaceholderText label="Du version" value={String(p.du ?? "")} onChange={(v) => set({ du: v })} placeholders={placeholders} />
        </div>
      );
      break;
    case "hero":
      body = (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Title (Sie)">
            <Input value={String(p.title ?? "")} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label="Title (Du)">
            <Input value={String(p.titleDu ?? "")} onChange={(e) => set({ titleDu: e.target.value })} />
          </Field>
        </div>
      );
      break;
    case "button":
      body = (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Label">
            <Input value={String(p.label ?? "")} onChange={(e) => set({ label: e.target.value })} />
          </Field>
          <Field label="Link">
            <Input value={String(p.url ?? "")} onChange={(e) => set({ url: e.target.value })} />
          </Field>
        </div>
      );
      break;
    case "service_status": {
      const subj = (p.subject as { sie?: string; du?: string } | undefined) ?? {};
      body = (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Subject for service recipients (Sie)">
            <Input value={subj.sie ?? ""} placeholder="Ihr Anliegen bei MAINGAU" onChange={(e) => set({ subject: { ...subj, sie: e.target.value } })} />
          </Field>
          <Field label="(Du)">
            <Input value={subj.du ?? ""} placeholder="Dein Anliegen bei MAINGAU" onChange={(e) => set({ subject: { ...subj, du: e.target.value } })} />
          </Field>
        </div>
      );
      break;
    }
    default:
      body = <p className="text-[12.5px] text-ink-500">{def?.description}</p>;
  }

  return (
    <div className="space-y-3 border-t border-ink-100 bg-ink-50/60 px-4 py-3">
      {body}
      {def?.source && <p className="text-[11.5px] text-ink-400">Data: {plainText(def.source)}</p>}
      {block.type !== "footer" && (
        <ShowIfEditor rules={block.showIf ?? []} fields={fields} onChange={(showIf) => onChange({ ...block, showIf: showIf.length ? showIf : undefined })} />
      )}
    </div>
  );
}
