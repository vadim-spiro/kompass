// The Kompass bubble: the one place to ask or tell Kompass anything. It sees what the page reports
// (screen snapshot), carries out UI actions where the user can watch, and streams its answer.
import clsx from "clsx";
import { ArrowUp, Eye, GripVertical, History, MessageSquare, Minus, PanelRightOpen, Plus, Sparkles, Square, Trash2, X, XCircle } from "lucide-react";
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ChatContext, ChatMessage, ChatToolCall, Conversation } from "../../../../shared/types";
import { UI_ACTIONS, type ScreenSnapshot, type UiResult } from "../../../../shared/uiActions";
import { api, reportIssue, sendChat, type ConversationMeta } from "../../api/client";
import { ASK_EVENT } from "../../lib/ask";
import { fmtAgo } from "../../lib/format";
import { screenStore, settle, useScreenSnapshot } from "../../lib/screen";
import { emitDataChanged } from "../../lib/useAsync";
import { AnimatePresence, EASE, motion } from "../motion";
import { ActivityCard, type LiveCall } from "./ActivityCard";
import { cursor, GhostCursorLayer } from "./GhostCursor";
import { linkIds, Markdown, StepsDisclosure, targetFor, ToolResults } from "./ResultCards";

const LAST_KEY = "kompass.conversation";
const readLast = () => {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
};
const writeLast = (id: string | null) => {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    /* private window: the conversation still lives on the server */
  }
};

const ROUTE_TITLES: Record<string, string> = { home: "Home", campaigns: "Campaigns", automations: "Automations", customers: "Customers", analytics: "Analytics", settings: "Settings", live: "Live stream", service: "Service desk" };

// Where the bubble sits (distance from the right and bottom edge) and whether the side panel is open.
const POS_KEY = "kompass.bubblePos";
const DOCK_KEY = "kompass.dock";
const RAIL = 60;
const PILL_W = 440;
type Pos = { r: number; b: number };
const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* only a convenience */
  }
};
const clampPos = (p: Pos, w: number, h: number): Pos => ({
  r: Math.round(Math.min(Math.max(12, p.r), Math.max(12, window.innerWidth - RAIL - w - 12))),
  b: Math.round(Math.min(Math.max(12, p.b), Math.max(12, window.innerHeight - h - 12))),
});

function contextFor(path: string, screen: ScreenSnapshot | undefined): ChatContext {
  const m = (re: RegExp) => path.match(re)?.[1];
  const view = path.split("/")[1] || "home";
  return {
    view,
    customerId: m(/\/customers\/(MG-\d+)/),
    campaignId: m(/\/campaigns\/([\w-]+)/),
    automationId: m(/\/automations\/([\w-]+)/),
    screen: screen ? { view: screen.view, title: screen.title, data: screen.data } : undefined,
  };
}

function suggestionsFor(ctx: ChatContext): string[] {
  const s = ctx.screen;
  if (s?.view === "campaign") {
    const step = Number((s.data as { step?: number } | undefined)?.step ?? 1);
    if (step === 1) return ["Only customers who are not upset", "Send at each customer's best time", "Who is excluded, and why?"];
    if (step === 2) return ["Write the email and the SMS in both tones", "Make the subject line warmer", "Show it as a Sie customer with an open issue"];
    return ["Is anything risky about this campaign?", "What do we expect to gain?"];
  }
  // The chart builder says builder: true; the board of saved charts has no chart open to change.
  if (s?.view === "analytics")
    return (s.data as { builder?: boolean } | undefined)?.builder
      ? ["Split it by channel", "Best hour to reach customers by channel", "Du or Sie: which converts better in retention?"]
      : ["Best hour to reach customers by channel", "Du or Sie: which converts better in retention?", "Which channel works better than the control group?"];
  if (s?.view === "customers") return ["Only customers with an open problem, highest value at risk first", "Customers whose price guarantee ends soon"];
  if (s?.view === "customer") return ["What should we do for this customer, and why?", "Write this customer a short SMS about their open issue"];
  if (ctx.view === "automations") return ["Build an automation: failed charging three times → service fix and refund", "Which automation produced the most hits today?"];
  if (ctx.view === "live") return ["What changed for MG-100003 after the consent withdrawal?", "Which events arrived late today, and what did Kompass do?"];
  if (ctx.view === "service") return ["Summarise this customer for me before I call back", "What should I offer, and what not, and why?"];
  if (ctx.view === "settings") return ["Add a command “Survey with €5 voucher”", "Raise the quiet period after a complaint to 21 days"];
  return [
    "Offer a home wallbox to EV drivers without one, by email and portal pop-up, at each customer's best time",
    "Which channel works better than the control group?",
    "Who is about to leave, and what should we do?",
  ];
}

