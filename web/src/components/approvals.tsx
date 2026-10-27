// Approvals: every draft an automation, campaign or person prepared waits here for a human. Each row
// says what goes out, on which channel, to whom and why; the review panel shows it as the customer
// will see it, lets you fix the text (the checks run again) and keeps the decision log.
import clsx from "clsx";
import { Bell, Check, ClipboardList, ExternalLink, Gift, Headset, Mail, MessageSquare, MonitorSmartphone, Pencil, Phone, Smartphone, X, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Proposal } from "../../../shared/types";
import { api, ApiError } from "../api/client";
import { chLabel, evLabel, fmtDateTime, fmtDelta, plural } from "../lib/format";
import { Checks } from "./EmailPreview";
import { Badge, Button, ErrorNote, Sheet, Textarea, ToneBadge, inputCls } from "./ui";

export const KIND_LABEL: Record<Proposal["kind"], string> = { message: "Message", task: "Task for a team", voucher: "Voucher", survey: "Survey", notify: "Team note" };

const CHANNEL_ICON: Record<string, LucideIcon> = {
  email: Mail,
  newsletter: Mail,
  portal_popup: MonitorSmartphone,
  app_push: Smartphone,
  sms: MessageSquare,
  outbound_call: Phone,
  service_contact: Headset,
};

/** What the row leads with: the channel for messages, the kind for tasks and notes. */
export function proposalIcon(p: Proposal): { icon: LucideIcon; label: string; tint: string } {
  if (p.kind === "task") return { icon: ClipboardList, label: "Task", tint: "bg-ink-100 text-ink-700" };
  if (p.kind === "notify") return { icon: Bell, label: "Team note", tint: "bg-ink-100 text-ink-700" };
  if (p.kind === "voucher") return { icon: Gift, label: `Voucher · ${chLabel(p.channel)}`, tint: "bg-sun-100 text-navy-950" };
  const icon = CHANNEL_ICON[p.channel] ?? Mail;
  const tint = p.channel === "outbound_call" ? "bg-teal-50 text-teal-600" : p.channel === "sms" ? "bg-violet-50 text-violet-600" : p.channel === "portal_popup" ? "bg-sun-100 text-navy-950" : "bg-navy-50 text-navy-800";
  return { icon, label: chLabel(p.channel), tint };
}

/** The reason in plain words: "Preisgarantie endet → Erinnerung: Information only via portal popup" stays readable. */
const plainReason = (p: Proposal) => p.reason.replace(/\bvia (\w+)/g, (_, c: string) => `via ${chLabel(c)}`).replace(/_/g, " ");

export function ProposalRow({ p, onOpen, onDecide, busy }: { p: Proposal; onOpen: () => void; onDecide: (approve: boolean) => void; busy?: boolean }) {
  const ic = proposalIcon(p);
  const sales = !!p.offerId && p.offerId !== "P-SV-01";
  return (
    <li className={clsx("group px-4 py-2.5 transition-colors hover:bg-ink-50/60", busy && "opacity-50")}>
      <div className="flex items-start gap-3">
        <span className={clsx("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full", ic.tint)} title={ic.label}>
          <ic.icon size={15} />
        </span>
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
            <span className="font-semibold text-ink-900">{p.customerName}</span>
            <span className="text-[11.5px] text-ink-400">{p.customerId}</span>
            <span className="text-[12px] font-medium text-ink-600">{ic.label}</span>
            {p.kind === "message" && <ToneBadge tone={p.tone} />}
            {sales ? <Badge tint="navy">Offer: {p.productName ?? p.offerId}</Badge> : p.kind === "message" ? <Badge tint="good">Service, no offer</Badge> : null}
            {p.sendAfterDays ? <span className="text-[12px] text-ink-400">sends in {plural(p.sendAfterDays, "day")}</span> : null}
            {p.editedAt && <Badge tint="violet">Edited</Badge>}
          </div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-800">{p.subject || p.body?.split("\n")[0] || p.productName || plainReason(p)}</div>
          <div className="truncate text-[11.5px] text-ink-500">
            {evLabel(p.trigger)} · {fmtDateTime(p.eventAt)} · {plainReason(p)}
          </div>
        </button>
        {p.dclvEur != null && (
          <span className="num shrink-0 pt-1 text-right text-[12.5px]" title="Expected change in customer value">
            <span className={p.dclvEur >= 0 ? "text-good-600" : "text-bad-600"}>{fmtDelta(p.dclvEur)}</span>
          </span>
        )}
        <div className="flex shrink-0 gap-1 pt-0.5">
          <button onClick={onOpen} className="grid h-7 w-7 place-items-center rounded-md border border-ink-200 text-ink-500 hover:bg-white" aria-label="Review and edit" title="Review and edit">
            <Pencil size={13} />
          </button>
          <button onClick={() => onDecide(false)} disabled={busy} className="grid h-7 w-7 place-items-center rounded-md border border-ink-200 text-ink-500 hover:bg-white" aria-label="Reject" title="Reject">
            <X size={14} />
          </button>
          <button onClick={() => onDecide(true)} disabled={busy} className="grid h-7 w-7 place-items-center rounded-md bg-navy-900 text-white hover:bg-navy-800" aria-label="Approve" title="Approve">
            <Check size={14} />
          </button>
        </div>
      </div>
    </li>
  );
}

