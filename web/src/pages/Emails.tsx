// Message templates (Settings → Templates): reusable block layouts that a campaign can start from,
// edited in the drag-and-drop builder.
import { ArrowLeft, Check, Copy, Mail, Megaphone, Plus, SearchX, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import type { Audience, EmailDoc } from "../../../shared/types";
import { api, reportIssue, type Template } from "../api/client";
import { EmailBuilder } from "../components/EmailBuilder";
import { Badge, Button, Empty, ErrorNote, PageBar, Select, Skeleton } from "../components/ui";
import { useBlocks, useVocabulary } from "../lib/catalog";
import { fmtAgo, humanize } from "../lib/format";
import { useAsync } from "../lib/useAsync";

export const templatePath = (id: string) => `/settings/templates/${id}`;

/** Old /emails/:id links open the template in Settings. */
export function LegacyEmailRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={templatePath(id)} replace />;
}

// ---------- Small pieces shared with Settings and the automation editor ----------

/** "Delete? Yes / No" in place of a browser dialog. `render` draws the normal button and calls `ask` when it is clicked. */
export function InlineConfirm({
  onConfirm,
  render,
  question = "Delete?",
  yes = "Yes",
  no = "No",
}: {
  onConfirm: () => void | Promise<void>;
  render: (ask: () => void) => ReactNode;
  question?: string;
  yes?: string;
  no?: string;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) return <>{render(() => setAsking(true))}</>;
  const proceed = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };
  return (
    <span role="group" aria-label={question} onKeyDown={(e) => e.key === "Escape" && setAsking(false)} className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="text-[12.5px] font-medium text-bad-600">{question}</span>
      <button type="button" onClick={proceed} disabled={busy} className="rounded-md bg-bad-600 px-2 py-0.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50">
        {yes}
      </button>
      {/* The safe answer has the focus, so a stray Enter cancels. */}
      <button type="button" autoFocus onClick={() => setAsking(false)} disabled={busy} className="rounded-md px-2 py-0.5 text-[12px] font-medium text-ink-600 hover:bg-ink-100">
        {no}
      </button>
    </span>
  );
}

