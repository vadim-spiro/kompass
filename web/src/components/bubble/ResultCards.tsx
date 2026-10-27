// What the bubble shows inside answers: markdown, proposal cards, rich tool results.
import clsx from "clsx";
import { Check, ChevronRight, Loader2, MousePointer2, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNavigate } from "react-router-dom";
import type { ChatProposal, ChatToolCall, ToolDisplay, Vocabulary } from "../../../../shared/types";
import { useVocabulary } from "../../lib/catalog";
import { chLabel, fmtEur, fmtInt, humanize, plural } from "../../lib/format";
import { ChartCard } from "../analytics/ChartView";
import { motion } from "../motion";
import { Button } from "../ui";

/** Where to take the user after a card is applied. */
export function targetFor(p: ChatProposal): string | null {
  const a = p.payload as Record<string, string | undefined>;
  const ref = p.appliedRef;
  switch (p.kind) {
    case "create_campaign":
      return ref ? `/campaigns/${ref}` : null;
    case "update_campaign":
      return `/campaigns/${ref ?? a.campaign_id}`;
    case "create_automation":
      return ref ? `/automations/${ref}` : null;
    case "add_command":
      return "/settings?tab=commands";
    case "add_block":
      return "/settings?tab=blocks";
    case "update_terms":
      return "/settings?tab=terms";
    case "save_chart":
      return ref ? `/analytics/${ref}` : "/analytics";
    case "open_view": {
      const views: Record<string, string> = {
        customer: `/customers/${a.id}`,
        campaign: `/campaigns/${a.id}`,
        automation: `/automations/${a.id}`,
        settings: "/settings",
        analytics: "/analytics",
        performance: "/analytics",
        campaigns: "/campaigns",
        automations: "/automations",
      };
      return a.view ? (views[a.view] ?? null) : null;
    }
  }
}

/** Customer ids in answers become links to their 360. */
export const linkIds = (s: string) => s.replace(/(?<![[\w/-])(MG-\d{6})(?![\]\w])/g, "[$1](/customers/$1)");

export type OnAct = (c: ChatToolCall, a: "apply" | "discard") => void | Promise<void>;

export function ToolResults({ calls, onAct }: { calls: ChatToolCall[]; onAct: OnAct }) {
  const displays = calls.filter((c) => c.display && !c.proposal);
  const proposals = calls.filter((c) => c.proposal);
  if (!displays.length && !proposals.length) return null;
  return (
    <div className="space-y-2.5">
      {displays.slice(-2).map((c) => (
        <DisplayCard key={c.id} d={c.display!} />
      ))}
      {proposals.map((c) => (c.proposal!.kind === "open_view" ? <OpenViewButton key={c.id} call={c} onAct={onAct} /> : <ProposalCard key={c.id} call={c} onAct={onAct} />))}
    </div>
  );
}