function placeholderFor(ctx: ChatContext) {
  switch (ctx.screen?.view ?? ctx.view) {
    case "campaign":
      return "What should change in this campaign?";
    case "analytics":
      return (ctx.screen?.data as { builder?: boolean } | undefined)?.builder ? "Ask about the data, or change the chart…" : "Ask about the data, or build a chart…";
    case "customer":
      return "Ask about this customer, or draft a message…";
    case "customers":
      return "Find customers, e.g. “upset EV drivers”…";
    default:
      return "Ask Kompass or tell it what to do…";
  }
}

/** Follow-up chips after an answer, based on what was just done. */
function nextSteps(m: ChatMessage, ctx: ChatContext, asked?: string): string[] {
  const names = new Set((m.toolCalls ?? []).map((c) => c.name));
  if (names.has("draft_channel") || (m.toolCalls ?? []).some((c) => c.name === "go_to_step" && Number(c.args.step) === 3)) {
    const sms = (m.toolCalls ?? []).some((c) => c.name === "draft_channel" && c.args.channel === "sms");
    return ["Is anything risky about this campaign?", sms ? "Make the SMS shorter" : "Who was left out, and why?"];
  }
  if (names.has("set_chart") || names.has("propose_chart") || names.has("add_field")) return ["Split it by tone", "Show it as a table"];
  if (names.has("find_customers") || names.has("set_filters")) return ["Make these customers a campaign", "Show this on a chart"];
  if (names.has("draft_message")) return ["Make it shorter", "What else should we do for this customer?"];
  if (names.has("plan_campaign")) return ["Build this campaign for me"];
  if (names.has("live_stream")) return ["Which events arrived late today, and what did Kompass do?", "Who is waiting on the service desk?"].filter((s) => s !== asked);
  return suggestionsFor(ctx)
    .filter((s) => s !== asked)
    .slice(0, 2);
}

type Dock = false | "chat" | "history";

