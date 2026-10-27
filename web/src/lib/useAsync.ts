import { useCallback, useEffect, useRef, useState } from "react";

// Minimal data hook: load on mount / when deps change, expose reload().
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const load = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    fn()
      .then((d) => {
        if (id === seq.current) {
          setData(d);
          setError(undefined);
        }
      })
      .catch((e) => id === seq.current && setError(e))
      .finally(() => id === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    load();
  }, [load]);

  return { data, error, loading, reload: load, setData };
}

// Global "data changed" signal so pages refresh after config changes or approvals.
const subs = new Set<() => void>();
export function emitDataChanged() {
  subs.forEach((s) => s());
}
export function useDataChanged(fn: () => void) {
  useEffect(() => {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  }, [fn]);
}