function DisplayCard({ d }: { d: ToolDisplay }) {
  const nav = useNavigate();
  if (d.kind === "customers")
    return (
      <div className="overflow-hidden rounded-xl border border-ink-200 bg-white">
        <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2 text-[12px]">
          <span className="font-semibold text-ink-900">{plural(d.total, "customer")}</span>
          <span className="text-ink-400">top {d.rows.length}</span>
        </div>
        <ul className="divide-y divide-ink-100">
          {d.rows.slice(0, 5).map((r, i) => (
            <motion.li key={r.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}>
              <button onClick={() => nav(`/customers/${r.id}`)} className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-ink-50">
                <span className="w-[84px] shrink-0 font-mono text-[11.5px] text-navy-700">{r.id}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-600">{r.why ?? r.name ?? ""}</span>
                {r.valueAtRiskEur != null && <span className="num shrink-0 text-[12px] font-medium text-ink-900">{fmtEur(r.valueAtRiskEur)}</span>}
              </button>
            </motion.li>
          ))}
        </ul>
      </div>
    );
  if (d.kind === "plan")
    return (
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-ink-200 bg-ink-100 text-center">
        {[
          ["Contacts", fmtInt(d.contacts)],
          ["Control group", fmtInt(d.control)],
          ["Expected ΔCLV", fmtEur(d.expectedDclvEur)],
        ].map(([k, v]) => (
          <div key={k} className="bg-white px-2 py-2">
            <div className="num text-[15px] font-semibold text-ink-950">{v}</div>
            <div className="text-[11px] text-ink-500">{k}</div>
          </div>
        ))}
        {d.byChannel.length > 0 && (
          <div className="col-span-3 flex flex-wrap justify-center gap-x-3 gap-y-0.5 bg-white px-2 py-1.5 text-[11.5px] text-ink-500">
            {d.byChannel.map((c) => (
              <span key={c.key}>
                {chLabel(c.key)} <b className="num text-ink-800">{c.contacts}</b>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  return <ChartCard spec={d.spec} result={d.result} compact />;
}

/** The list of steps under a finished answer, collapsed. */
export function StepsDisclosure({ calls }: { calls: ChatToolCall[] }) {
  const [open, setOpen] = useState(false);
  if (!calls.length) return null;
  return (
    <div className="text-[12px]">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-ink-400 hover:text-ink-700">
        <ChevronRight size={12} className={clsx("transition-transform", open && "rotate-90")} />
        {calls.length} {calls.length === 1 ? "step" : "steps"}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 pl-4">
          {calls.map((c) => (
            <li key={c.id} className="flex items-start gap-1.5 text-ink-500">
              {c.ok ? <Check size={11} className="mt-[3px] shrink-0 text-good-600" /> : <XCircle size={11} className="mt-[3px] shrink-0 text-bad-600" />}
              {c.ui && <MousePointer2 size={11} className="mt-[3px] shrink-0 text-violet-600" />}
              <span>
                <span className="text-ink-700">{c.summary.split(" · ")[0]}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const PROPOSAL_LABEL: Record<ChatProposal["kind"], string> = {
  create_campaign: "New campaign",
  update_campaign: "Change campaign",
  create_automation: "New automation",
  add_command: "New command",
  add_block: "New email block",
  update_terms: "Change contact rules",
  save_chart: "Chart",
  open_view: "Open",
};
const HIDDEN_KEYS = new Set(["campaign_id", "blocks", "steps", "show_if", "du", "sie", "audience", "spec", "result", "template_id"]);
const VOCAB_KEYS: Record<string, keyof Omit<Vocabulary, "offers">> = {
  segments: "segments",
  exclude_segments: "segments",
  personas: "personas",
  pains: "pains",
  value_tiers: "value_tiers",
  holds: "holdings",
  lacks: "holdings",
  churn_drivers: "churn_drivers",
};

function fmtValue(v: unknown, vocab: Vocabulary | null, key = ""): string {
  if (v == null) return "–";
  if (Array.isArray(v)) return v.map((x) => fmtValue(x, vocab, key)).join(", ");
  if (typeof v === "object")
    return Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x != null && !(Array.isArray(x) && !x.length))
      .map(([k, x]) => `${humanize(k)}: ${fmtValue(x, vocab, k)}`)
      .join(" · ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  const s = String(v);
  if (key === "channels" || key === "reachable_via") return chLabel(s);
  if (key === "offer_ids") return vocab?.offers.find((o) => o.offer_id === s)?.product_name ?? s;
  const kind = VOCAB_KEYS[key];
  if (kind) return vocab?.[kind].find((x) => x.key === s)?.description ?? humanize(s);
  if (/^[a-z]+(_[a-z]+)+$/.test(s)) return humanize(s);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

export function ProposalCard({ call, onAct }: { call: ChatToolCall; onAct: OnAct }) {
  const p = call.proposal!;
  const nav = useNavigate();
  const vocab = useVocabulary();
  const [busy, setBusy] = useState(false);
  const rows = Object.entries(p.payload).filter(([k, v]) => !HIDDEN_KEYS.has(k) && v != null && v !== "" && !(Array.isArray(v) && !v.length));
  const steps = Array.isArray(p.payload.steps) ? (p.payload.steps as { kind: string }[]) : [];
  const blocks = Array.isArray(p.payload.blocks) ? (p.payload.blocks as string[]) : [];
  const to = targetFor(p);
  const run = async (a: "apply" | "discard") => {
    setBusy(true);
    await onAct(call, a);
    setBusy(false);
  };
  const chart = p.kind === "save_chart" ? (p.payload as { spec: Record<string, unknown>; result: unknown }) : null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className={clsx("overflow-hidden rounded-xl border bg-white", p.status === "pending" ? "border-violet-600/30 shadow-[0_1px_3px_rgba(91,33,182,0.08)]" : "border-ink-200")}
    >
      <div className="border-b border-ink-100 px-3.5 py-2.5">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-violet-600">{PROPOSAL_LABEL[p.kind]}</div>
        <div className="mt-0.5 text-[13.5px] font-semibold text-ink-950">{p.title}</div>
        {p.description && <div className="mt-0.5 text-[12.5px] text-ink-500">{p.description}</div>}
      </div>
      {chart && (
        <div className="px-2 py-2">
          <ChartCard spec={chart.spec} result={chart.result} compact bare />
        </div>
      )}
      {!chart && (rows.length > 0 || steps.length > 0 || blocks.length > 0) && (
        <dl className="space-y-1 px-3.5 py-2.5 text-[12.5px]">
          {rows.slice(0, 8).map(([k, v]) => (
            <div key={k} className="grid grid-cols-[110px_1fr] gap-2">
              <dt className="text-ink-400">{humanize(k)}</dt>
              <dd className="min-w-0 break-words text-ink-700">{fmtValue(v, vocab, k)}</dd>
            </div>
          ))}
          {steps.length > 0 && (
            <div className="grid grid-cols-[110px_1fr] gap-2">
              <dt className="text-ink-400">Steps</dt>
              <dd className="text-ink-700">{["consent gate", ...steps.map((s) => humanize(s.kind))].join(" → ")}</dd>
            </div>
          )}
          {blocks.length > 0 && (
            <div className="grid grid-cols-[110px_1fr] gap-2">
              <dt className="text-ink-400">Blocks</dt>
              <dd className="text-ink-700">{blocks.map(humanize).join(", ")}</dd>
            </div>
          )}
        </dl>
      )}
      <div className="flex items-center justify-end gap-2 border-t border-ink-100 bg-ink-50/50 px-3.5 py-2">
        {p.status === "pending" ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => run("discard")} disabled={busy}>
              Discard
            </Button>
            <Button size="sm" variant="violet" icon={busy ? Loader2 : Check} onClick={() => run("apply")} disabled={busy}>
              {p.kind === "save_chart" ? "Save to Analytics" : "Apply"}
            </Button>
          </>
        ) : p.status === "applied" ? (
          <>
            <span className="mr-auto flex items-center gap-1 text-[12.5px] font-medium text-good-600">
              <Check size={13} /> {p.kind === "save_chart" ? "Saved" : "Applied"}
            </span>
            {to && (
              <Button size="sm" onClick={() => nav(to)}>
                Open
              </Button>
            )}
          </>
        ) : (
          <span className="mr-auto text-[12.5px] text-ink-400">Discarded</span>
        )}
      </div>
    </motion.div>
  );
}

function OpenViewButton({ call, onAct }: { call: ChatToolCall; onAct: OnAct }) {
  const nav = useNavigate();
  const p = call.proposal!;
  const to = targetFor(p);
  return (
    <Button
      size="sm"
      icon={ChevronRight}
      onClick={() => {
        if (p.status === "pending") void onAct(call, "apply");
        else if (to) nav(to);
      }}
    >
      {p.title}
    </Button>
  );
}

const el = (Tag: "p" | "ul" | "ol" | "h3" | "h4" | "strong" | "blockquote" | "code" | "th" | "td", cls: string) =>
  function El({ children }: { children?: ReactNode }) {
    return <Tag className={cls}>{children}</Tag>;
  };

function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  const nav = useNavigate();
  if (!href?.startsWith("/"))
    return (
      <a href={href} target="_blank" rel="noreferrer" className="text-navy-700 underline">
        {children}
      </a>
    );
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        nav(href);
      }}
      className="font-medium text-navy-700 underline decoration-navy-700/30 underline-offset-2 hover:decoration-navy-700"
    >
      {children}
    </a>
  );
}

const MD_COMPONENTS = {
  p: el("p", "my-2 first:mt-0 last:mb-0"),
  ul: el("ul", "my-2 list-disc space-y-1 pl-5"),
  ol: el("ol", "my-2 list-decimal space-y-1 pl-5"),
  h1: el("h3", "mb-1 mt-3 text-[14px] font-semibold text-ink-950"),
  h2: el("h3", "mb-1 mt-3 text-[14px] font-semibold text-ink-950"),
  h3: el("h4", "mb-1 mt-3 text-[13.5px] font-semibold text-ink-950"),
  strong: el("strong", "font-semibold text-ink-950"),
  blockquote: el("blockquote", "my-2 border-l-2 border-ink-200 pl-3 text-ink-500"),
  code: el("code", "rounded bg-ink-100 px-1 py-0.5 font-mono text-[12px]"),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-ink-200 scroll-thin">
      <table className="w-full text-[12.5px]">{children}</table>
    </div>
  ),
  th: el("th", "border-b border-ink-200 bg-ink-50 px-2 py-1.5 text-left font-medium text-ink-600"),
  td: el("td", "border-b border-ink-100 px-2 py-1.5 align-top"),
  a: MdLink,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-[13.5px] leading-relaxed text-ink-800">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

