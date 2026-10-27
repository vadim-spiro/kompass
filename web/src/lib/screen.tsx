// The screen bridge: each page tells the Kompass bubble what is on screen (a small snapshot) and
// which UI actions it can perform there. The bubble runs those actions visibly when the model
// asks for them. Elements an action touches carry data-ai="<target>" for the cursor and glow.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ScreenSnapshot } from "../../../shared/uiActions";

export type UiArgs = Record<string, unknown>;
/** Returns a short message for the model (what changed), or throws with a plain reason. */
export type UiHandler = (args: UiArgs) => Promise<string | void> | string | void;
export interface UiHandlerDef {
  run: UiHandler;
  /** data-ai target to point at before running, e.g. "timing" or `block:${id}`. */
  target?: (args: UiArgs) => string | undefined;
  /** Runs before the cursor moves, e.g. to open the tab the target is on. */
  prepare?: (args: UiArgs) => void | Promise<void>;
}

interface Registration {
  view: string;
  snapshot: ScreenSnapshot;
  actions: Record<string, UiHandlerDef>;
}

let current: Registration | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const screenStore = {
  get: () => current,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  snapshot: (): ScreenSnapshot | undefined => current?.snapshot,
  /** Waits until a page for `view` has registered (after a navigation), up to `ms`. */
  async waitFor(view: string, ms = 4000, action?: string): Promise<Registration | null> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (current?.view === view && (!action || current.actions[action])) return current;
      await new Promise((r) => setTimeout(r, 60));
    }
    return current?.view === view ? current : null;
  },
};

/** Registers the page with the bubble. `snapshot` may change on every render; `actions` always see the latest state. */
export function useScreen(view: string, snapshot: ScreenSnapshot, actions: Record<string, UiHandlerDef> = {}) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const key = JSON.stringify(snapshot);

  useEffect(() => {
    const proxied: Record<string, UiHandlerDef> = {};
    for (const name of Object.keys(actionsRef.current))
      proxied[name] = { run: (a) => actionsRef.current[name].run(a), target: (a) => actionsRef.current[name]?.target?.(a), prepare: (a) => actionsRef.current[name]?.prepare?.(a) };
    current = { view, snapshot, actions: proxied };
    notify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, key, Object.keys(actions).join(",")]);

  useEffect(
    () => () => {
      if (current?.view === view) {
        current = null;
        notify();
      }
    },
    [view],
  );
}

export function useScreenSnapshot() {
  return useSyncExternalStore(screenStore.subscribe, () => current?.snapshot);
}

/** Lets the next paint happen, so a change is on screen before the bubble reports it. */
export const settle = (ms = 250) => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, ms)));
