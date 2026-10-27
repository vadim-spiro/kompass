// Settings: the rules and building blocks marketing changes without code.
import clsx from "clsx";
import { Check, Lock, Plus, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Command, CommandInput, CustomBlock, Settings, ShowIf, Terms } from "../../../shared/types";
import { api, reportIssue, type ShowIfField } from "../api/client";
import { ShowIfEditor } from "../components/BlockSettings";
import { Badge, Button, ErrorNote, Field, Input, PageBar, Select, Skeleton, Spinner, Tabs, Textarea, Toggle } from "../components/ui";
import { invalidateBlocks, useBlocks } from "../lib/catalog";
import { chLabel } from "../lib/format";
import { emitDataChanged, useAsync } from "../lib/useAsync";
import { InlineConfirm, TemplatesTab } from "./Emails";

type Tab = "terms" | "commands" | "blocks" | "templates" | "voice";
const TABS: Tab[] = ["terms", "commands", "blocks", "templates", "voice"];
const CHANNELS = ["email", "newsletter", "portal_popup", "sms", "outbound_call"];

/** What saving means on each tab: terms and voice wait for Save, commands and blocks save with their form, templates as you edit. */
const SUBTITLE: Record<Tab, string> = {
  terms: "How often and on which channels we may contact customers. Applies when you save.",
  commands: "Actions Kompass can take, as steps in automations. Each command applies once saved.",
  blocks: "Your own smart blocks for emails. Each block applies once saved.",
  templates: "Message layouts for campaigns. Templates save as you edit.",
  voice: "How every text should sound. Applies when you save.",
};

/** The rules come from the insights service, which names some of them by config keys. Marketers get plain words. */
const PLAIN_KEYS: [RegExp, string][] = [
  [/^Disabled offers$/, "Offers switched off"],
  [/\bin DISABLED_OFFERS\b/g, "on the switched-off list"],
  [/\bDISABLED_OFFERS\b/g, "offers switched off"],
  [/\bprofiling_analytics(\s+consent)?\b/gi, "profiling consent"],
  [/\bper clv_method\b/gi, "in the customer value model"],
  [/\bclv_method\b/gi, "how customer value is computed"],
  [/\bconsent_checked\b/gi, "consent checked"],
  [/(?<![A-Za-z])[dΔ]CLV\b/g, "the CLV gain"],
];
function plainPolicy(text: string) {
  let out = text;
  for (const [re, to] of PLAIN_KEYS) out = out.replace(re, to);
  // Any other key (word_word) becomes words.
  out = out.replace(/\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b/g, (k) => k.replace(/_/g, " ").toLowerCase());
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** A "show only if" rule in words: "Has the app: no". */
function ruleText(r: ShowIf, fields: ShowIfField[] = []) {
  const f = fields.find((x) => x.field === r.field);
  const label = f?.label ?? r.field.replace(/_/g, " ");
  if ((f?.kind === "bool" || typeof r.value === "boolean") && (r.op === "is" || r.op === "is_not")) {
    const yes = r.value === true || r.value === "true";
    return `${label}: ${(r.op === "is_not" ? !yes : yes) ? "yes" : "no"}`;
  }
  const ops: Record<string, string> = { is: "is", is_not: "is not", gt: "greater than", lt: "less than", contains: "includes", not_contains: "does not include", exists: "is set", not_exists: "is not set" };
  return `${label} ${ops[r.op] ?? r.op.replace(/_/g, " ")} ${String(r.value ?? "")}`.trim();
}

export function SettingsPage() {
  const [sp, setSp] = useSearchParams();
  const asked = sp.get("tab") as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) ? asked : "terms";
  const setTab = (t: Tab) => setSp({ tab: t }, { replace: true });
  const { data, error, setData } = useAsync(() => api.settings(), [tab]);
  return (
    <>
      <PageBar title="Settings" subtitle={SUBTITLE[tab]} />
      <div className="shrink-0 bg-white px-6 pt-3">
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { value: "terms", label: "Contact terms" },
            { value: "commands", label: "Commands", count: data?.commands.length },
            { value: "blocks", label: "Blocks", count: data?.customBlocks.length },
            { value: "templates", label: "Templates" },
            { value: "voice", label: "Brand voice" },
          ]}
        />
      </div>
      <div className="flex-1 overflow-y-auto page-scroll px-6 py-5 scroll-thin">
        <ErrorNote error={error} />
        {!data && !error && <Skeleton className="h-64" />}
        {data && tab === "terms" && <TermsTab terms={data.terms} onSaved={(terms) => setData({ ...data, terms })} />}
        {data && tab === "commands" && <CommandsTab settings={data} onChange={(commands) => setData({ ...data, commands })} />}
        {data && tab === "blocks" && <BlocksTab settings={data} onChange={(customBlocks) => setData({ ...data, customBlocks })} />}
        {tab === "templates" && <TemplatesTab />}
        {data && tab === "voice" && <VoiceTab settings={data} onSaved={(voice) => setData({ ...data, voice })} />}
      </div>
    </>
  );
}

