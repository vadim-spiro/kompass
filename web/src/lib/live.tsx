// The live clock: one replay of the 01.10.2026 event stream shared by every page. Play moves the
// clock forward a few minutes per second; each step sends the events that arrived to the server,
// which decides again for each customer. Pages read the state and refresh when decisions land.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LiveDecision, LiveState } from "../../../shared/types";
import { api, reportIssue } from "../api/client";
import { emitDataChanged } from "./useAsync";

export const SPEEDS = [
  { minutes: 5, label: "5 min/s" },
  { minutes: 20, label: "20 min/s" },
  { minutes: 60, label: "1 h/s" },
] as const;

interface LiveCtx {
  state: LiveState | null;
  playing: boolean;
  speed: number;
  busy: boolean;
  error: string | null;
  /** Decisions from the last step, newest first: pages flash them. */
  fresh: LiveDecision[];
  play: () => void;
  pause: () => void;
  setSpeed: (minutes: number) => void;
  step: (minutes: number) => Promise<void>;
  jumpTo: (at: string) => Promise<void>;
  nextDecision: () => Promise<void>;
  reset: () => Promise<void>;
  reload: () => void;
}

const Ctx = createContext<LiveCtx | null>(null);

const SPEED_KEY = "kompass.liveSpeed";
const readSpeed = () => {
  try {
    return Number(localStorage.getItem(SPEED_KEY)) || 20;
  } catch {
    return 20;
  }
};

export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LiveState | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(readSpeed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<LiveDecision[]>([]);
  const inFlight = useRef(false);
  const ticks = useRef(0);

  const reload = useCallback(() => {
    api.live().then(
      (s) => {
        setState(s);
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
  }, []);
  useEffect(reload, [reload]);

  const advance = useCallback(
    async (body: { to?: string; minutes?: number }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        const r = await api.liveAdvance(body);
        setFresh(r.decisions);
        setState((s) =>
          s && {
            ...s,
            clock: r.clock,
            counts: r.counts,
            morningRun: r.morningRun,
            desk: r.desk,
            next: r.next,
            events: [...s.events, ...r.events],
            decisions: [...r.decisions, ...s.decisions.filter((d) => !r.decisions.some((x) => x.id === d.id))],
          },
        );
        // Freshness and the morning run's result come with the full state now and then.
        if (++ticks.current % 6 === 0 || r.events.length === 0) reload();
        if (r.decisions.length) emitDataChanged();
        if (r.clock >= (state?.end ?? "9999")) setPlaying(false);
        setError(null);
      } catch (e) {
        setPlaying(false);
        setError((e as Error).message);
        reportIssue("error", "live", "advance failed", { body, error: (e as Error).message });
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [reload, state?.end],
  );

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => void advance({ minutes: speed }), 1000);
    return () => clearInterval(t);
  }, [playing, speed, advance]);

  const value = useMemo<LiveCtx>(
    () => ({
      state,
      playing,
      speed,
      busy,
      error,
      fresh,
      play: () => {
        if (state && state.clock >= state.end) return;
        setPlaying(true);
      },
      pause: () => {
        setPlaying(false);
        reload();
      },
      setSpeed: (m) => {
        setSpeedState(m);
        try {
          localStorage.setItem(SPEED_KEY, String(m));
        } catch {
          /* only a convenience */
        }
      },
      step: (minutes) => advance({ minutes }),
      jumpTo: (to) => advance({ to }),
      nextDecision: async () => {
        if (state?.next) await advance({ to: state.next.at });
      },
      reset: async () => {
        setPlaying(false);
        setBusy(true);
        try {
          setState(await api.liveReset());
          setFresh([]);
          emitDataChanged();
        } catch (e) {
          setError((e as Error).message);
          reportIssue("error", "live", "reset failed", { error: (e as Error).message });
        } finally {
          setBusy(false);
        }
      },
      reload,
    }),
    [state, playing, speed, busy, error, fresh, advance, reload],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLive outside LiveProvider");
  return v;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Thu 01.10. 10:20" from "2026-10-01 10:20:00". */
export function clockLabel(at: string, withDay = true) {
  const d = new Date(`${at.slice(0, 10)}T12:00:00`);
  return `${withDay ? `${WEEKDAY[d.getDay()]} ` : ""}${at.slice(8, 10)}.${at.slice(5, 7)}. ${at.slice(11, 16)}`;
}

/** True before the replay started: the app shows the snapshot of 30.09. */
export const beforeDay = (s: LiveState | null) => !s || s.clock < s.start;
