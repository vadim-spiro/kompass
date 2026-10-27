// Drag-and-drop message builder: drop smart blocks from the palette onto the message, reorder them,
// set "show only if" rules, and watch it change per real recipient on the right. One builder for
// every channel: email, portal pop-up, SMS and call script.
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import clsx from "clsx";
import { CheckCircle2, ChevronLeft, ChevronRight, Eye, EyeOff, Filter, GripVertical, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Audience, Block, BlockDef, EmailDoc, MessageChannel, RenderedEmail, VariantStat } from "../../../shared/types";
import { api, reportIssue, type Recipient } from "../api/client";
import { useBlocks, useVocabulary } from "../lib/catalog";
import { fmtInt, humanize } from "../lib/format";
import { BlockSettings, blockSummary } from "./BlockSettings";
import { AnimatePresence, EASE, motion } from "./motion";
import { ChannelPreview } from "./outreach/ChannelPreviews";
import { isConsentCheck, plainCheck, plainHidden, PREVIEW_SAMPLE, plural, sampleLabel, SMS_LIMIT, tierLabel } from "./outreach/copy";
import { Badge, ErrorNote, Input, Skeleton, Spinner, iconFor } from "./ui";

let seq = 0;
const newBlockId = () => `b-${Date.now().toString(36)}${(seq++).toString(36)}`;

export interface EmailBuilderProps {
  email: EmailDoc;
  onChange: (e: EmailDoc) => void;
  /** Preview recipients: a campaign's planned contacts, or a sample of an audience. */
  campaignId?: string;
  audience?: Audience;
  readOnly?: boolean;
  channel?: MessageChannel;
  /** Show this customer in the preview (the bubble's preview_customer). */
  previewCustomerId?: string;
  /** Contacts the plan reaches with this message, for "preview of 40 of 203". */
  total?: number;
  /** The channel the plan picked for each contact (customer id → channel), so the preview shows the message the way they get it. */
  channelOf?: Record<string, string>;
}

/** The channel a draft is rendered for. */
export const RENDER_CHANNEL: Record<MessageChannel, string> = { email: "email", portal_popup: "portal_popup", sms: "sms", call: "call" };
const HINT: Record<MessageChannel, string> = {
  email: "Drag blocks from the left, or click them. Drag the handle to reorder.",
  portal_popup: "Shown once in the customer portal. Keep it to a header, one message and one button.",
  sms: `Short and plain: a greeting, one sentence and a link. Two SMS at most (${SMS_LIMIT} characters).`,
  call: "Call script for the agent who calls: why we call, what we offer, what the customer may say.",
};

/** What the preview found out about the recipients it flips through: versions, and which guardrails fail for whom. */
interface Summary {
  /** The draft it was computed for, to tell when it is out of date. */
  key: string;
  stats: VariantStat[];
  byCustomer: Record<string, string>;
  checked: number;
  failingIds: string[];
  failing: { check: string; ids: string[] }[];
  /** Recipients without consent for their channel: not a text problem, so not counted as a failed guardrail. */
  noConsent: number;
}

function summarize(key: string, rendered: RenderedEmail[]): Summary {
  const stats = new Map<string, VariantStat>();
  const byCustomer: Record<string, string> = {};
  const failing = new Map<string, { check: string; ids: string[] }>();
  const bad = new Set<string>();
  let noConsent = 0;
  for (const e of rendered) {
    byCustomer[e.customerId] = e.variant;
    const v = stats.get(e.variant) ?? { variant: e.variant, label: e.variantLabel, count: 0 };
    v.count++;
    stats.set(e.variant, v);
    if (e.checks.some((c) => !c.passed && isConsentCheck(c.check))) noConsent++;
    for (const c of e.checks) {
      if (c.passed || isConsentCheck(c.check)) continue;
      bad.add(e.customerId);
      const f = failing.get(c.check) ?? { check: c.check, ids: [] };
      f.ids.push(e.customerId);
      failing.set(c.check, f);
    }
  }
  return {
    key,
    stats: [...stats.values()].sort((a, b) => b.count - a.count),
    byCustomer,
    checked: rendered.length,
    failingIds: [...bad],
    failing: [...failing.values()].sort((a, b) => b.ids.length - a.ids.length),
    noConsent,
  };
}