/** A page for a link that points at something that no longer exists ("Template not found"), with the way back. */
export function NotFound({ what, backTo, backLabel }: { what: string; backTo: string; backLabel: string }) {
  return (
    <>
      <PageBar
        title={
          <span className="flex items-center gap-2">
            <Link to={backTo} className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700" aria-label={backLabel}>
              <ArrowLeft size={16} />
            </Link>
            {what}
          </span>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center pb-24">
        <Empty icon={SearchX} title={`${what} not found`} hint="It may have been deleted, or the link is out of date." />
        <Link to={backTo} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3.5 text-sm font-medium text-ink-900 hover:bg-ink-50">
          <ArrowLeft size={15} /> {backLabel}
        </Link>
      </div>
    </>
  );
}

const starter = (): EmailDoc => ({
  subject: { sie: "Etwas, das zu Ihnen passt", du: "Etwas, das zu dir passt" },
  blocks: [
    { id: `b-${Date.now()}1`, type: "greeting", props: {} },
    { id: `b-${Date.now()}2`, type: "footer", props: {} },
  ],
});

export function TemplatesTab() {
  const nav = useNavigate();
  const { data, error, loading, reload } = useAsync(() => api.templates(), []);
  const catalog = useBlocks();
  const [actionError, setActionError] = useState<string | null>(null);
  const label = (t: string) => catalog?.blocks.find((b) => b.type === t)?.label ?? (t === "ai_text" ? "Text" : humanize(t.replace(/^custom:/, "")));

  const create = async () => {
    const t = await api.createTemplate({ name: "New template", email: starter() });
    nav(templatePath(t.id));
  };
  const duplicate = async (t: Template) => {
    await api.createTemplate({ name: `${t.name} (copy)`, description: t.description, email: t.email });
    reload();
  };
  const remove = async (t: Template) => {
    setActionError(null);
    try {
      await api.deleteTemplate(t.id);
      reload();
    } catch (e) {
      setActionError((e as Error).message);
      reportIssue("warn", "templates", `delete ${t.id} failed`, { error: String(e) });
    }
  };

  return (
    <div className="max-w-[1100px] space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-[640px] text-[13px] text-ink-500">
          Layouts of smart blocks that a campaign can start from (step 2, “Start from”). Each customer still gets their own version. Messages to a single customer are written from their page in Customers and wait for approval.
        </p>
        <Button variant="primary" icon={Plus} onClick={create}>
          New template
        </Button>
      </div>
      <div>
        <ErrorNote error={error ?? actionError} className="mb-3" />
        {loading && !data && <Skeleton className="h-40" />}
        {data?.length === 0 && <Empty icon={Mail} title="No templates yet" hint="Create one and drop in smart blocks." />}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {data?.map((t) => (
            <div key={t.id} className="group flex flex-col rounded-xl border border-ink-200 bg-white p-4 hover:border-navy-700/40">
              <Link to={templatePath(t.id)} className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-ink-950">{t.name}</div>
                <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-500">{t.description || t.email.subject.sie}</div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {t.email.blocks
                    .filter((b) => b.type !== "footer")
                    .map((b) => (
                      <Badge key={b.id} tint={["greeting", "last_contact", "service_status", "offer", "savings", "usage", "guarantee", "article", "survey", "ai_text"].includes(b.type) ? "navy" : "neutral"}>
                        {label(b.type)}
                      </Badge>
                    ))}
                </div>
              </Link>
              <div className="mt-3 flex items-center gap-1 border-t border-ink-100 pt-2.5 text-[12px] text-ink-400">
                <span className="flex-1">Edited {fmtAgo(t.updatedAt)}</span>
                <button onClick={() => duplicate(t)} className="rounded p-1 hover:bg-ink-100 hover:text-ink-700" aria-label="Duplicate">
                  <Copy size={14} />
                </button>
                <InlineConfirm
                  onConfirm={() => remove(t)}
                  render={(ask) => (
                    <button onClick={ask} className="rounded p-1 hover:bg-bad-50 hover:text-bad-600" aria-label={`Delete ${t.name}`}>
                      <Trash2 size={14} />
                    </button>
                  )}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function TemplateEditorPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const vocab = useVocabulary();
  const [tpl, setTpl] = useState<Template | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const [segment, setSegment] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setTpl(null);
    setMissing(false);
    api.templates().then(
      (all) => {
        const found = all.find((t) => t.id === id) ?? null;
        setTpl(found);
        setMissing(!found);
      },
      (e) => setError(e.message),
    );
  }, [id]);

  const update = (patch: Partial<Template>) => {
    if (!tpl) return;
    const next = { ...tpl, ...patch };
    setTpl(next);
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.updateTemplate(id, { name: next.name, description: next.description, email: next.email }).then(
        () => setSaved(true),
        (e) => setError(e.message),
      );
    }, 600);
  };

  const useInCampaign = async () => {
    if (!tpl) return;
    const c = await api.createCampaign({ name: tpl.name, goal: tpl.description, templateId: tpl.id, audience: segment ? { segments: [segment] } : {} });
    nav(`/campaigns/${c.id}?step=who`);
  };

  const audience: Audience = segment ? { segments: [segment] } : {};

  if (missing) return <NotFound what="Template" backTo="/settings?tab=templates" backLabel="Back to Settings → Templates" />;

  return (
    <>
      <PageBar
        title={
          <span className="flex items-center gap-2">
            <Link to="/settings?tab=templates" className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700" aria-label="Back to templates">
              <ArrowLeft size={16} />
            </Link>
            {tpl ? (
              <input value={tpl.name} onChange={(e) => update({ name: e.target.value })} style={{ width: `${Math.max(10, tpl.name.length + 2)}ch` }} className="no-drag min-w-0 max-w-[520px] rounded px-1 font-semibold hover:bg-ink-100 focus:bg-white focus:outline-none focus:ring-2 focus:ring-navy-100" />
            ) : (
              "Template"
            )}
          </span>
        }
        actions={
          <>
            <span className="flex items-center gap-1 text-[12px] text-ink-400">{saved ? <><Check size={13} /> Saved</> : "Saving…"}</span>
            <Select
              value={segment}
              onChange={(e) => setSegment(e.target.value)}
              className="w-56"
              options={[{ value: "", label: "Preview: customers most at risk" }, ...(vocab?.segments ?? []).map((s) => ({ value: s.key, label: `Preview: ${s.key.replace(/_/g, " ")}` }))]}
            />
            <Button variant="primary" icon={Megaphone} onClick={useInCampaign} disabled={!tpl}>
              Use in campaign
            </Button>
          </>
        }
      />
      <ErrorNote error={error} className="m-4" />
      <div className="min-h-0 flex-1">
        {tpl ? <EmailBuilder email={tpl.email} onChange={(email) => update({ email })} audience={audience} /> : !error && <Skeleton className="m-6 h-96" />}
      </div>
    </>
  );
}