/** The draft as the customer will get it, per channel. */
/** Your own steps happen now, not on the replayed day: "today 04:12". */
const byYou = (at: string) => {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? `today ${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}` : fmtDateTime(at);
};

export function ProposalPreview({ p, subject, body }: { p: Proposal; subject: string; body: string }) {
  if (p.kind === "task" || p.kind === "notify")
    return (
      <div className="rounded-xl border border-ink-200 bg-white p-4">
        <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-500">
          <ClipboardList size={13} /> {KIND_LABEL[p.kind]}
        </div>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-800">{body || p.reason}</p>
      </div>
    );
  if (p.channel === "sms")
    return (
      <div className="mx-auto w-[300px] rounded-[28px] border-[6px] border-ink-900 bg-[#f4f5f7] px-3 pb-6 pt-4">
        <div className="mb-3 text-center text-[11px] text-ink-500">MAINGAU</div>
        <div className="max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-bl-md bg-white px-3 py-2 text-[13px] leading-snug text-ink-900 shadow-sm">{body}</div>
        <div className="mt-2 text-right text-[10.5px] text-ink-500">
          {body.length} characters · {Math.max(1, Math.ceil(body.length / 153))} SMS
        </div>
      </div>
    );
  if (p.channel === "portal_popup")
    return (
      <div className="relative overflow-hidden rounded-xl border border-ink-200 bg-[#eef1f5] p-6">
        <div className="mb-3 h-2.5 w-28 rounded bg-ink-200" />
        <div className="mb-6 h-2 w-44 rounded bg-ink-200/70" />
        <div className="mx-auto max-w-[340px] rounded-2xl bg-white p-4 shadow-[0_18px_40px_-16px_rgba(16,24,40,0.45)]">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[14px] font-semibold text-ink-950">{subject || "Hinweis"}</div>
            <X size={14} className="shrink-0 text-ink-400" />
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-700">{body}</p>
        </div>
      </div>
    );
  if (p.channel === "outbound_call")
    return (
      <div className="rounded-xl border border-teal-600/20 bg-teal-50/40 p-4">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-teal-600">
          <Phone size={13} /> Call script for the agent
        </div>
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-800">{body}</p>
      </div>
    );
  return (
    <div className="overflow-hidden rounded-xl border border-ink-200 bg-white">
      <div className="border-b border-ink-100 bg-ink-50/70 px-4 py-2.5 text-[12px]">
        <div className="text-ink-500">
          From <span className="text-ink-800">MAINGAU Energie</span> · to <span className="text-ink-800">{p.customerName}</span>
        </div>
        <div className="mt-0.5 text-[13.5px] font-semibold text-ink-950">{subject || "(no subject)"}</div>
      </div>
      <div className="whitespace-pre-wrap px-4 py-3.5 text-[13px] leading-relaxed text-ink-800">{body}</div>
    </div>
  );
}

