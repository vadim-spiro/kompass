import clsx from "clsx";
import { BarChart3, Headset, Home, Megaphone, Pause, Play, Radio, Settings, Users, Workflow, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { api, type Status } from "../api/client";
import { beforeDay, clockLabel, LiveProvider, useLive } from "../lib/live";
import { useDataChanged } from "../lib/useAsync";
import { Bubble } from "./bubble/Bubble";
import { ErrorBoundary } from "./ErrorBoundary";
import { PageTransition } from "./motion";

export type Mode = "marketing" | "service";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  badge?: "approvals" | "desk";
}

const NAV: Record<Mode, NavItem[]> = {
  marketing: [
    { to: "/", label: "Home", icon: Home, end: true, badge: "approvals" },
    { to: "/campaigns", label: "Campaigns", icon: Megaphone },
    { to: "/automations", label: "Automations", icon: Workflow },
    { to: "/customers", label: "Customers", icon: Users },
    { to: "/analytics", label: "Analytics", icon: BarChart3 },
    { to: "/live", label: "Live stream", icon: Radio },
  ],
  service: [
    { to: "/service", label: "Service desk", icon: Headset, end: true, badge: "desk" },
    { to: "/service/customers", label: "Find a customer", icon: Users },
    { to: "/live", label: "Live stream", icon: Radio },
  ],
};

const MODE_KEY = "kompass.mode";
const readMode = (): Mode => {
  try {
    return localStorage.getItem(MODE_KEY) === "service" ? "service" : "marketing";
  } catch {
    return "marketing";
  }
};

/** The mode follows the page: service pages are service, marketing pages are marketing, shared pages keep the last one. */
function modeFor(path: string, last: Mode): Mode {
  if (path.startsWith("/service")) return "service";
  if (path === "/" || /^\/(campaigns|automations|analytics)/.test(path)) return "marketing";
  return last;
}

export function Layout() {
  return (
    <LiveProvider>
      <Shell />
    </LiveProvider>
  );
}

function Shell() {
  const [status, setStatus] = useState<Status | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const live = useLive();
  const [lastMode, setLastMode] = useState<Mode>(readMode);
  const mode = modeFor(location.pathname, lastMode);

  useEffect(() => {
    if (mode === lastMode) return;
    setLastMode(mode);
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* only a convenience */
    }
  }, [mode, lastMode]);

  const load = useCallback(() => {
    api.status().then(setStatus, () => setStatus(null));
  }, []);
  useEffect(load, [load, location.pathname]);
  useDataChanged(load);

  const badges = {
    approvals: status?.workspace.pendingProposals ?? 0,
    desk: live.state?.desk.filter((d) => d.status === "waiting").length ?? 0,
  };
  const online = status?.insights.ok;

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setLastMode(m);
    navigate(m === "service" ? "/service" : "/");
  };

  return (
    <div className="flex h-full">
      {/* Icon rail: 60 px; hovering widens it over the page with the labels. */}
      <div className="relative w-[60px] shrink-0">
        <aside className="group/rail absolute inset-y-0 left-0 z-50 flex w-[60px] flex-col overflow-hidden border-r border-ink-200/80 bg-[#eceef2] transition-[width,box-shadow] delay-0 duration-200 ease-out hover:w-[228px] hover:shadow-[8px_0_30px_-12px_rgba(16,24,40,0.25)] hover:delay-150">
          <div className="drag h-11 shrink-0" />
          <div className="flex items-center gap-2.5 px-[14px] pb-4">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-navy-900">
              <svg viewBox="0 0 32 32" className="h-4 w-4" aria-hidden>
                <path d="M16 3l5.5 13L16 29l-5.5-13z" fill="#ffe500" />
              </svg>
            </span>
            <div className="min-w-0 leading-tight opacity-0 transition-opacity group-hover/rail:opacity-100">
              <div className="text-[14px] font-semibold text-ink-950">Kompass</div>
              <div className="whitespace-nowrap text-[11px] text-ink-500">MAINGAU Energie</div>
            </div>
          </div>

          <ModeSwitch mode={mode} onChange={switchMode} />

          <nav className="mt-3 flex-1 space-y-0.5 px-2">
            {NAV[mode].map((it) => (
              <RailLink key={it.to} item={it} badge={it.badge ? badges[it.badge] : 0} />
            ))}
          </nav>

          <div className="space-y-1 p-2">
            <LiveClock />
            <RailLink item={{ to: "/settings", label: "Settings", icon: Settings }} badge={0} />
            <div
              className="flex items-center gap-2.5 px-[19px] pb-1 pt-1.5 text-[11.5px] text-ink-500"
              title={online ? `Insights service: ${status?.insights.base}` : (status?.insights.error ?? "Workspace server offline: start it with npm run dev")}
            >
              <span className={clsx("h-2 w-2 shrink-0 rounded-full", online ? "bg-good-600" : "bg-warn-600")} />
              <span className="whitespace-nowrap opacity-0 transition-opacity group-hover/rail:opacity-100">
                {online ? "Customer data of 30.09.2026" : status ? "Insights service offline" : "Server offline"}
              </span>
            </div>
          </div>
        </aside>
      </div>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {/* A new page fades in; query changes (steps, tabs) keep the page mounted. */}
        <PageTransition key={location.pathname.split("/").slice(0, 3).join("/")} className="flex min-h-0 flex-1 flex-col">
          <ErrorBoundary key={location.pathname}>
            <Outlet context={{ mode }} />
          </ErrorBoundary>
        </PageTransition>
      </main>
      <Bubble />
    </div>
  );
}