export function Bubble() {
  const nav = useNavigate();
  const location = useLocation();
  const snapshot = useScreenSnapshot();
  const context = contextFor(location.pathname, snapshot);
  const contextRef = useRef(context);
  contextRef.current = context;

  const [list, setList] = useState<ConversationMeta[]>([]);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [card, setCard] = useState(false);
  const [dock, setDockState] = useState<Dock>(() => readJson<Dock>(DOCK_KEY, false));
  const [minimized, setMinimized] = useState(false);
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState("");
  const [live, setLive] = useState<LiveCall[]>([]);
  const [stream, setStream] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<Pos>(() => readJson<Pos>(POS_KEY, { r: 24, b: 20 }));
  const [pillH, setPillH] = useState(62);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; start: Pos } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const setDock = useCallback((d: Dock) => {
    setDockState(d);
    writeJson(DOCK_KEY, d);
    if (d) setCard(false);
  }, []);

  const refreshList = useCallback(() => api.conversations().then(setList).catch(() => undefined), []);
  useEffect(() => {
    void refreshList();
    const last = readLast();
    if (last) api.conversation(last).then(setConv, () => writeLast(null));
  }, [refreshList]);

  // Keep the bubble on screen when the window changes size.
  useEffect(() => {
    const fit = () => setPos((p) => clampPos(p, pill.current?.offsetWidth ?? PILL_W, pill.current?.offsetHeight ?? 62));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // The cursor starts and ends at the bubble (or the side panel's input).
  useLayoutEffect(() => {
    const r = (dock ? input.current : pill.current)?.getBoundingClientRect();
    if (r) cursor.setOrigin(r.left + 28, r.top + r.height / 2);
    if (pill.current) setPillH(pill.current.offsetHeight);
  }, [minimized, dock, pos, text]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [conv?.messages.length, stream, dock, card, live.length]);

  const onGrab = (e: React.PointerEvent) => {
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointers cannot be captured; dragging still works while over the handle */
    }
    drag.current = { x: e.clientX, y: e.clientY, start: pos };
    setDragging(true);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPos(clampPos({ r: d.start.r - (e.clientX - d.x), b: d.start.b - (e.clientY - d.y) }, pill.current?.offsetWidth ?? PILL_W, pill.current?.offsetHeight ?? 62));
  };
  const onDrop = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    setPos((p) => {
      writeJson(POS_KEY, p);
      return p;
    });
  };

  // ---------- UI actions ----------

  const navigateTo = useCallback(
    async (args: Record<string, unknown>) => {
      const id = args.id ? String(args.id) : "";
      let path = "/";
      let view: string | null = null;
      switch (args.to) {
        case "new_campaign": {
          const c = await api.createCampaign({ name: String(args.name || "New campaign") });
          emitDataChanged();
          path = `/campaigns/${c.id}`;
          view = "campaign";
          break;
        }
        case "campaign":
          path = `/campaigns/${id}`;
          view = "campaign";
          break;
        case "campaigns":
          path = "/campaigns";
          break;
        case "automations":
          path = "/automations";
          break;
        case "automation":
          path = `/automations/${id}`;
          break;
        case "customers":
          path = "/customers";
          view = "customers";
          break;
        case "customer":
          path = `/customers/${id}`;
          view = "customer";
          break;
        case "analytics":
          path = "/analytics";
          break;
        case "new_chart":
          path = "/analytics/new";
          view = "analytics";
          break;
        case "chart":
          path = `/analytics/${id}`;
          view = "analytics";
          break;
        case "settings":
          path = "/settings";
          break;
        case "templates":
          path = "/settings?tab=templates";
          break;
        case "live":
          path = "/live";
          break;
        case "service":
          path = "/service";
          break;
      }
      // Kompass clicks the page in the sidebar, so you can see where it goes.
      const rail = `nav:${path === "/" ? "/" : `/${path.split(/[/?]/)[1]}`}`;
      await cursor.pointAt(rail);
      cursor.glow(rail);
      nav(path);
      if (view) await screenStore.waitFor(view, 6000);
      await settle(350);
      const s = screenStore.snapshot();
      return `Opened ${s?.title ?? path}`;
    },
    [nav],
  );

  const runUi = useCallback(
    async (call: { id: string; name: string; args: Record<string, unknown> }) => {
      const def = UI_ACTIONS.find((d) => d.name === call.name);
      let res: UiResult;
      try {
        let message: string | void;
        if (call.name === "navigate") message = await navigateTo(call.args);
        else {
          if (!def) throw new Error(`Unknown action ${call.name}`);
          const reg = await screenStore.waitFor(def.view, 4000, call.name);
          const h = reg?.actions[call.name];
          if (!reg || !h) throw new Error(`That only works on the ${def.view} screen. Use navigate first.`);
          if (h.prepare) {
            await h.prepare(call.args);
            await settle(200);
          }
          const target = h.target?.(call.args);
          if (target) await cursor.pointAt(target);
          message = await h.run(call.args);
          await settle(320);
          const after = h.target?.(call.args) ?? target;
          if (after) cursor.glow(after);
        }
        res = { ok: true, message: message || "Done.", screen: screenStore.snapshot() };
      } catch (e) {
        res = { ok: false, message: (e as Error).message, screen: screenStore.snapshot() };
        reportIssue("warn", "bubble", `UI action ${call.name} failed`, { args: call.args, error: (e as Error).message, page: location.pathname });
      }
      await api.uiResult(call.id, res).catch(() => undefined);
    },
    [navigateTo, location.pathname],
  );

  // ---------- Sending ----------

  const send = useCallback(
    async (raw: string, fresh = false) => {
      const msg = raw.trim();
      if (!msg || busy) return;
      setError(null);
      setText("");
      setMinimized(false);
      setBusy(true);
      setRequest(msg);
      setStream("");
      setLive([]);
      setCard(false);
      if (dock === "history") setDock("chat");
      input.current?.blur();
      let c = fresh ? null : conv;
      let uiChain = Promise.resolve();
      try {
        if (!c) {
          c = await api.createConversation();
          writeLast(c.id);
        }
        const id = c.id;
        setConv({ ...c, messages: [...c.messages, { id: "pending", role: "user", content: msg, createdAt: new Date().toISOString() }] });
        abort.current = new AbortController();
        await sendChat(
          id,
          msg,
          contextRef.current,
          (e) => {
            if (e.type === "user") setConv((cv) => cv && { ...cv, messages: cv.messages.map((m) => (m.id === "pending" ? e.message : m)) });
            else if (e.type === "step")
              setLive((calls) => {
                const next = { ...e.call, running: e.phase === "start" };
                const at = calls.findIndex((x) => x.id === e.call.id);
                if (at < 0) return [...calls, next];
                const copy = calls.slice();
                copy[at] = next;
                return copy;
              });
            else if (e.type === "ui") uiChain = uiChain.then(() => runUi(e.call));
            else if (e.type === "delta") {
              setStream((s) => s + e.text);
              setCard(true);
            } else if (e.type === "delta_reset") setStream("");
            else if (e.type === "message") {
              setConv((cv) => cv && { ...cv, messages: [...cv.messages, e.message] });
              setStream("");
              setCard(true);
            } else if (e.type === "error") {
              setError(e.error);
              reportIssue("warn", "bubble", `assistant error: ${e.error}`, { page: location.pathname });
            }
          },
          abort.current.signal,
        );
        await uiChain;
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setError((e as Error).message);
          reportIssue("error", "bubble", `send failed: ${(e as Error).message}`, { page: location.pathname });
        }
        setCard(true);
      } finally {
        setBusy(false);
        setLive([]);
        abort.current = null;
        void cursor.park();
        if (c) api.conversation(c.id).then(setConv, () => undefined);
        void refreshList();
        emitDataChanged();
      }
    },
    [busy, conv, refreshList, runUi, dock, setDock, location.pathname],
  );

  // Other screens hand Kompass a prepared request (always a fresh conversation).
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const onAsk = (e: Event) => void sendRef.current((e as CustomEvent<string>).detail, true);
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMinimized(false);
        setTimeout(() => input.current?.focus(), 30);
      } else if (e.key === "Escape" && (card || document.activeElement === input.current)) {
        setCard(false);
        input.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card]);

  const newConversation = () => {
    abort.current?.abort();
    setConv(null);
    writeLast(null);
    setError(null);
    setCard(false);
    if (dock) setDock("chat");
    setTimeout(() => input.current?.focus(), 30);
  };
  const openConversation = async (id: string) => {
    setConv(await api.conversation(id));
    writeLast(id);
    setDock("chat");
  };
  const removeConversation = async (id: string) => {
    await api.deleteConversation(id);
    if (conv?.id === id) newConversation();
    void refreshList();
  };

  const act = async (call: ChatToolCall, action: "apply" | "discard") => {
    if (!conv) return;
    try {
      const p = await api.proposalAction(conv.id, call.id, action);
      setConv((cv) => cv && { ...cv, messages: cv.messages.map((m) => ({ ...m, toolCalls: m.toolCalls?.map((t) => (t.id === call.id ? { ...t, proposal: p } : t)) })) });
      if (action === "apply") {
        emitDataChanged();
        const to = targetFor(p);
        if (to) nav(to);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const messages = conv?.messages ?? [];
  const lastAnswer = [...messages].reverse().find((m) => m.role === "assistant");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const sees = snapshot?.title ?? ROUTE_TITLES[context.view ?? "home"] ?? "This screen";
  const showSuggestions = focused && !busy && !text;

  const composer = (
    <Composer
      ref={input}
      text={text}
      setText={setText}
      busy={busy}
      sees={sees}
      placeholder={busy ? "Kompass is working…" : placeholderFor(context)}
      onSend={() => send(text)}
      onStop={() => abort.current?.abort()}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    />
  );

  const suggestions = (
    <div className="flex flex-wrap justify-end gap-1.5">
      {suggestionsFor(context).map((s, i) => (
        <motion.button
          key={s}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => send(s)}
          className="rounded-full border border-ink-200/80 bg-white px-3 py-1.5 text-left text-[12.5px] text-ink-700 shadow-[0_4px_14px_-6px_rgba(30,20,80,0.25)] hover:border-violet-600/40 hover:text-violet-600"
        >
          {s}
        </motion.button>
      ))}
    </div>
  );

  // ---------- Side panel ----------

  const panel = (
    <AnimatePresence initial={false}>
      {dock && (
        <motion.aside
          key="dock"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 400, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.28, ease: EASE }}
          className="relative z-30 h-full shrink-0 overflow-hidden border-l border-ink-200/80 bg-white"
        >
          <div className="flex h-full w-[400px] flex-col">
            <div className="drag h-11 shrink-0" />
            <div className="flex shrink-0 items-center gap-1 border-b border-ink-100 px-3 pb-2">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-navy-950 text-sun-400">
                <Sparkles size={12} />
              </span>
              <div className="ml-1 flex rounded-lg bg-ink-100 p-[3px] text-[12px] font-medium">
                {(["chat", "history"] as const).map((t) => (
                  <button key={t} onClick={() => setDock(t)} className={clsx("rounded-md px-2.5 py-1", dock === t ? "bg-white text-ink-950 shadow-sm" : "text-ink-500 hover:text-ink-800")}>
                    {t === "chat" ? "Conversation" : `History${list.length ? ` · ${list.length}` : ""}`}
                  </button>
                ))}
              </div>
              <div className="flex-1" />
              <IconBtn label="New conversation" onClick={newConversation}>
                <Plus size={15} />
              </IconBtn>
              <IconBtn label="Close the side panel" onClick={() => setDock(false)}>
                <X size={15} />
              </IconBtn>
            </div>
            {dock === "history" ? (
              <HistoryList list={list} current={conv?.id} onOpen={openConversation} onRemove={removeConversation} />
            ) : (
              <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-4 py-4 scroll-thin">
                {conv?.title && messages.length > 0 && <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-400">{conv.title}</div>}
                {messages.map((m) => (m.role === "user" ? <UserLine key={m.id} text={m.content} /> : <Answer key={m.id} m={m} onAct={act} />))}
                {busy && !stream && <ActivityCard request={request} calls={live} onStop={() => abort.current?.abort()} inline />}
                {stream && <Streaming text={stream} />}
                {error && <ErrorLine text={error} />}
                {!busy && lastAnswer && (
                  <NextSteps steps={nextSteps(lastAnswer, context, lastUser?.content)} onPick={(s) => send(s)} />
                )}
                {messages.length === 0 && !busy && (
                  <div className="pt-6 text-center">
                    <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-violet-50 text-violet-600">
                      <MessageSquare size={18} />
                    </div>
                    <p className="text-[13px] text-ink-500">Ask about what you see, or tell Kompass what to do. It shows each step on screen.</p>
                  </div>
                )}
              </div>
            )}
            <div className="shrink-0 space-y-2 border-t border-ink-100 bg-ink-50/60 p-3">
              {showSuggestions && dock === "chat" && suggestions}
              {composer}
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );

  if (dock) return (
    <>
      <GhostCursorLayer />
      {panel}
    </>
  );

  // ---------- Floating bubble ----------

  const below = pos.b > window.innerHeight / 2; // the bubble sits high up: cards open underneath
  const anchor: React.CSSProperties = below ? { right: pos.r, top: window.innerHeight - pos.b - pillH } : { right: pos.r, bottom: pos.b };

  if (minimized)
    return (
      <>
        <GhostCursorLayer />
        <motion.button
          layoutId="kompass-bubble"
          onClick={() => {
            setMinimized(false);
            setTimeout(() => input.current?.focus(), 60);
          }}
          style={{ right: pos.r, bottom: pos.b }}
          className="fixed z-40 grid h-12 w-12 place-items-center rounded-full bg-navy-950 text-sun-400 shadow-[0_10px_30px_-8px_rgba(10,20,60,0.5)]"
          aria-label="Open Kompass (⌘K)"
          title="Kompass (⌘K)"
        >
          {busy && <span className="absolute inset-0 animate-ping rounded-full bg-violet-600/30" />}
          <Sparkles size={19} />
        </motion.button>
      </>
    );

  const cards = (
    <AnimatePresence mode="popLayout">
      {card && (lastAnswer || stream || error) && (
        <motion.div
          key="answer"
          layout
          initial={{ opacity: 0, y: below ? -12 : 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: below ? -8 : 8, scale: 0.98 }}
          transition={{ duration: 0.28, ease: EASE }}
          className="pointer-events-auto flex max-h-[min(42vh,380px)] w-[min(440px,calc(100vw-100px))] flex-col overflow-hidden rounded-2xl border border-ink-200/70 bg-white/95 shadow-[0_18px_50px_-14px_rgba(30,20,80,0.38)] backdrop-blur-xl"
        >
          <div className="flex shrink-0 items-center gap-1 border-b border-ink-100/80 py-1.5 pl-3.5 pr-2">
            <Sparkles size={13} className="text-violet-600" />
            <div className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink-900">{conv?.title ?? "Kompass"}</div>
            <IconBtn label="Open in the side panel" onClick={() => setDock("chat")}>
              <PanelRightOpen size={14} />
            </IconBtn>
            <IconBtn label="Close (Esc)" onClick={() => setCard(false)}>
              <X size={14} />
            </IconBtn>
          </div>
          <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-3 scroll-thin">
            {lastUser && <UserLine text={lastUser.content} />}
            {!busy && lastAnswer && <Answer m={lastAnswer} onAct={act} compact />}
            {stream && <Streaming text={stream} />}
            {error && <ErrorLine text={error} />}
            {!busy && lastAnswer && <NextSteps steps={nextSteps(lastAnswer, context, lastUser?.content)} onPick={(s) => send(s)} />}
          </div>
        </motion.div>
      )}
      {busy && !stream && <ActivityCard key="activity" request={request} calls={live} onStop={() => abort.current?.abort()} />}
      {showSuggestions && !card && (
        <motion.div key="suggest" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.2, ease: EASE }} className="pointer-events-auto w-[min(440px,calc(100vw-100px))]">
          {suggestions}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      <GhostCursorLayer />
      <div style={anchor} className={clsx("pointer-events-none fixed z-40 flex items-end gap-2.5", below ? "flex-col" : "flex-col-reverse")}>
        <motion.div
          layoutId="kompass-bubble"
          layout={!dragging}
          className={clsx("pointer-events-auto relative w-[min(440px,calc(100vw-100px))] rounded-[22px] p-[1.5px]", busy ? "kompass-ring" : "bg-white/0", dragging && "cursor-grabbing")}
        >
          <div
            ref={pill}
            className={clsx(
              "flex items-end gap-1.5 rounded-[21px] border bg-white/95 py-2 pl-1 pr-2 shadow-[0_14px_40px_-12px_rgba(20,20,70,0.35)] backdrop-blur-xl transition-colors",
              busy ? "border-transparent" : focused ? "border-violet-600/40" : "border-ink-200/80",
            )}
          >
            <span
              onPointerDown={onGrab}
              onPointerMove={onMove}
              onPointerUp={onDrop}
              onPointerCancel={onDrop}
              className={clsx("mb-1.5 grid h-6 w-4 shrink-0 touch-none place-items-center rounded text-ink-300 hover:text-ink-600", dragging ? "cursor-grabbing" : "cursor-grab")}
              title="Drag to move Kompass"
              aria-label="Move Kompass"
            >
              <GripVertical size={14} />
            </span>
            <button
              onClick={() => (messages.length ? setCard((v) => !v) : input.current?.focus())}
              className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full bg-navy-950 text-sun-400"
              aria-label={card ? "Hide the answer" : "Show the last answer"}
              title={messages.length ? (card ? "Hide the answer" : "Show the last answer") : "Kompass"}
            >
              <motion.span animate={busy ? { rotate: 360 } : { rotate: 0 }} transition={busy ? { duration: 2.4, repeat: Infinity, ease: "linear" } : { duration: 0.3 }}>
                <Sparkles size={15} />
              </motion.span>
            </button>
            <div className="min-w-0 flex-1">{composer}</div>
            <div className="mb-1 flex shrink-0 items-center">
              <IconBtn label="Past conversations" onClick={() => setDock("history")}>
                <History size={14} />
              </IconBtn>
              <IconBtn label="Open the side panel" onClick={() => setDock("chat")}>
                <PanelRightOpen size={14} />
              </IconBtn>
              <IconBtn label="Shrink to a button" onClick={() => setMinimized(true)}>
                <Minus size={14} />
              </IconBtn>
            </div>
          </div>
        </motion.div>
        {cards}
      </div>
    </>
  );
}

/** The text box with its "Sees" line and the send or stop button. */
const Composer = forwardRef<
  HTMLTextAreaElement,
  { text: string; setText: (t: string) => void; busy: boolean; sees: string; placeholder: string; onSend: () => void; onStop: () => void; onFocus: () => void; onBlur: () => void }
>(function Composer({ text, setText, busy, sees, placeholder, onSend, onStop, onFocus, onBlur }, ref) {
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 px-0.5 text-[11px] leading-4 text-ink-500" title="Kompass reads what this page shows">
          <Eye size={11} className="shrink-0" />
          <span className="truncate">
            Looking at: <span className="text-ink-700">{sees}</span>
          </span>
        </div>
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={Math.min(5, Math.max(1, text.split("\n").length))}
          placeholder={placeholder}
          aria-label="Ask Kompass"
          disabled={busy}
          className="max-h-32 min-h-[22px] w-full resize-none bg-transparent px-0.5 text-[14px] leading-[22px] text-ink-900 outline-none placeholder:text-ink-400"
        />
      </div>
      {busy ? (
        <button onClick={onStop} className="mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink-900 text-white" aria-label="Stop">
          <Square size={11} fill="currentColor" />
        </button>
      ) : (
        <button onClick={onSend} disabled={!text.trim()} className="mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-600 text-white transition-colors disabled:bg-ink-200" aria-label="Send" title="Send (Enter)">
          <ArrowUp size={16} />
        </button>
      )}
    </div>
  );
});

function HistoryList({ list, current, onOpen, onRemove }: { list: ConversationMeta[]; current?: string; onOpen: (id: string) => void; onRemove: (id: string) => void }) {
  return (
    <div className="flex-1 overflow-y-auto p-2 scroll-thin">
      {list.length === 0 && <p className="p-6 text-center text-[13px] text-ink-400">No conversations yet.</p>}
      {list.map((c) => (
        <div key={c.id} className={clsx("group flex items-center gap-2 rounded-lg px-3 py-2.5 hover:bg-ink-50", current === c.id && "bg-violet-50/70")}>
          <button onClick={() => onOpen(c.id)} className="min-w-0 flex-1 text-left">
            <div className="truncate text-[13px] font-medium text-ink-900">{c.title}</div>
            <div className="text-[11.5px] text-ink-500">
              {fmtAgo(c.updatedAt)} · {c.messages} {c.messages === 1 ? "message" : "messages"}
            </div>
          </button>
          <button onClick={() => onRemove(c.id)} className="rounded p-1 text-ink-300 opacity-0 hover:text-bad-600 group-hover:opacity-100" aria-label="Delete conversation" title="Delete conversation">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function Streaming({ text }: { text: string }) {
  // Half-arrived bold ("**90 EV dri") renders bold right away instead of showing the asterisks.
  let shown = text.replace(/(?<!\*)\*$/, "");
  if ((shown.match(/\*\*/g)?.length ?? 0) % 2 === 1) shown = /\*\*\s*$/.test(shown) ? shown.replace(/\*\*\s*$/, "") : `${shown.replace(/\s+$/, "")}**`;
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <Markdown>{linkIds(shown)}</Markdown>
      <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-violet-600 align-middle" />
    </motion.div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-bad-50 px-3 py-2 text-[12.5px] text-bad-600">
      <XCircle size={14} className="mt-0.5 shrink-0" />
      {text}
    </div>
  );
}

function NextSteps({ steps, onPick }: { steps: string[]; onPick: (s: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 pt-0.5">
      {steps.map((s) => (
        <button key={s} onClick={() => onPick(s)} className="rounded-full border border-violet-600/20 bg-violet-50 px-2.5 py-1 text-left text-[12px] text-violet-600 transition-colors hover:bg-violet-600 hover:text-white">
          {s}
        </button>
      ))}
    </div>
  );
}

function IconBtn({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={clsx("rounded-md p-1.5 hover:bg-ink-100", active ? "text-ink-900" : "text-ink-400")} title={label} aria-label={label}>
      {children}
    </button>
  );
}

function UserLine({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-navy-900 px-3.5 py-2 text-[13px] leading-relaxed text-white">{text}</div>
    </div>
  );
}

function Answer({ m, onAct, compact }: { m: ChatMessage; onAct: (c: ChatToolCall, a: "apply" | "discard") => void; compact?: boolean }) {
  const calls = m.toolCalls ?? [];
  // On the floating card, results the screen already shows (charts, tables) stay out of the way.
  const shown = compact ? calls.filter((c) => !["set_chart", "add_field", "set_chart_type"].includes(c.name)) : calls;
  return (
    <motion.div className="space-y-2.5" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      {m.content && <Markdown>{linkIds(m.content)}</Markdown>}
      <ToolResults calls={shown} onAct={onAct} />
      <StepsDisclosure calls={calls} />
    </motion.div>
  );
}
