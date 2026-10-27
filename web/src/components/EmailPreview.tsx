// A rendered email as one customer receives it, plus the guardrail checks.
import clsx from "clsx";
import { CheckCircle2, EyeOff, XCircle } from "lucide-react";
import { useState } from "react";
import type { RenderedEmail } from "../../../shared/types";
import { useBlocks, useVocabulary } from "../lib/catalog";
import { humanize, plainWhy } from "../lib/format";
import { channelName, plainCheck, plainHidden, plainText, plural } from "./outreach/copy";
import { Badge } from "./ui";

export function EmailPreview({ email, compact }: { email: RenderedEmail; compact?: boolean }) {
  const [showHidden, setShowHidden] = useState(false);
  const catalog = useBlocks();
  const vocab = useVocabulary();
  const ctx = { fields: catalog?.fields, offers: vocab?.offers };
  const blockName = (type: string) => catalog?.blocks.find((d) => d.type === type)?.label ?? (type.startsWith("custom:") ? "Custom block" : humanize(type));
  const hidden = email.blocks.filter((b) => !b.visible);
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-ink-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
        <div className="space-y-0.5 border-b border-ink-100 px-4 py-2.5 text-[12px] text-ink-500">
          <div>
            <span className="inline-block w-12 text-ink-400">From</span>MAINGAU Energie
          </div>
          <div className="truncate">
            <span className="inline-block w-12 text-ink-400">To</span>
            {email.identity.name} &lt;{email.identity.email}&gt;
          </div>
          <div className="truncate text-[13px] font-semibold text-ink-900">
            <span className="inline-block w-12 font-normal text-ink-400">Subject</span>
            {email.subject}
          </div>
        </div>
        <div className={clsx("space-y-3 px-5 py-4 text-[13.5px] leading-relaxed text-ink-800", compact && "max-h-[420px] overflow-y-auto scroll-thin")}>
          {email.blocks.map((b) => {
            if (!b.visible) {
              if (!showHidden) return null;
              return (
                <div key={b.id} className="flex items-start gap-2 rounded-lg border border-dashed border-ink-200 px-3 py-2 text-[12px] text-ink-400">
                  <EyeOff size={13} className="mt-0.5 shrink-0" />
                  <span>
                    <b className="font-medium text-ink-500">{blockName(b.type)}</b> hidden: {plainHidden(b.hiddenReason, ctx)}
                  </span>
                </div>
              );
            }
            if (b.type === "hero")
              return (
                <div key={b.id} className="-mx-5 -mt-4 mb-1 bg-navy-900 px-5 py-5">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-sun-400">MAINGAU Energie</div>
                  <div className="mt-1 text-[18px] font-semibold leading-snug text-white">{b.title}</div>
                </div>
              );
            if (b.type === "divider") return <hr key={b.id} className="border-ink-100" />;
            if (b.type === "footer")
              return (
                <div key={b.id} className="border-t border-ink-100 pt-3">
                  <p className="whitespace-pre-line">{b.text}</p>
                  <p className="mt-3 text-[11px] leading-snug text-ink-400">MAINGAU Energie GmbH · Ringstraße 4–6 · 63179 Obertshausen · Abmelden · Datenschutz</p>
                </div>
              );
            return (
              <div key={b.id} title={b.source ? plainText(plainWhy(b.source), ctx) : undefined} className={clsx(b.type === "service_status" && "rounded-lg bg-sun-100/70 px-3 py-2.5", b.type === "survey" && "rounded-lg bg-ink-50 px-3 py-2.5")}>
                {b.title && <div className={clsx("mb-0.5 font-semibold text-ink-950", b.type === "survey" && "tracking-[0.2em] text-warn-600")}>{b.title}</div>}
                {b.text && <p className="whitespace-pre-line">{b.text}</p>}
                {b.cta && (
                  <span className="mt-2 inline-block rounded-md bg-sun-400 px-3 py-1.5 text-[12.5px] font-semibold text-navy-950">{b.cta.label}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <Badge tint={email.variant === "service" ? "sun" : email.variant === "generic" ? "neutral" : "navy"}>{email.variantLabel}</Badge>
        <Badge tint={email.tone === "du" ? "violet" : "navy"}>{email.tone === "du" ? "Du" : "Sie"}</Badge>
        <Badge tint={email.reachable ? "good" : "bad"}>{email.reachable ? `${channelName(email.channel)} consent` : `No ${channelName(email.channel)} consent`}</Badge>
        {hidden.length > 0 && (
          <button onClick={() => setShowHidden((v) => !v)} className="ml-auto text-[12px] font-medium text-navy-700 hover:underline">
            {showHidden ? "Hide" : "Show"} {plural(hidden.length, "hidden block")}
          </button>
        )}
      </div>
      <Checks checks={email.checks} />
    </div>
  );
}

export function Checks({ checks }: { checks: RenderedEmail["checks"] }) {
  const failed = checks.filter((c) => !c.passed);
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-ink-200 bg-white">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px]">
        {failed.length ? <XCircle size={14} className="text-bad-600" /> : <CheckCircle2 size={14} className="text-good-600" />}
        <span className="font-medium">{failed.length ? `${plural(failed.length, "guardrail")} failed` : checks.length === 1 ? "The guardrail passed" : `All ${checks.length} guardrails passed`}</span>
        <span className="ml-auto text-ink-400">{open ? "Hide" : "Details"}</span>
      </button>
      {(open || failed.length > 0) && (
        <ul className="space-y-1 border-t border-ink-100 px-3 py-2 text-[12px]">
          {(open ? checks : failed).map((c) => {
            const t = plainCheck(c);
            return (
              <li key={c.check} className="flex items-start gap-1.5">
                {c.passed ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-good-600" /> : <XCircle size={13} className="mt-0.5 shrink-0 text-bad-600" />}
                <span className={c.passed ? "text-ink-600" : "text-bad-600"}>
                  {t.check}
                  {t.detail && <span className="text-ink-400"> · {t.detail}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