function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const opts: { value: Mode; label: string; icon: LucideIcon }[] = [
    { value: "marketing", label: "Marketing", icon: Megaphone },
    { value: "service", label: "Service", icon: Headset },
  ];
  return (
    <div className="mx-2 flex rounded-lg bg-ink-200/60 p-[3px]" role="tablist" aria-label="Mode">
      {opts.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={mode === o.value}
          onClick={() => onChange(o.value)}
          title={`${o.label} mode`}
          className={clsx(
            "flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] font-medium transition-colors",
            mode === o.value ? "bg-white text-ink-950 shadow-[0_1px_2px_rgba(16,24,40,0.1)]" : "text-ink-500 hover:text-ink-800",
          )}
        >
          <o.icon size={14} strokeWidth={2} className="shrink-0" />
          <span className="hidden whitespace-nowrap group-hover/rail:inline">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function RailLink({ item, badge }: { item: NavItem; badge: number }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={item.label}
      data-ai={`nav:${item.to}`}
      className={({ isActive }) =>
        clsx(
          "relative flex h-9 items-center gap-3 rounded-lg px-[12px] text-[13.5px] transition-colors",
          isActive ? "bg-white font-medium text-ink-950 shadow-[0_1px_2px_rgba(16,24,40,0.08)]" : "text-ink-700 hover:bg-white/60",
        )
      }
    >
      <item.icon size={18} strokeWidth={1.9} className="shrink-0" />
      <span className="flex-1 whitespace-nowrap opacity-0 transition-opacity group-hover/rail:opacity-100">{item.label}</span>
      {badge > 0 && (
        <span className="num absolute left-[26px] top-[3px] min-w-[16px] rounded-full bg-navy-900 px-1 text-center text-[10px] font-semibold leading-[16px] text-white group-hover/rail:static group-hover/rail:px-1.5 group-hover/rail:text-[11px] group-hover/rail:leading-[18px]">
          {badge}
        </span>
      )}
    </NavLink>
  );
}

/** The replay clock on every page: what time it is in the 01.10. stream, with play and pause. */
function LiveClock() {
  const live = useLive();
  const navigate = useNavigate();
  const s = live.state;
  if (!s) return null;
  const idle = beforeDay(s);
  const done = s.clock >= s.end;
  return (
    <div className={clsx("flex items-center gap-2 rounded-lg px-[6px] py-1.5", live.playing ? "bg-violet-50" : "bg-white/50")}>
      <div className="flex w-8 shrink-0 flex-col items-center gap-0.5">
        <button
          onClick={() => (live.playing ? live.pause() : live.play())}
          disabled={done}
          className={clsx("grid h-6 w-6 place-items-center rounded-full text-white disabled:bg-ink-300", live.playing ? "bg-violet-600" : "bg-navy-900")}
          aria-label={live.playing ? "Pause the live stream" : "Play the live stream"}
          title={live.playing ? "Pause" : idle ? "Play the 01.10. event stream" : "Play"}
        >
          {live.playing ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" className="ml-[1px]" />}
        </button>
        <span className="num text-[10px] font-semibold leading-3 text-ink-700">{idle ? "30.09." : s.clock.slice(11, 16)}</span>
      </div>
      <button onClick={() => navigate("/live")} className="min-w-0 flex-1 text-left opacity-0 transition-opacity group-hover/rail:opacity-100" title="Open the live stream">
        <div className="num whitespace-nowrap text-[12px] font-semibold leading-4 text-ink-900">{idle ? "Snapshot 30.09." : clockLabel(s.clock)}</div>
        <div className="whitespace-nowrap text-[10.5px] leading-[13px] text-ink-500">{idle ? "Play to replay 01.10." : done ? "Stream replayed" : `${s.counts.applied} of ${s.counts.total} events`}</div>
      </button>
    </div>
  );
}
