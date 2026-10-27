// How one customer gets the message on each channel: a pop-up over the customer portal, an SMS on a
// phone, or a script card for the agent who calls.
import clsx from "clsx";
import { PhoneCall, X } from "lucide-react";
import type { RenderedEmail } from "../../../../shared/types";
import { Badge } from "../ui";
import { Checks, EmailPreview } from "../EmailPreview";
import { motion } from "../motion";
import { SMS_LIMIT, SMS_MAX_SEGMENTS, SMS_SEGMENT } from "./copy";

const visible = (e: RenderedEmail) => e.blocks.filter((b) => b.visible);

export function smsText(e: RenderedEmail) {
  return visible(e)
    .map((b) => b.text)
    .filter(Boolean)
    .join(" ");
}

function Footer({ e }: { e: RenderedEmail }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <Badge tint={e.variant === "service" ? "sun" : e.variant === "generic" ? "neutral" : "navy"}>{e.variantLabel}</Badge>
        <Badge tint={e.tone === "du" ? "violet" : "navy"}>{e.tone === "du" ? "Du" : "Sie"}</Badge>
        <Badge tint={e.reachable ? "good" : "bad"}>{e.reachable ? "Consent given" : "No consent for this channel"}</Badge>
      </div>
      <Checks checks={e.checks} />
    </>
  );
}

export function PopupPreview({ e }: { e: RenderedEmail }) {
  const blocks = visible(e);
  const hero = blocks.find((b) => b.type === "hero");
  const cta = blocks.find((b) => b.cta)?.cta;
  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-xl border border-ink-200 bg-[#eef1f5]">
        {/* A sketch of the customer portal behind the pop-up; the pop-up sets the height. */}
        <div className="absolute inset-0">
          <div className="flex items-center gap-2 border-b border-ink-200 bg-white px-3 py-2">
            <span className="h-4 w-4 rounded bg-navy-900" />
            <span className="text-[11px] font-semibold text-ink-700">Mein MAINGAU</span>
            <span className="ml-auto h-2 w-16 rounded bg-ink-100" />
          </div>
          <div className="space-y-2 p-3 opacity-60">
            <div className="h-3 w-1/2 rounded bg-ink-200" />
            <div className="grid grid-cols-3 gap-2">
              <div className="h-12 rounded-lg bg-white" />
              <div className="h-12 rounded-lg bg-white" />
              <div className="h-12 rounded-lg bg-white" />
            </div>
            <div className="h-20 rounded-lg bg-white" />
            <div className="h-20 rounded-lg bg-white" />
          </div>
          <div className="absolute inset-0 bg-ink-950/25" />
        </div>
        <motion.div
          key={e.customerId}
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.3 }}
          className="relative mx-5 mb-6 mt-12 overflow-hidden rounded-xl bg-white shadow-2xl"
        >
          <button className="absolute right-2 top-2 rounded-full bg-white/80 p-0.5 text-ink-400" aria-hidden tabIndex={-1}>
            <X size={13} />
          </button>
          {hero && (
            <div className="bg-navy-900 px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-sun-400">MAINGAU Energie</div>
              <div className="text-[14px] font-semibold text-white">{hero.title}</div>
            </div>
          )}
          <div className="max-h-[230px] space-y-2 overflow-y-auto px-4 py-3 text-[12.5px] leading-snug text-ink-800 scroll-thin">
            {blocks
              .filter((b) => b.type !== "hero" && (b.text || b.title))
              .map((b) => (
                <div key={b.id} className={clsx(b.type === "service_status" && "rounded-md bg-sun-100/70 px-2 py-1.5")}>
                  {b.title && <div className="font-semibold text-ink-950">{b.title}</div>}
                  {b.text && <p>{b.text}</p>}
                </div>
              ))}
          </div>
          {cta && (
            <div className="border-t border-ink-100 px-4 py-2.5">
              <span className="inline-block rounded-md bg-sun-400 px-3 py-1.5 text-[12px] font-semibold text-navy-950">{cta.label}</span>
            </div>
          )}
        </motion.div>
      </div>
      <Footer e={e} />
    </div>
  );
}