export function EmailBuilder({ email, onChange, campaignId, audience, readOnly, channel = "email", previewCustomerId, total, channelOf }: EmailBuilderProps) {
  const catalog = useBlocks();
  const vocab = useVocabulary();
  const defs = useMemo(() => new Map((catalog?.blocks ?? []).map((d) => [d.type, d])), [catalog]);
  const renderChannel = RENDER_CHANNEL[channel];
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<BlockDef | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const explain = (reason?: string) => plainHidden(reason, { fields: catalog?.fields, offers: vocab?.offers });

  const setBlocks = (blocks: Block[]) => onChange({ ...email, blocks });
  const insertIndex = (blocks: Block[]) => {
    if (channel !== "email") return blocks.length;
    const f = blocks.findIndex((b) => b.type === "footer");
    return f >= 0 ? f : blocks.length;
  };
  const addBlock = (def: BlockDef, at?: number) => {
    const b: Block = { id: newBlockId(), type: def.type, props: structuredClone(def.defaults) };
    const blocks = [...email.blocks];
    blocks.splice(at ?? insertIndex(blocks), 0, b);
    setBlocks(blocks);
    setSelected(b.id);
  };

  const onDragStart = (e: DragStartEvent) => {
    const def = e.active.data.current?.def as BlockDef | undefined;
    setDragging(def ?? null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const { active, over } = e;
    if (!over) return;
    const def = active.data.current?.def as BlockDef | undefined;
    if (def) {
      const idx = email.blocks.findIndex((b) => b.id === over.id);
      addBlock(def, idx >= 0 ? idx : undefined);
      return;
    }
    if (active.id !== over.id) {
      const from = email.blocks.findIndex((b) => b.id === active.id);
      const to = email.blocks.findIndex((b) => b.id === over.id);
      if (from >= 0 && to >= 0) setBlocks(arrayMove(email.blocks, from, to));
    }
  };

  // ---------- Preview recipients and rendering ----------
  // The sample is the first contacts of this draft; the review in step 3 checks the same ones.
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  /** A customer the bubble asked to see who is not in the sample. */
  const [extra, setExtra] = useState<Recipient | null>(null);
  const [rIdx, setRIdx] = useState(0);
  const [rendered, setRendered] = useState<RenderedEmail | null>(null);
  const [renderErr, setRenderErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const audienceKey = JSON.stringify(audience ?? {});
  const shown = useMemo(() => (extra ? [extra, ...(recipients ?? [])] : (recipients ?? [])), [extra, recipients]);
  const current = shown[rIdx];
  /** Each customer is shown the way the plan sends to them (a newsletter contact has no email consent, and that is fine). */
  const channelFor = (id: string) => channelOf?.[id] ?? renderChannel;

  useEffect(() => {
    let live = true;
    setRecipients(null);
    api
      .recipients({ campaignId, audience, limit: PREVIEW_SAMPLE, ...(campaignId ? { channel } : {}) })
      .then((r) => {
        if (!live) return;
        setRecipients(r);
        setRIdx(0);
      })
      .catch((e) => live && setRenderErr((e as Error).message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, audienceKey, channel]);
  // Jump to a customer the bubble wants to show.
  useEffect(() => {
    if (!previewCustomerId || !recipients) return;
    const i = recipients.findIndex((r) => r.customerId === previewCustomerId);
    if (i >= 0) {
      setExtra(null);
      setRIdx(i);
      return;
    }
    let live = true;
    api.recipients({ audience: { customer_ids: [previewCustomerId] }, limit: 1 }).then(
      (r) => {
        if (!live || !r.length) return;
        setExtra(r[0]);
        setRIdx(0);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [previewCustomerId, recipients]);

  const emailKey = JSON.stringify(email);
  useEffect(() => {
    if (!current) return;
    let live = true;
    const t = setTimeout(() => {
      api
        .render(email, current.customerId, channelFor(current.customerId), campaignId)
        .then((r) => live && (setRendered(r), setRenderErr(null)))
        .catch((e) => live && setRenderErr((e as Error).message));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailKey, current?.customerId, renderChannel, channelOf]);

  // Versions and guardrails over the whole sample, each recipient on their own channel.
  useEffect(() => {
    if (!recipients?.length) {
      setSummary(null);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      const out = await api
        .renderBatch(email, recipients.map((r) => ({ customerId: r.customerId, channel: channelFor(r.customerId) })), campaignId)
        .catch((e) => (reportIssue("warn", "email-builder", `previews could not be rendered: ${(e as Error).message}`, { channel }), [] as (RenderedEmail | null)[]));
      if (!live) return;
      const ok = out.filter((e): e is RenderedEmail => !!e);
      if (ok.length < recipients.length) reportIssue("warn", "email-builder", `${recipients.length - ok.length} of ${recipients.length} previews could not be rendered`, { channel });
      setSummary(summarize(emailKey, ok));
    }, 700);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailKey, recipients, channelOf]);

  /** Moves to the next recipient (after the current one) that matches. */
  const jumpTo = (match: (id: string) => boolean) => {
    for (let k = 1; k <= shown.length; k++) {
      const i = (rIdx + k) % shown.length;
      if (match(shown[i].customerId)) return setRIdx(i);
    }
  };

  // The preview belongs to the recipient on screen; while another one loads, the old one is dimmed, not passed off as the new one.
  const fresh = !!rendered && !!current && rendered.customerId === current.customerId;
  const stale = !!rendered && !fresh;
  const renderedById = useMemo(() => new Map((fresh ? rendered!.blocks : []).map((b) => [b.id, b])), [fresh, rendered]);
  const summaryFresh = summary?.key === emailKey;

  const palette = (catalog?.blocks ?? []).filter((d) => !d.channels || d.channels.includes(channel));
  const groups: { key: BlockDef["group"]; title: string; hint: string }[] = [
    { key: "smart", title: "Smart blocks", hint: "Fill themselves per customer" },
    { key: "content", title: "Content", hint: "The same for everyone" },
    { key: "custom", title: "Your blocks", hint: "Defined in Settings" },
  ];

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="flex h-full min-h-0">
        {/* Palette */}
        {!readOnly && (
          <aside className="w-[232px] shrink-0 overflow-y-auto page-scroll border-r border-ink-200 bg-white px-3 py-4 scroll-thin">
            {!catalog && <Skeleton className="h-64" />}
            {groups.map((g) => {
              const items = palette.filter((d) => d.group === g.key);
              if (!items.length) return null;
              return (
                <div key={g.key} className="mb-5">
                  <div className="mb-1.5 px-1">
                    <div className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-400">{g.title}</div>
                    <div className="text-[11.5px] text-ink-400">{g.hint}</div>
                  </div>
                  <div className="space-y-1">
                    {items.map((d) => (
                      <PaletteItem key={d.type} def={d} onAdd={() => addBlock(d)} />
                    ))}
                  </div>
                </div>
              );
            })}
          </aside>
        )}

        {/* Canvas */}
        <section className="min-w-0 flex-1 overflow-y-auto page-scroll bg-[#f4f5f7] px-6 py-5 scroll-thin">
          <div className="mx-auto max-w-[620px]">
            <div className="mb-3 text-[12.5px] text-ink-500">{readOnly ? "This message was sent as shown." : HINT[channel]}</div>

            <div className="overflow-hidden rounded-xl border border-ink-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
              {channel === "email" && (
                <div data-ai="subject" className="grid grid-cols-[64px_1fr] items-center gap-x-2 gap-y-1.5 border-b border-ink-100 px-4 py-3">
                  <span className="text-[12px] text-ink-400">Subject</span>
                  <Input value={email.subject.sie} disabled={readOnly} onChange={(e) => onChange({ ...email, subject: { ...email.subject, sie: e.target.value } })} placeholder="Subject for Sie customers" />
                  <span className="text-[12px] text-ink-400">Du</span>
                  <Input value={email.subject.du} disabled={readOnly} onChange={(e) => onChange({ ...email, subject: { ...email.subject, du: e.target.value } })} placeholder="Subject for Du customers" />
                </div>
              )}
              <SortableContext items={email.blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
                <div className="divide-y divide-ink-100">
                  <AnimatePresence initial={false}>
                    {email.blocks.map((b) => (
                      <CanvasBlock
                        key={b.id}
                        block={b}
                        def={defs.get(b.type)}
                        summary={blockSummary(b, defs.get(b.type), vocab)}
                        open={selected === b.id}
                        readOnly={readOnly}
                        forName={current?.name.split(" ")[0]}
                        render={renderedById.get(b.id)}
                        explain={explain}
                        onToggle={() => setSelected((s) => (s === b.id ? null : b.id))}
                        onRemove={() => setBlocks(email.blocks.filter((x) => x.id !== b.id))}
                      >
                        {selected === b.id && catalog && !readOnly && (
                          <BlockSettings
                            block={b}
                            def={defs.get(b.type)}
                            fields={catalog.fields}
                            placeholders={catalog.placeholders}
                            vocab={vocab}
                            onChange={(nb) => setBlocks(email.blocks.map((x) => (x.id === b.id ? nb : x)))}
                          />
                        )}
                      </CanvasBlock>
                    ))}
                  </AnimatePresence>
                </div>
              </SortableContext>
              {!readOnly && <DropZone empty={email.blocks.length === 0} channel={channel} />}
            </div>
          </div>
        </section>

        {/* Preview */}
        <aside data-ai="message-preview" className="w-[400px] shrink-0 overflow-y-auto page-scroll border-l border-ink-200 bg-white px-4 py-4 scroll-thin">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-400">Preview per recipient</div>
            {shown.length > 0 && (
              <div className="flex items-center gap-1 text-[12px] text-ink-500">
                <button onClick={() => setRIdx((i) => (i - 1 + shown.length) % shown.length)} className="rounded p-1 hover:bg-ink-100" aria-label="Previous recipient">
                  <ChevronLeft size={15} />
                </button>
                <span className="num">
                  {rIdx + 1} / {shown.length}
                </span>
                <button onClick={() => setRIdx((i) => (i + 1) % shown.length)} className="rounded p-1 hover:bg-ink-100" aria-label="Next recipient">
                  <ChevronRight size={15} />
                </button>
              </div>
            )}
          </div>
          {recipients && recipients.length > 0 && (
            <p className="-mt-1.5 mb-3 text-[11.5px] text-ink-500">{campaignId && total != null ? sampleLabel(recipients.length, total) : `A sample of ${plural(recipients.length, "customer")} from this audience`}</p>
          )}

          {summary && summary.stats.length > 0 && (
            <div className={clsx("mb-3 rounded-lg bg-ink-50 px-3 py-2.5 transition-opacity", !summaryFresh && "opacity-50")} aria-busy={!summaryFresh}>
              <div className="mb-1.5 text-[12px] text-ink-600">
                <b className="num text-ink-900">{fmtInt(summary.checked)}</b> {summary.checked === 1 ? "recipient gets" : "recipients get"} <b className="text-ink-900">{summary.stats.length}</b> {summary.stats.length === 1 ? "version" : "versions"}
              </div>
              <div className="flex flex-wrap gap-1">
                {summary.stats.map((v) => (
                  <button
                    key={v.variant}
                    onClick={() => jumpTo((id) => summary.byCustomer[id] === v.variant)}
                    title="Show a recipient with this version"
                    className={clsx(
                      "rounded-md px-1.5 py-0.5 text-[12px] font-medium",
                      fresh && rendered?.variant === v.variant ? "ring-2 ring-navy-700/40" : "",
                      v.variant === "service" ? "bg-sun-100 text-navy-950" : v.variant === "generic" ? "bg-ink-200/70 text-ink-700" : "bg-navy-100 text-navy-800",
                    )}
                  >
                    <span className="num">{v.count}</span> · {v.label}
                  </button>
                ))}
              </div>
              {summary.failingIds.length > 0 ? (
                <div className="mt-2 space-y-0.5 text-[12px] text-bad-600">
                  <div className="font-medium">
                    {fmtInt(summary.failingIds.length)} of {fmtInt(summary.checked)} {summary.failingIds.length === 1 ? "fails" : "fail"} a guardrail
                  </div>
                  {summary.failing.slice(0, 3).map((f) => (
                    <button key={f.check} onClick={() => jumpTo((id) => f.ids.includes(id))} title="Show a recipient this affects" className="block text-left hover:underline">
                      {plainCheck({ check: f.check, passed: false }).check} ({f.ids.length})
                    </button>
                  ))}
                  {summary.failing.length > 3 && <div className="text-ink-500">and {plural(summary.failing.length - 3, "more check")}</div>}
                </div>
              ) : (
                <div className="mt-2 flex items-center gap-1 text-[12px] text-good-600">
                  <CheckCircle2 size={13} /> Every guardrail holds for {summary.checked === 1 ? "this recipient" : `all ${fmtInt(summary.checked)}`}
                </div>
              )}
              {summary.noConsent > 0 && (
                <div className="mt-1.5 text-[11.5px] text-ink-500">
                  {plural(summary.noConsent, "recipient")} {summary.noConsent === 1 ? "has" : "have"} no consent for their channel and would not get this message.
                </div>
              )}
            </div>
          )}

          {current && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12.5px]">
              <span className="font-medium text-ink-900">{current.name}</span>
              <span className="text-ink-400">{current.customerId}</span>
              {current.serviceCase && <Badge tint="sun">service case</Badge>}
              <Badge tint="neutral">{tierLabel(current.valueTier)} value</Badge>
            </div>
          )}
          <ErrorNote error={renderErr} className="mb-2" />
          {recipients && recipients.length === 0 && !extra && <p className="text-[12.5px] text-ink-500">{campaignId ? "Nobody in this campaign gets this message yet." : "No recipients match this audience."}</p>}
          {!rendered && !renderErr && recipients?.length !== 0 && <Skeleton className="h-80" />}
          {rendered && (
            <div>
              {stale && (
                <div className="mb-2 flex items-center gap-1.5 text-[12px] text-ink-500" role="status">
                  <Spinner /> Loading the preview{current ? ` for ${current.name}` : ""}…
                </div>
              )}
              <div className={clsx("transition-opacity", stale && "pointer-events-none opacity-40")} aria-busy={stale}>
                <ChannelPreview channel={channel} e={rendered} />
              </div>
            </div>
          )}
          <p className="mt-3 text-[11.5px] text-ink-400">Names and addresses are synthetic; everything else comes from the customer's data on 30.09.2026.</p>
        </aside>
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className="flex w-[210px] items-center gap-2 rounded-lg border border-navy-700/30 bg-white px-2.5 py-2 text-[13px] font-medium shadow-xl">
            {(() => {
              const I = iconFor(dragging.icon);
              return <I size={15} className="text-navy-700" />;
            })()}
            {dragging.label}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function PaletteItem({ def, onAdd }: { def: BlockDef; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `new:${def.type}`, data: { def } });
  const Icon = iconFor(def.icon);
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={onAdd}
      title={def.description}
      className={clsx(
        "group flex w-full cursor-grab items-start gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left hover:border-ink-200 hover:bg-ink-50 active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
    >
      <span className={clsx("mt-px grid h-6 w-6 shrink-0 place-items-center rounded-md", def.group === "smart" ? "bg-navy-50 text-navy-700" : def.group === "custom" ? "bg-teal-50 text-teal-600" : "bg-ink-100 text-ink-600")}>
        <Icon size={14} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium leading-tight text-ink-900">{def.label}</span>
        <span className="line-clamp-2 block text-[11.5px] leading-snug text-ink-400">{def.description}</span>
      </span>
      <Plus size={13} className="ml-auto mt-1 shrink-0 text-ink-300 opacity-0 group-hover:opacity-100" />
    </button>
  );
}

function DropZone({ empty, channel }: { empty: boolean; channel: MessageChannel }) {
  const { setNodeRef, isOver } = useDroppable({ id: "canvas-end" });
  return (
    <div
      ref={setNodeRef}
      className={clsx(
        "m-3 rounded-lg border border-dashed px-3 text-center text-[12.5px] transition-colors",
        empty ? "py-14" : "py-3",
        isOver ? "border-navy-700 bg-navy-50 text-navy-800" : "border-ink-200 text-ink-400",
      )}
    >
      {empty ? "Drop smart blocks here to build the message" : channel === "email" ? "Drop here to add before the footer" : "Drop here to add at the end"}
    </div>
  );
}

function CanvasBlock({
  block,
  def,
  summary,
  open,
  readOnly,
  forName,
  render,
  explain,
  onToggle,
  onRemove,
  children,
}: {
  block: Block;
  def: BlockDef | undefined;
  summary: string;
  open: boolean;
  readOnly?: boolean;
  forName?: string;
  render?: RenderedEmail["blocks"][number];
  /** The reason a block is hidden, in plain words. */
  explain: (reason?: string) => string;
  onToggle: () => void;
  onRemove: () => void;
  children?: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, active } = useSortable({ id: block.id, disabled: readOnly });
  const Icon = iconFor(def?.icon);
  const fromPalette = String(active?.id ?? "").startsWith("new:");
  const ref = useRef<HTMLDivElement | null>(null);
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      ref.current = el;
      setNodeRef(el);
    },
    [setNodeRef],
  );
  return (
    <motion.div
      ref={setRefs}
      data-ai={`block:${block.id}`}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.28, ease: EASE }}
      style={{ transform: fromPalette ? undefined : CSS.Transform.toString(transform), transition }}
      className={clsx("relative bg-white", isDragging && "z-10 opacity-60 shadow-lg", open && "bg-navy-50/30")}
    >
      {fromPalette && isOver && <div className="absolute inset-x-3 -top-px h-0.5 rounded bg-navy-700" />}
      <div className="flex items-start gap-2 px-3 py-2.5">
        {!readOnly && (
          <button {...attributes} {...listeners} className="mt-0.5 cursor-grab rounded p-0.5 text-ink-300 hover:bg-ink-100 hover:text-ink-600 active:cursor-grabbing" aria-label="Drag to reorder">
            <GripVertical size={15} />
          </button>
        )}
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
          <span className={clsx("mt-px grid h-6 w-6 shrink-0 place-items-center rounded-md", def?.group === "smart" ? "bg-navy-50 text-navy-700" : def?.group === "custom" ? "bg-teal-50 text-teal-600" : "bg-ink-100 text-ink-600")}>
            <Icon size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="text-[13.5px] font-medium text-ink-900">{def?.label ?? (block.type.startsWith("custom:") ? "Custom block" : humanize(block.type))}</span>
              {block.showIf?.length ? (
                <Badge tint="teal">
                  <Filter size={11} /> {plural(block.showIf.length, "rule")}
                </Badge>
              ) : null}
            </span>
            <span className="line-clamp-1 block text-[12px] text-ink-500">{summary}</span>
            {render && forName && (
              <span className={clsx("mt-0.5 flex items-center gap-1 text-[11.5px]", render.visible ? "text-good-600" : "text-ink-400")}>
                {render.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                {render.visible ? `Shown to ${forName}` : `Hidden for ${forName}: ${explain(render.hiddenReason)}`}
              </span>
            )}
          </span>
        </button>
        {!readOnly && (
          <button onClick={onRemove} className="rounded p-1 text-ink-300 hover:bg-bad-50 hover:text-bad-600" aria-label="Remove block">
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {children}
    </motion.div>
  );
}