/** Review, fix and decide one draft. */
export function ReviewSheet({ p, onClose, onChanged }: { p: Proposal | null; onClose: () => void; onChanged: () => void }) {
  const [draft, setDraft] = useState<Proposal | null>(p);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(p);
    setEditing(false);
    setError(null);
    setSubject(p?.subject ?? "");
    setBody(p?.body ?? "");
  }, [p]);

  const save = async (tone?: "du" | "sie") => {
    if (!draft) return;
    setBusy(true);
    try {
      const next = await api.editProposal(draft.id, { subject, body, tone });
      setDraft(next);
      setEditing(false);
      setError(null);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approve: boolean) => {
    if (!draft) return;
    setBusy(true);
    try {
      if (editing) await api.editProposal(draft.id, { subject, body });
      await (approve ? api.approveProposal(draft.id) : api.rejectProposal(draft.id));
      onChanged();
      onClose();
    } catch (e) {
      // 409: consent or an exclusion changed since the draft was made; it was stopped.
      setError(e instanceof ApiError && e.status === 409 ? `Stopped instead: ${e.message}` : (e as Error).message);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const d = draft;
  const ic = d ? proposalIcon(d) : null;
  return (
    <Sheet open={!!p} onClose={onClose} width={560} title={d ? `Review · ${d.customerName}` : "Review"}>
      {d && ic && (
        <div className="space-y-5 p-5 pb-28">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className={clsx("grid h-7 w-7 place-items-center rounded-full", ic.tint)}>
              <ic.icon size={14} />
            </span>
            <span className="font-medium text-ink-900">{ic.label}</span>
            {d.kind === "message" && <ToneBadge tone={d.tone} />}
            <span className="text-ink-400">·</span>
            <Link to={`/customers/${d.customerId}`} className="inline-flex items-center gap-1 text-ink-600 hover:underline">
              {d.customerId} <ExternalLink size={11} />
            </Link>
          </div>

          <section>
            <h4 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-500">Why this draft</h4>
            <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-[12.5px]">
              <dt className="text-ink-500">Started by</dt>
              <dd className="text-ink-800">{d.source.name}</dd>
              <dt className="text-ink-500">Trigger</dt>
              <dd className="text-ink-800">
                {evLabel(d.trigger)} · {fmtDateTime(d.eventAt)}
              </dd>
              <dt className="text-ink-500">Reason</dt>
              <dd className="text-ink-800">{plainReason(d)}</dd>
              {d.productName && (
                <>
                  <dt className="text-ink-500">Offer</dt>
                  <dd className="text-ink-800">
                    {d.productName}
                    {d.dclvEur != null && <span className={clsx("num ml-1.5 font-semibold", d.dclvEur >= 0 ? "text-good-600" : "text-bad-600")}>{fmtDelta(d.dclvEur)} CLV</span>}
                  </dd>
                </>
              )}
            </dl>
          </section>

          <section>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <h4 className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-500">{editing ? "Edit the text" : "As the customer sees it"}</h4>
              {d.status === "pending" && (d.kind === "message" || d.kind === "voucher" || d.kind === "survey") && (
                <div className="flex items-center gap-1.5">
                  {!editing && (
                    <div className="flex rounded-md border border-ink-200 p-0.5 text-[11.5px] font-medium" title="Switch the form of address; the checks run again">
                      {(["sie", "du"] as const).map((t) => (
                        <button key={t} disabled={busy} onClick={() => t !== d.tone && save(t)} className={clsx("rounded px-2 py-0.5", d.tone === t ? "bg-navy-900 text-white" : "text-ink-600 hover:bg-ink-50")}>
                          {t === "du" ? "Du" : "Sie"}
                        </button>
                      ))}
                    </div>
                  )}
                  <Button size="sm" variant={editing ? "primary" : "secondary"} icon={editing ? Check : Pencil} onClick={() => (editing ? save() : setEditing(true))} disabled={busy}>
                    {editing ? "Save and check" : "Edit"}
                  </Button>
                </div>
              )}
            </div>
            {editing ? (
              <div className="space-y-2">
                {d.channel === "email" || d.channel === "portal_popup" ? <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" /> : null}
                <Textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Text" />
                {d.channel === "sms" && <div className={clsx("text-right text-[11.5px]", body.length > 306 ? "text-bad-600" : "text-ink-500")}>{body.length} / 306 characters</div>}
                <p className="text-[11.5px] text-ink-500">Changing the switch from Sie to Du does not rewrite the text: edit it so it matches.</p>
              </div>
            ) : (
              <ProposalPreview p={d} subject={d.subject ?? ""} body={d.body ?? ""} />
            )}
            {/\[(Ihr|Dein) Name\]/.test(d.body ?? "") && !editing && <p className="mt-2 text-[12px] text-warn-600">The text still has a name placeholder: edit it before approving.</p>}
          </section>

          {d.checks && d.checks.length > 0 && (
            <section>
              <h4 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-500">Checks on the edited text</h4>
              <Checks checks={d.checks} />
            </section>
          )}

          <section>
            <h4 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-500">Decision log</h4>
            <ol className="space-y-1 text-[12.5px] text-ink-700">
              <li>
                <span className="num text-ink-500">{fmtDateTime(d.eventAt)}</span> · {evLabel(d.trigger)}: drafted by {d.source.name}
              </li>
              {d.editedAt && (
                <li>
                  <span className="num text-ink-500">{byYou(d.editedAt)}</span> · text changed by you, checks run again
                </li>
              )}
              {d.decidedAt && (
                <li>
                  <span className="num text-ink-500">{byYou(d.decidedAt)}</span> · {d.status} by {d.decidedBy}
                </li>
              )}
              {d.status === "cancelled" && <li className="text-bad-600">Stopped: {d.cancelReason}</li>}
              {d.status === "pending" && <li className="text-ink-500">Consent and exclusions are checked again the moment you approve.</li>}
            </ol>
          </section>

          <ErrorNote error={error} />

          {d.status === "pending" && (
            <div className="sticky bottom-0 -mx-5 flex justify-end gap-2 border-t border-ink-100 bg-white px-5 py-3">
              <Button variant="ghost" icon={X} onClick={() => decide(false)} disabled={busy}>
                Reject
              </Button>
              <Button variant="primary" icon={Check} onClick={() => decide(true)} disabled={busy}>
                {editing ? "Save and approve" : "Approve"}
              </Button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

/** Confirms a bulk approval with what it contains. */
export function ApproveAllDialog({ items, onCancel, onConfirm, busy }: { items: Proposal[]; onCancel: () => void; onConfirm: () => void; busy: boolean }) {
  const byChannel = new Map<string, { icon: LucideIcon; label: string; n: number }>();
  for (const p of items) {
    const ic = proposalIcon(p);
    const k = ic.label;
    byChannel.set(k, { icon: ic.icon, label: k, n: (byChannel.get(k)?.n ?? 0) + 1 });
  }
  const offers = items.filter((p) => p.offerId && p.offerId !== "P-SV-01").length;
  const dclv = items.reduce((s, p) => s + (p.dclvEur ?? 0), 0);
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-ink-950/25 p-6" onClick={onCancel}>
      <div className="w-[440px] max-w-full rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <h3 className="text-[16px] font-semibold text-ink-950">Approve {plural(items.length, "draft")}?</h3>
        <ul className="mt-3 space-y-1.5">
          {[...byChannel.values()].map((c) => (
            <li key={c.label} className="flex items-center gap-2 text-[13px] text-ink-800">
              <c.icon size={15} className="text-ink-500" />
              <span className="flex-1">{c.label}</span>
              <span className="num font-semibold">{c.n}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] text-ink-700">
          {offers ? `${plural(offers, "draft")} contain an offer` : "No offers, only service messages and tasks"}
          {dclv ? ` · expected ${fmtDelta(dclv)} CLV` : ""}. Consent and exclusions are checked again for each one; any that no longer qualify are stopped, not sent.
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={Check} onClick={onConfirm} disabled={busy}>
            Approve {items.length}
          </Button>
        </div>
      </div>
    </div>
  );
}