export function SmsPreview({ e }: { e: RenderedEmail }) {
  const text = smsText(e);
  const segments = Math.max(1, Math.ceil(text.length / SMS_SEGMENT));
  const tooLong = text.length > SMS_LIMIT;
  return (
    <div className="space-y-3">
      <div className="mx-auto w-[260px] rounded-[30px] border-[6px] border-ink-900 bg-[#f2f2f7] px-3 pb-6 pt-3 shadow-lg">
        <div className="mx-auto mb-3 h-1.5 w-16 rounded-full bg-ink-900/80" />
        <div className="mb-2 text-center text-[10.5px] text-ink-500">
          <div className="mx-auto mb-1 grid h-7 w-7 place-items-center rounded-full bg-navy-900 text-[10px] font-bold text-sun-400">M</div>
          MAINGAU
        </div>
        <motion.div key={`${e.customerId}${text.length}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-[92%] whitespace-pre-line rounded-2xl rounded-bl-md bg-white px-3 py-2 text-[12.5px] leading-snug text-ink-900 shadow-sm">
          {text || <span className="text-ink-400">Nothing to say for this customer.</span>}
        </motion.div>
      </div>
      <div className={clsx("flex items-center justify-between rounded-lg px-3 py-2 text-[12px]", tooLong ? "bg-bad-50 text-bad-600" : "bg-ink-50 text-ink-600")}>
        <span>
          <b className="num">{text.length}</b> of {SMS_LIMIT} characters
        </span>
        <span>
          {segments} SMS{tooLong ? `: too long, keep it to ${SMS_MAX_SEGMENTS}` : ""}
        </span>
      </div>
      <Footer e={e} />
    </div>
  );
}

export function CallPreview({ e }: { e: RenderedEmail }) {
  const blocks = visible(e).filter((b) => b.text || b.title);
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-ink-200 bg-white">
        <div className="flex items-center gap-2 border-b border-ink-100 bg-ink-50 px-4 py-2.5">
          <PhoneCall size={14} className="text-navy-700" />
          <span className="text-[12.5px] font-semibold text-ink-900">Call script · {e.identity.name}</span>
          <Badge tint={e.tone === "du" ? "violet" : "navy"} className="ml-auto">
            {e.tone === "du" ? "Du" : "Sie"}
          </Badge>
        </div>
        <ol className="divide-y divide-ink-100">
          {blocks.map((b, i) => (
            <li key={b.id} className="flex gap-3 px-4 py-2.5">
              <span className="num mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-navy-50 text-[10.5px] font-semibold text-navy-800">{i + 1}</span>
              <div className="min-w-0 text-[12.5px] leading-snug">
                {b.title && <div className="mb-0.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-500">{b.title}</div>}
                {b.type === "objections" ? (
                  <ul className="space-y-1">
                    {b.text.split("\n").map((l) => {
                      const [say, answer] = l.split(" → ");
                      return (
                        <li key={l}>
                          <span className="font-medium text-ink-900">{say}</span>
                          <span className="block text-ink-600">{answer}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="whitespace-pre-line text-ink-800">{b.text}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div className="border-t border-ink-100 bg-ink-50/60 px-4 py-2 text-[11.5px] text-ink-500">If the customer does not want calls: note it at once. No pressure, no deadlines.</div>
      </div>
      <Footer e={e} />
    </div>
  );
}

export function ChannelPreview({ channel, e }: { channel: string; e: RenderedEmail }) {
  if (channel === "portal_popup") return <PopupPreview e={e} />;
  if (channel === "sms") return <SmsPreview e={e} />;
  if (channel === "call") return <CallPreview e={e} />;
  return <EmailPreview email={e} />;
}