function useSaver<T>(fn: (v: T) => Promise<unknown>) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const save = async (v: T) => {
    setState("saving");
    setErr(null);
    try {
      await fn(v);
      setState("saved");
      emitDataChanged();
    } catch (e) {
      setErr((e as Error).message);
      setState("error");
    }
  };
  return { state, err, save };
}

/** Sticks to the bottom of a form while something is unsaved ("Unsaved changes · Discard · Save"), then confirms the save for a moment. */
function SaveBar({ dirty, state, error, onSave, onDiscard }: { dirty: boolean; state: "idle" | "saving" | "saved" | "error"; error: string | null; onSave: () => void; onDiscard: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (state !== "saved") return;
    setConfirmed(true);
    const t = setTimeout(() => setConfirmed(false), 2500);
    return () => clearTimeout(t);
  }, [state]);
  const saving = state === "saving";
  const visible = dirty || saving || confirmed || !!error;
  return (
    // The bar keeps its place when hidden, so nothing jumps when it appears. It is only as wide as its content,
    // so it stays clear of the assistant bubble at the bottom right.
    <div className="sticky bottom-4 z-10 flex min-h-[52px]">
      {visible && (
        <div role="status" className="inline-flex max-w-full items-center gap-4 rounded-xl border border-ink-200 bg-white px-4 py-2.5 shadow-[0_10px_30px_-10px_rgba(16,24,40,0.3)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 whitespace-nowrap text-[13px] font-medium text-ink-900">
              {saving ? (
                <>
                  <Spinner /> Saving…
                </>
              ) : dirty ? (
                <>
                  <span className="h-2 w-2 shrink-0 rounded-full bg-warn-600" /> Unsaved changes
                </>
              ) : confirmed && !error ? (
                <>
                  <Check size={14} className="text-good-600" /> Saved
                </>
              ) : null}
            </div>
            {error && <div className="mt-0.5 max-w-[360px] text-[12px] text-bad-600">{error}</div>}
          </div>
          {(dirty || saving) && (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={onDiscard} disabled={saving}>
                Discard
              </Button>
              <Button size="sm" variant="primary" onClick={onSave} disabled={saving}>
                Save
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TermsTab({ terms, onSaved }: { terms: Terms; onSaved: (t: Terms) => void }) {
  const [t, setT] = useState(terms);
  const [policies, setPolicies] = useState<{ rule: string; detail: string }[]>([]);
  useEffect(() => {
    api.insights<{ rule: string; detail: string }[]>("/governance/policies").then(setPolicies, () => undefined);
  }, []);
  // The server rounds and clamps what it stores: show that, so a saved form is not "unsaved" again.
  const { state, err, save } = useSaver(async (v: Terms) => {
    const saved = await api.updateTerms(v);
    onSaved(saved);
    setT(saved);
  });
  const dirty = JSON.stringify(t) !== JSON.stringify(terms);
  return (
    <div className="grid max-w-[1100px] grid-cols-[1fr_380px] gap-6">
      <div className="space-y-5">
        <section className="rounded-xl border border-ink-200 bg-white p-5">
          <h2 className="mb-1 text-[14px] font-semibold text-ink-950">How often we may contact a customer</h2>
          <p className="mb-4 text-[12.5px] text-ink-500">Applied when a campaign is planned and when automations propose messages.</p>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Messages per 30 days" hint="across all channels">
              <Input type="number" min={0} max={20} value={t.contactLimit30d} onChange={(e) => setT({ ...t, contactLimit30d: Number(e.target.value) })} />
            </Field>
            <Field label="Quiet days after a complaint" hint="no marketing at all">
              <Input type="number" min={0} max={90} value={t.quietDaysAfterComplaint} onChange={(e) => setT({ ...t, quietDaysAfterComplaint: Number(e.target.value) })} />
            </Field>
            <Field label="Control group" hint="share held out per campaign">
              <div className="flex items-center gap-1.5">
                <Input type="number" min={5} max={50} value={Math.round(t.holdoutShare * 100)} onChange={(e) => setT({ ...t, holdoutShare: Number(e.target.value) / 100 })} />
                <span className="text-[12.5px] text-ink-500">%</span>
              </div>
            </Field>
          </div>
          <table className="mt-5 w-full text-[13px]">
            <thead className="text-left text-[11.5px] uppercase tracking-wider text-ink-400">
              <tr>
                <th className="pb-1.5 font-medium">Channel</th>
                <th className="pb-1.5 font-medium">Allowed</th>
                <th className="pb-1.5 font-medium">Max per 30 days</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {CHANNELS.map((ch) => (
                <tr key={ch}>
                  <td className="py-2 text-ink-800">{chLabel(ch)}</td>
                  <td className="py-2">
                    <Toggle checked={t.channelsEnabled[ch] !== false} onChange={(v) => setT({ ...t, channelsEnabled: { ...t.channelsEnabled, [ch]: v } })} label={`${chLabel(ch)} allowed`} />
                  </td>
                  <td className="py-2">
                    <Input type="number" min={0} max={10} value={t.channelLimits30d[ch] ?? 0} onChange={(e) => setT({ ...t, channelLimits30d: { ...t.channelLimits30d, [ch]: Number(e.target.value) } })} className="w-20" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="rounded-xl border border-ink-200 bg-white p-5">
          <h2 className="mb-4 text-[14px] font-semibold text-ink-950">Value and approval</h2>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Minimum expected CLV gain per contact" hint="customers below it are left alone">
              <div className="flex items-center gap-1.5">
                <Input type="number" step={1} value={t.minDclvEur} onChange={(e) => setT({ ...t, minDclvEur: Number(e.target.value) })} className="w-24" />
                <span className="text-[12.5px] text-ink-500">€</span>
              </div>
            </Field>
            <label className="flex items-start gap-2.5 pt-5 text-[13px]">
              <Toggle checked={t.requireSecondApprover} onChange={(v) => setT({ ...t, requireSecondApprover: v })} />
              <span>
                <span className="font-medium text-ink-900">Four-eyes rule</span>
                <span className="block text-[12px] text-ink-500">Campaigns need a second approver before launch.</span>
              </span>
            </label>
          </div>
        </section>
        <SaveBar dirty={dirty} state={state} error={err} onSave={() => save(t)} onDiscard={() => setT(terms)} />
      </div>
      <aside className="space-y-4">
        <div className="rounded-xl border border-good-600/20 bg-good-50/60 p-5">
          <div className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold text-ink-950">
            <ShieldCheck size={15} className="text-good-600" /> Always on
          </div>
          <p className="mb-3 text-[12px] text-ink-500">Enforced by the decision engine for every campaign and automation. Your terms add to these.</p>
          <ul className="space-y-2.5">
            {policies.map((p) => {
              const rule = plainPolicy(p.rule);
              const detail = plainPolicy(p.detail);
              return (
                // The service's own wording stays available as a tooltip for whoever knows the keys.
                <li key={p.rule} className="text-[12.5px]" title={rule !== p.rule || detail !== p.detail ? `Technical wording: ${p.rule}. ${p.detail}` : undefined}>
                  <div className="flex items-center gap-1.5 font-medium text-ink-800">
                    <Lock size={11} className="text-ink-400" /> {rule}
                  </div>
                  <div className="text-ink-500">{detail}</div>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>
    </div>
  );
}

const KIND_OPTIONS = [
  { value: "message", label: "Message to the customer" },
  { value: "task", label: "Task for a team" },
  { value: "voucher", label: "Voucher" },
  { value: "survey", label: "Survey" },
  { value: "notify", label: "Internal notification" },
];

function CommandForm({ initial, onSave, onCancel }: { initial?: Command; onSave: (c: CommandInput) => Promise<void>; onCancel: () => void }) {
  const [c, setC] = useState<CommandInput>(initial ?? { name: "", kind: "message", channel: "email", description: "", costEur: 0, needsApproval: true, template: { sie: "", du: "" } });
  const [err, setErr] = useState<string | null>(null);
  const toCustomer = c.kind === "message" || c.kind === "voucher" || c.kind === "survey";
  return (
    <div className="space-y-3 rounded-xl border border-navy-700/30 bg-white p-4">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Name">
          <Input value={c.name ?? ""} onChange={(e) => setC({ ...c, name: e.target.value })} placeholder="e.g. Survey with 5 € voucher" />
        </Field>
        <Field label="What it does">
          <Select value={c.kind ?? "message"} onChange={(e) => setC({ ...c, kind: e.target.value as Command["kind"] })} options={KIND_OPTIONS} />
        </Field>
        <Field label="Channel">
          <Select value={c.channel ?? ""} onChange={(e) => setC({ ...c, channel: e.target.value || null })} options={[{ value: "", label: toCustomer ? "Best consented channel" : "Internal" }, ...CHANNELS.map((x) => ({ value: x, label: chLabel(x) }))]} />
        </Field>
      </div>
      <Field label="Description" hint="Shown in the automation palette and to the assistant.">
        <Input value={c.description ?? ""} onChange={(e) => setC({ ...c, description: e.target.value })} />
      </Field>
      {(c.kind === "message" || c.kind === "task" || c.kind === "notify") && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={toCustomer ? "Text (Sie)" : "Instruction"}>
            <Textarea rows={2} value={c.template?.sie ?? ""} onChange={(e) => setC({ ...c, template: { du: c.template?.du ?? "", sie: e.target.value } })} />
          </Field>
          <Field label={toCustomer ? "Text (Du)" : "Instruction (Du customers)"}>
            <Textarea rows={2} value={c.template?.du ?? ""} onChange={(e) => setC({ ...c, template: { sie: c.template?.sie ?? "", du: e.target.value } })} />
          </Field>
        </div>
      )}
      <div className="flex items-center gap-5">
        <Field label="Cost per use">
          <div className="flex items-center gap-1.5">
            <Input type="number" min={0} step={0.1} value={c.costEur ?? 0} onChange={(e) => setC({ ...c, costEur: Number(e.target.value) })} className="w-24" />
            <span className="text-[12.5px] text-ink-500">€</span>
          </div>
        </Field>
        <label className="flex items-center gap-2 pt-4 text-[13px]">
          <Toggle checked={c.needsApproval ?? true} disabled={toCustomer} onChange={(v) => setC({ ...c, needsApproval: v })} /> Needs approval {toCustomer && <span className="text-[12px] text-ink-400">(always, for anything a customer receives)</span>}
        </label>
      </div>
      <ErrorNote error={err} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={!c.name?.trim()}
          onClick={async () => {
            try {
              await onSave({ ...c, needsApproval: toCustomer ? true : c.needsApproval });
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Save command
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function CommandsTab({ settings, onChange }: { settings: Settings; onChange: (c: Command[]) => void }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const remove = async (cmd: Command) => {
    setErr(null);
    try {
      await api.deleteCommand(cmd.id);
      onChange(settings.commands.filter((x) => x.id !== cmd.id));
    } catch (e) {
      setErr((e as Error).message);
      reportIssue("warn", "settings", `delete command ${cmd.id} failed`, { error: String(e) });
    }
  };
  return (
    <div className="max-w-[900px] space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[13px] text-ink-500">Commands are the actions Kompass can take. Each one becomes a step you can drag into an automation, and the assistant can use it too.</p>
        <Button variant="primary" icon={Plus} onClick={() => setEditing("new")} disabled={editing === "new"}>
          New command
        </Button>
      </div>
      <ErrorNote error={err} />
      {editing === "new" && (
        <CommandForm
          onCancel={() => setEditing(null)}
          onSave={async (c) => {
            const created = await api.addCommand(c);
            onChange([...settings.commands, created]);
            setEditing(null);
            emitDataChanged();
          }}
        />
      )}
      <div className="divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white">
        {settings.commands.map((cmd) =>
          editing === cmd.id ? (
            <div key={cmd.id} className="p-3">
              <CommandForm
                initial={cmd}
                onCancel={() => setEditing(null)}
                onSave={async (c) => {
                  const updated = await api.updateCommand(cmd.id, c);
                  onChange(settings.commands.map((x) => (x.id === cmd.id ? updated : x)));
                  setEditing(null);
                }}
              />
            </div>
          ) : (
            <div key={cmd.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink-900">
                  {cmd.name}
                  {cmd.builtIn && <Badge tint="neutral">built in</Badge>}
                </div>
                <div className="truncate text-[12.5px] text-ink-500">{cmd.description}</div>
              </div>
              <Badge tint="navy">{KIND_OPTIONS.find((k) => k.value === cmd.kind)?.label}</Badge>
              <span className="w-28 text-right text-[12.5px] text-ink-500">{cmd.channel ? chLabel(cmd.channel) : "–"}</span>
              <span className="num w-16 text-right text-[12.5px] text-ink-500">{cmd.costEur ? `${cmd.costEur} €` : ""}</span>
              <Button size="sm" variant="ghost" onClick={() => setEditing(cmd.id)}>
                Edit
              </Button>
              {!cmd.builtIn && (
                <InlineConfirm
                  onConfirm={() => remove(cmd)}
                  render={(ask) => (
                    <button onClick={ask} className="rounded p-1 text-ink-400 hover:bg-bad-50 hover:text-bad-600" aria-label={`Delete ${cmd.name}`}>
                      <Trash2 size={14} />
                    </button>
                  )}
                />
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function BlockForm({ initial, onSave, onCancel }: { initial?: CustomBlock; onSave: (b: Omit<CustomBlock, "id">) => Promise<void>; onCancel: () => void }) {
  const catalog = useBlocks();
  const [b, setB] = useState<Omit<CustomBlock, "id">>(initial ?? { name: "", description: "", sie: "", du: "", showIf: [] });
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-3 rounded-xl border border-navy-700/30 bg-white p-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} placeholder="e.g. App tip" />
        </Field>
        <Field label="Description">
          <Input value={b.description} onChange={(e) => setB({ ...b, description: e.target.value })} placeholder="When marketers should use it" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Text (Sie)">
          <Textarea rows={3} value={b.sie} onChange={(e) => setB({ ...b, sie: e.target.value })} />
        </Field>
        <Field label="Text (Du)">
          <Textarea rows={3} value={b.du} onChange={(e) => setB({ ...b, du: e.target.value })} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-1 text-[11.5px] text-ink-500">
        Placeholders:
        {catalog?.placeholders.map((p) => (
          <code key={p} className="rounded bg-ink-100 px-1">{`{{${p}}}`}</code>
        ))}
      </div>
      {catalog && <ShowIfEditor rules={b.showIf} fields={catalog.fields} onChange={(showIf) => setB({ ...b, showIf })} />}
      <ErrorNote error={err} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={!b.name.trim() || !(b.sie.trim() || b.du.trim())}
          onClick={async () => {
            try {
              await onSave(b);
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Save block
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function BlocksTab({ settings, onChange }: { settings: Settings; onChange: (b: CustomBlock[]) => void }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const catalog = useBlocks();
  const done = () => {
    invalidateBlocks();
    setEditing(null);
  };
  const remove = async (blk: CustomBlock) => {
    setErr(null);
    try {
      await api.deleteBlock(blk.id);
      onChange(settings.customBlocks.filter((x) => x.id !== blk.id));
      invalidateBlocks();
    } catch (e) {
      setErr((e as Error).message);
      reportIssue("warn", "settings", `delete block ${blk.id} failed`, { error: String(e) });
    }
  };
  return (
    <div className="max-w-[900px] space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[13px] text-ink-500">Your own smart blocks: text with placeholders that is shown only to the customers your rules match. They appear under “Your blocks” in the email builder.</p>
        <Button variant="primary" icon={Plus} onClick={() => setEditing("new")} disabled={editing === "new"}>
          New block
        </Button>
      </div>
      <ErrorNote error={err} />
      {editing === "new" && (
        <BlockForm
          onCancel={() => setEditing(null)}
          onSave={async (b) => {
            onChange([...settings.customBlocks, await api.addBlock(b)]);
            done();
          }}
        />
      )}
      {settings.customBlocks.map((blk) =>
        editing === blk.id ? (
          <BlockForm
            key={blk.id}
            initial={blk}
            onCancel={() => setEditing(null)}
            onSave={async (b) => {
              const updated = await api.updateBlock(blk.id, b);
              onChange(settings.customBlocks.map((x) => (x.id === blk.id ? updated : x)));
              done();
            }}
          />
        ) : (
          <div key={blk.id} className="rounded-xl border border-ink-200 bg-white p-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium text-ink-900">{blk.name}</div>
                <div className="text-[12.5px] text-ink-500">{blk.description}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEditing(blk.id)}>
                Edit
              </Button>
              <InlineConfirm
                onConfirm={() => remove(blk)}
                render={(ask) => (
                  <button onClick={ask} className="rounded p-1 text-ink-400 hover:bg-bad-50 hover:text-bad-600" aria-label={`Delete ${blk.name}`}>
                    <Trash2 size={14} />
                  </button>
                )}
              />
            </div>
            <div className="mt-2 rounded-lg bg-ink-50 px-3 py-2 text-[12.5px] text-ink-700">{blk.sie}</div>
            {blk.showIf.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {blk.showIf.map((r, i) => (
                  <Badge key={i} tint="teal">
                    {ruleText(r, catalog?.fields)}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}

function VoiceTab({ settings, onSaved }: { settings: Settings; onSaved: (v: Settings["voice"]) => void }) {
  const [v, setV] = useState(settings.voice);
  const [words, setWords] = useState(settings.voice.avoidWords.join(", "));
  const current = { ...v, avoidWords: words.split(",").map((w) => w.trim()).filter(Boolean) };
  const dirty = JSON.stringify(current) !== JSON.stringify(settings.voice);
  const { state, err, save } = useSaver(async (x: Settings["voice"]) => {
    const saved = await api.updateVoice(x);
    onSaved(saved);
    setV(saved);
    setWords(saved.avoidWords.join(", "));
  });
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const reset = async () => {
    setResetting(true);
    setResetError(null);
    try {
      await api.resetWorkspace();
      invalidateBlocks();
      location.reload();
    } catch (e) {
      setResetError((e as Error).message);
      reportIssue("error", "settings", "workspace reset failed", { error: String(e) });
      setResetting(false);
    }
  };
  return (
    <div className="max-w-[760px] space-y-5">
      <section className="space-y-4 rounded-xl border border-ink-200 bg-white p-5">
        <Field label="Never use these words" hint="Comma-separated. Checked in every text block and AI paragraph.">
          <Input value={words} onChange={(e) => setWords(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Sign-off (Sie)">
            <Textarea rows={2} value={v.signOff.sie} onChange={(e) => setV({ ...v, signOff: { ...v.signOff, sie: e.target.value } })} />
          </Field>
          <Field label="Sign-off (Du)">
            <Textarea rows={2} value={v.signOff.du} onChange={(e) => setV({ ...v, signOff: { ...v.signOff, du: e.target.value } })} />
          </Field>
        </div>
        <Field label="Notes for the AI writer" hint="e.g. regional, warm, no exclamation marks">
          <Textarea rows={3} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
        </Field>
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={!dirty || state === "saving"} onClick={() => save(current)}>
            Save voice
          </Button>
          {dirty && (
            <>
              <span className="text-[12.5px] text-warn-600">Unsaved changes</span>
              <Button
                variant="ghost"
                onClick={() => {
                  setV(settings.voice);
                  setWords(settings.voice.avoidWords.join(", "));
                }}
              >
                Discard
              </Button>
            </>
          )}
          {state === "saved" && !dirty && <span className="text-[12.5px] text-good-600">Saved</span>}
          <ErrorNote error={err} />
        </div>
      </section>
      <section className={clsx("rounded-xl border border-ink-200 bg-white p-5")}>
        <h2 className="text-[13.5px] font-semibold text-ink-950">Demo workspace</h2>
        <p className="mb-3 mt-0.5 text-[12.5px] text-ink-500">Resets campaigns, emails, automations, settings and conversations to the starting state.</p>
        <ErrorNote error={resetError} className="mb-3" />
        <InlineConfirm
          question="Reset the whole workspace?"
          yes="Yes, reset"
          no="Cancel"
          onConfirm={reset}
          render={(ask) => (
            <Button variant="danger" size="sm" icon={RotateCcw} disabled={resetting} onClick={ask}>
              Reset workspace
            </Button>
          )}
        />
      </section>
    </div>
  );
}
