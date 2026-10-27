// Step 3 of the guided outreach: one overview of who, when and what, every guardrail with its fix,
// and the Send button. Only a person can press it; Kompass can bring the campaign here, never send.
import clsx from "clsx";
import { AlertTriangle, ArrowRight, BellRing, CheckCircle2, FlaskConical, Hourglass, Mail, MessageSquareText, MonitorSmartphone, PhoneCall, Send, ShieldCheck, UserCheck, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { Campaign, CampaignReview, MessageChannel, Settings, VariantStat } from "../../../../shared/types";
import { api, type CampaignFull } from "../../api/client";
import { describeAudience } from "../AudienceBuilder";
import { useVocabulary } from "../../lib/catalog";
import { fmtDelta, fmtEur, fmtInt } from "../../lib/format";
import { AnimatedNumber, AnimatePresence, EASE, motion, spring, Stagger, StaggerItem } from "../motion";
import { Badge, Button, ErrorNote, Select, Skeleton, Spinner, Toggle } from "../ui";
import { approvalsNeeded, channelName, fmtWhen, plural, PREVIEW_SAMPLE } from "./copy";

/** The label is the channel's name everywhere; `editor` is what its draft is called inside a sentence. */
export const MESSAGE_CHANNELS: Record<MessageChannel, { label: string; icon: LucideIcon; editor: string }> = {
  email: { label: channelName("email"), icon: Mail, editor: "email" },
  portal_popup: { label: channelName("portal_popup"), icon: MonitorSmartphone, editor: "portal pop-up" },
  sms: { label: channelName("sms"), icon: MessageSquareText, editor: "SMS" },
  call: { label: channelName("call"), icon: PhoneCall, editor: "call script" },
};
const APPROVERS = [
  { by: "You", role: "CRM manager" },
  { by: "Caro Lehmann", role: "Marketing lead" },
];
let seq = 0;

/** The review as the server sends it: per channel also how many contacts were checked, the versions with their counts and the checks that failed. */
type ReviewChannel = CampaignReview["channels"][number] & { sampled?: number; variants?: VariantStat[]; failing?: { check: string; count: number }[] };
type Review = Omit<CampaignReview, "channels"> & { channels: ReviewChannel[] };

/** Where a figure comes from: "in the preview of 40 of 203", the same words step 2 uses. */
const basis = (sampled: number, total: number) => (total > sampled ? `in the preview of ${fmtInt(sampled)} of ${fmtInt(total)}` : total === 1 ? "for this recipient" : `across all ${fmtInt(total)}`);

function Panel({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <StaggerItem className={clsx("rounded-xl border border-ink-200 bg-white p-5", className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-400">{title}</div>
        {action}
      </div>
      {children}
    </StaggerItem>
  );
}

const linkCls = "text-[12.5px] font-medium text-navy-700 hover:underline";

export function ReviewSend({
  c,
  settings,
  planning,
  saving = false,
  onGo,
  onEdit,
  onChanged,
  onLaunched,
}: {
  c: CampaignFull;
  settings: Settings | null;
  planning: boolean;
  /** Edits are still on their way to the server. */
  saving?: boolean;
  onGo: (step: "who" | "message") => void;
  onEdit: (p: Partial<Campaign>) => void;
  onChanged: (c: Campaign) => void;
  onLaunched: () => void;
}) {
  const vocab = useVocabulary();
  const [review, setReview] = useState<{ key: string; data: Review } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sending, setSending] = useState<"run" | "done" | null>(null);
  const s = c.plan?.summary;
  const key = JSON.stringify([c.plan?.computedAt, c.timing, c.email, c.drafts]);
  useEffect(() => {
    if (!c.plan) return;
    let live = true;
    // Edits are saved after a short pause, so the review waits a little longer.
    const t = setTimeout(() => {
      api.campaignReview(c.id).then(
        (r) => live && (setReview({ key, data: r }), setErr(null)),
        (e) => live && setErr((e as Error).message),
      );
    }, 900);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const r = review?.data ?? null;
  // The review on screen may belong to the text before the last edit: it is dimmed until the new one is in.
  const stale = !!r && review?.key !== key;

  const need = r?.approvalsNeeded ?? approvalsNeeded(settings);
  const mine = c.approvals.some((a) => a.by === "You");
  const ready = c.approvals.length >= need;
  const second = APPROVERS[1];
  // One state decides the heading, the sentence and the button, so they never disagree:
  // "send" = you can press Send now, "request" = your approval is still missing, "waiting" = the second approver is.
  const stage: "send" | "request" | "waiting" = need <= 1 || ready ? "send" : mine ? "waiting" : "request";
  const timing = c.timing ?? { mode: "asap" as const };
  const verb = timing.mode === "asap" ? "Send" : "Schedule";
  const blockers = r?.checks.filter((x) => !x.ok) ?? [];
  const reminder = c.reminder ?? { on: false, days: 5, channel: "portal_popup" };
  const n = s?.contacts ?? 0;

  const act = async (k: string, fn: () => Promise<void>) => {
    setBusy(k);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const approve = async (by: string, role: string) => {
    const camp = await api.approveCampaign(c.id, by, role);
    onChanged(camp);
    return camp;
  };
  const requestApproval = () => act("request", async () => void (await approve("You", "CRM manager")));
  const send = () =>
    act("send", async () => {
      // Pressing Send is your approval when nobody else's is needed.
      let camp: Campaign = c as unknown as Campaign;
      if (!mine) camp = await approve("You", "CRM manager");
      if (camp.approvals.length < need) return;
      setSending("run");
      const steps = Math.max(1, r?.schedule.length ?? 1);
      await Promise.all([api.launchCampaign(c.id), new Promise((res) => setTimeout(res, 700 * steps + 900))]);
      setSending("done");
    });

  if (!c.plan) return <p className="p-6 text-[13px] text-ink-500">{planning ? "Planning the audience…" : "Choose an audience in step 1 first."}</p>;

  const head =
    stage === "send"
      ? { Icon: ShieldCheck, tone: "text-good-600", title: need > 1 ? "Approved, ready to send" : "Ready when you are" }
      : stage === "request"
        ? { Icon: UserCheck, tone: "text-warn-600", title: "Your approval comes first" }
        : { Icon: Hourglass, tone: "text-warn-600", title: `Waiting for ${second.by}` };
  const guardrails = !r ? "Checking the guardrails…" : blockers.length ? `${plural(blockers.length, "point")} to look at${stage === "send" ? ". You can still send." : "."}` : "Every guardrail holds.";
  const rule =
    stage === "request"
      ? `Two people approve before anything goes out: requesting approval records yours and asks ${second.by} to approve too. Nothing is sent until you press Send after that.`
      : stage === "waiting"
        ? `You approved. ${second.by} still has to approve; then you can send.`
        : need > 1
          ? "Both approvals are in. Only you can press Send; Kompass never sends."
          : "Only you can press Send; Kompass never sends.";
  const buttonLabel = !n
    ? "Nobody to send to"
    : planning
      ? "Updating the audience…"
      : saving
        ? "Saving your changes…"
        : stage === "request"
          ? "Request approval"
          : stage === "waiting"
            ? "Waiting for second approval"
            : `${verb === "Send" ? "Send to" : "Schedule for"} ${plural(n, "customer")}`;

  return (
    <div className="h-full overflow-y-auto page-scroll px-8 py-6 scroll-thin">
      <div className="mx-auto grid max-w-[1120px] grid-cols-[1fr_360px] gap-6">
        <Stagger className={clsx("space-y-4 transition-opacity", stale && "opacity-60")} step={0.06}>
          <div className="grid grid-cols-2 gap-4">
            <Panel title="Who" action={<button onClick={() => onGo("who")} className={linkCls}>Change</button>}>
              <div className="text-[14px] font-medium text-ink-900">{c.audienceLabel || describeAudience(c.audience, vocab)}</div>
              <div className="mt-3 flex items-end gap-5">
                <div>
                  <AnimatedNumber value={n} className="text-[28px] font-semibold leading-none tracking-tight text-ink-950" />
                  <div className="mt-1 text-[12px] text-ink-500">{n === 1 ? "gets a message" : "get a message"}</div>
                </div>
                <div className="pb-0.5 text-[12.5px] leading-relaxed text-ink-600">
                  <div>
                    <b className="num">{fmtInt(s?.control ?? 0)}</b> held out as control
                  </div>
                  <div>
                    <b className="num">{fmtInt(s?.skipped ?? 0)}</b> left out
                  </div>
                </div>
              </div>
              <div className="mt-3 rounded-lg bg-sun-100 px-3 py-2 text-[12.5px] text-navy-950">
                Expected CLV gain <b className="num">{fmtDelta(Math.round(s?.expected_dclv_eur ?? 0))}</b>
                {s && s.contact_cost_eur > 0 && <span className="text-ink-600"> after {fmtEur(s.contact_cost_eur, true)} contact costs</span>}
              </div>
            </Panel>
            <Panel title="When" action={<button onClick={() => onGo("who")} className={linkCls}>Change</button>}>
              <div className="text-[14px] font-medium text-ink-900">{timing.mode === "asap" ? "As soon as you press Send" : timing.mode === "fixed" ? `On ${fmtWhen(timing.at)}` : "At each customer's best time"}</div>
              {!r ? (
                <Skeleton className="mt-3 h-16" />
              ) : (
                <div className="mt-3 space-y-1.5">
                  {r.schedule.map((x) => (
                    <div key={x.label} className="flex items-center gap-3 text-[12.5px]">
                      <span className="num w-36 shrink-0 text-ink-700">{x.label}</span>
                      <div className="h-1.5 flex-1 rounded-full bg-ink-100">
                        <motion.div className="h-1.5 rounded-full bg-navy-700" initial={{ width: 0 }} animate={{ width: `${(x.customers / Math.max(1, s?.contacts ?? 1)) * 100}%` }} transition={{ duration: 0.6, ease: EASE }} />
                      </div>
                      <span className="num w-8 text-right text-ink-500">{fmtInt(x.customers)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <Panel title="What goes out" action={<button onClick={() => onGo("message")} className={linkCls}>Edit messages</button>}>
            {!r ? (
              <div className="grid grid-cols-2 gap-3">
                <Skeleton className="h-36" />
                <Skeleton className="h-36" />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {r.channels.map((ch) => {
                  const meta = MESSAGE_CHANNELS[ch.key];
                  const sampled = ch.sampled ?? Math.min(PREVIEW_SAMPLE, ch.contacts);
                  return (
                    <div key={ch.key} className="flex flex-col rounded-lg border border-ink-200 bg-ink-50/40 p-3">
                      <div className="flex items-center gap-2">
                        <meta.icon size={15} className="text-ink-500" />
                        <span className="text-[13px] font-medium text-ink-900">{meta.label}</span>
                        <span className="num ml-auto text-[12.5px] text-ink-500">{fmtInt(ch.contacts)}</span>
                      </div>
                      {ch.sample && (
                        <div className="mt-2 rounded-md bg-white px-2.5 py-2 text-[12px] shadow-[0_1px_0_rgba(0,0,0,0.03)]">
                          {ch.key === "email" && <div className="mb-1 truncate font-medium text-ink-900">{ch.sample.subject}</div>}
                          <div className="line-clamp-4 whitespace-pre-line leading-snug text-ink-600">{ch.sample.text}</div>
                          <div className="mt-1.5 text-[11px] text-ink-400">
                            as {ch.sample.name} sees it · {ch.sample.tone === "du" ? "Du" : "Sie"}
                          </div>
                        </div>
                      )}
                      <div className="mt-2 space-y-1">
                        {!ch.hasDraft && <Badge tint="warn">uses the email text</Badge>}
                        <div className="text-[11.5px] text-ink-500">
                          {plural(ch.versions.length, "version")} {basis(sampled, ch.contacts)}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {(ch.variants ?? ch.versions.map((label) => ({ variant: label, label, count: 0 }))).map((v) => (
                            <span key={v.variant} className="rounded-md bg-ink-100 px-1.5 py-0.5 text-[11.5px] text-ink-700">
                              {v.count > 0 && <span className="num font-medium">{v.count} · </span>}
                              {v.label}
                            </span>
                          ))}
                        </div>
                        {ch.failing && ch.failing.length > 0 && (
                          <div className="text-[11.5px] text-bad-600">
                            Fails: {ch.failing.map((f) => `${f.check} (${f.count})`).join(" · ")}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title="Guardrails">
            {!r ? (
              <Skeleton className="h-40" />
            ) : (
              <ul className="space-y-2.5">
                {r.checks.map((ch, i) => (
                  <motion.li key={ch.key} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + i * 0.06, duration: 0.3, ease: EASE }} className="flex items-start gap-2.5 text-[13px]">
                    {ch.ok ? <CheckCircle2 size={17} className="mt-px shrink-0 text-good-600" /> : <AlertTriangle size={17} className="mt-px shrink-0 text-warn-600" />}
                    <div className="min-w-0 flex-1">
                      <div className={ch.ok ? "text-ink-800" : "font-medium text-ink-900"}>{ch.label}</div>
                      {ch.detail && <div className="text-[12px] text-ink-500">{ch.detail}</div>}
                    </div>
                    {ch.fix === "footer" && (
                      <Button size="sm" onClick={() => onEdit({ email: { ...c.email, blocks: [...c.email.blocks, { id: `b-footer-${Date.now().toString(36)}${seq++}`, type: "footer", props: {} }] } })}>
                        Add footer
                      </Button>
                    )}
                    {ch.fix === "control" && c.controlShare < 0.2 && (
                      <Button size="sm" onClick={() => onEdit({ controlShare: 0.2 })}>
                        Hold out 20 %
                      </Button>
                    )}
                    {ch.fix === "message" && (
                      <Button size="sm" onClick={() => onGo("message")}>
                        Fix in step 2
                      </Button>
                    )}
                  </motion.li>
                ))}
              </ul>
            )}
          </Panel>
        </Stagger>

        <div className="space-y-4">
          <div className="sticky top-0 space-y-4">
            <motion.div layout className="overflow-hidden rounded-2xl border border-ink-200 bg-white p-5 shadow-[0_12px_32px_-18px_rgba(10,42,102,0.35)]">
              <AnimatePresence mode="wait" initial={false}>
                {sending ? (
                  <SendingView key="sending" review={r} done={sending === "done"} verb={verb} total={n} onResults={onLaunched} />
                ) : (
                  <motion.div key="ready" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -8 }}>
                    <div className="flex items-center gap-2 text-[14px] font-semibold text-ink-950">
                      <head.Icon size={16} className={head.tone} /> {head.title}
                    </div>
                    <p className="mt-1 text-[12.5px] text-ink-500">
                      {guardrails} {rule}
                    </p>
                    {need > 1 && (
                      <div className="mt-3 space-y-1.5">
                        {APPROVERS.map((a) => {
                          const done = c.approvals.find((x) => x.by === a.by);
                          return (
                            <div key={a.by} className="flex items-center gap-2 rounded-lg border border-ink-200 px-3 py-2">
                              <UserCheck size={15} className={done ? "text-good-600" : "text-ink-300"} />
                              <div className="min-w-0 flex-1 text-[12.5px]">
                                <div className="font-medium text-ink-900">{a.by}</div>
                                <div className="text-[11.5px] text-ink-500">{done ? `Approved ${fmtWhen(done.at)}` : a.by === "You" ? a.role : mine ? "Waiting for approval" : a.role}</div>
                              </div>
                              {!done && a.by !== "You" && mine && (
                                <Button size="sm" disabled={!!busy} title="Prototype: records this approval for them" onClick={() => act(a.by, async () => void (await approve(a.by, a.role)))}>
                                  {busy === a.by ? <Spinner /> : "Approve"}
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <motion.div whileHover={{ scale: !n || stage === "waiting" ? 1 : 1.01 }} whileTap={{ scale: 0.98 }} className="mt-4">
                      <Button variant="sun" className="h-12 w-full text-[15px]" disabled={!n || planning || saving || !!busy || stage === "waiting"} onClick={stage === "request" ? requestApproval : send}>
                        {busy === "send" || busy === "request" ? <Spinner /> : stage === "send" ? <Send size={17} /> : stage === "request" ? <UserCheck size={17} /> : <Hourglass size={17} />}
                        {buttonLabel}
                      </Button>
                    </motion.div>
                    <p className="mt-2.5 flex items-start gap-1.5 text-[11.5px] text-ink-500">
                      <FlaskConical size={13} className="mt-px shrink-0" /> Prototype: nothing really leaves. Delivery and responses are simulated from the engine's acceptance rates and MAINGAU's channel benchmarks.
                    </p>
                    <ErrorNote error={err} className="mt-2" />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>

            {!sending && (
              <div className="rounded-xl border border-ink-200 bg-white p-4">
                <div className="flex items-center gap-2.5">
                  <BellRing size={15} className="text-ink-500" />
                  <span className="flex-1 text-[13px] font-medium text-ink-900">Remind who did not react</span>
                  <Toggle checked={reminder.on} onChange={(on) => onEdit({ reminder: { ...reminder, on } })} label="Reminder" />
                </div>
                <AnimatePresence initial={false}>
                  {reminder.on && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: EASE }} className="overflow-hidden">
                      <div className="flex items-center gap-2 pt-3 text-[12.5px] text-ink-600">
                        after
                        <Select value={String(reminder.days)} onChange={(e) => onEdit({ reminder: { ...reminder, days: Number(e.target.value) } })} className="w-24" options={[...new Set([3, 5, 7, 10, reminder.days])].sort((a, b) => a - b).map((d) => ({ value: String(d), label: plural(d, "day") }))} />
                        by
                        <Select value={reminder.channel} onChange={(e) => onEdit({ reminder: { ...reminder, channel: e.target.value } })} className="w-36" options={["portal_popup", "email", "sms"].map((x) => ({ value: x, label: MESSAGE_CHANNELS[x as MessageChannel].label }))} />
                      </div>
                      <p className="mt-2 text-[11.5px] text-ink-500">Same guardrails and contact limits; customers who already reacted or bought are skipped.</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Simulated delivery, slot by slot, then a short success moment. */
function SendingView({ review, done, verb, total, onResults }: { review: Review | null; done: boolean; verb: string; total: number; onResults: () => void }) {
  const rows = review?.schedule.length ? review.schedule : [{ at: "", label: "Now", customers: total }];
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: EASE }}>
      <AnimatePresence mode="wait">
        {!done ? (
          <motion.div key="run" exit={{ opacity: 0, scale: 0.98 }}>
            <div className="flex items-center gap-2 text-[14px] font-semibold text-ink-950">
              <Spinner /> {verb === "Send" ? "Sending" : "Scheduling"} {plural(total, "message")}
            </div>
            <div className="mt-4 space-y-3">
              {rows.map((x, i) => (
                <div key={x.label}>
                  <div className="flex justify-between text-[12.5px]">
                    <span className="text-ink-700">{x.label}</span>
                    <span className="num text-ink-500">{fmtInt(x.customers)}</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink-100">
                    <motion.div className="h-2 rounded-full bg-navy-700" initial={{ width: 0 }} animate={{ width: "100%" }} transition={{ duration: 0.75, delay: i * 0.7, ease: EASE }} />
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        ) : (
          <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center py-2 text-center">
            <div className="relative grid h-16 w-16 place-items-center">
              {[0, 1, 2].map((k) => (
                <motion.span key={k} className="absolute inset-0 rounded-full border-2 border-good-600" initial={{ scale: 0.6, opacity: 0.6 }} animate={{ scale: 1.9, opacity: 0 }} transition={{ duration: 1.1, delay: k * 0.18, ease: "easeOut" }} />
              ))}
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ ...spring, delay: 0.05 }} className="grid h-16 w-16 place-items-center rounded-full bg-good-600 text-white">
                <CheckCircle2 size={30} />
              </motion.span>
            </div>
            <div className="mt-4 text-[16px] font-semibold text-ink-950">{verb === "Send" ? `${plural(total, "message")} ${total === 1 ? "is" : "are"} on the way` : `${plural(total, "message")} scheduled`}</div>
            <div className="mt-1 text-[12.5px] text-ink-500">Simulated. The control group gets nothing, so the results show what the campaign really changed.</div>
            <Button variant="primary" className="mt-4" onClick={onResults}>
              See results <ArrowRight size={15} />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
