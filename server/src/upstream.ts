// Client for the team's insights service (customer profiles, dCLV decisions, campaign plans,
// timeline, semantic search, SQL semantic layer and LLM tools). Kompass never re-implements
// those; it calls this service and adds the workspace on top.
import type { CustomerProfile, CustomerSummary, Page, TimelineItem, Vocabulary } from "../../shared/types.ts";
import { log } from "./log.ts";

const CANDIDATES = [process.env.INSIGHTS_URL, "http://130.83.85.181:44080/svc", "http://localhost:8100"].filter(
  (u): u is string => !!u,
);

let base = CANDIDATES[0];
export const upstreamState = { base, ok: false, checkedAt: "", error: "" as string };

export class UpstreamError extends Error {
  constructor(
    message: string,
    public status = 502,
    public detail?: unknown,
  ) {
    super(message);
  }
}

/** Picks the first reachable insights service. Called at start-up and when a request fails. */
export async function connect() {
  for (const url of CANDIDATES) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        base = url;
        Object.assign(upstreamState, { base: url, ok: true, checkedAt: new Date().toISOString(), error: "" });
        return url;
      }
    } catch {
      // try the next one
    }
  }
  Object.assign(upstreamState, { ok: false, checkedAt: new Date().toISOString(), error: `No insights service reachable (${CANDIDATES.join(", ")})` });
  return null;
}

// Profiles and aggregates only change when the service reloads its data, so a short cache keeps the
// UI fast against the remote deployment.
const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 10 * 60_000;
const GATEWAY = new Set([502, 503, 504]);
const RETRY_MS = [300, 900];

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, opts: { cache?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const key = `${method} ${path} ${body ? JSON.stringify(body) : ""}`;
  const useCache = opts.cache ?? true;
  if (useCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  }
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (e) {
      upstreamState.ok = false;
      void connect();
      throw new UpstreamError(`Insights service not reachable at ${base}: ${(e as Error).message}`, 503);
    }
    const text = await res.text();
    let json: unknown;
    let parsed = true;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      parsed = false;
    }
    // A gateway hiccup (an error page instead of JSON, or 502/503/504) is tried again: every call here only reads or computes.
    if ((!parsed || GATEWAY.has(res.status)) && attempt < RETRY_MS.length) {
      log.warn("upstream", `${method} ${path}: ${parsed ? `HTTP ${res.status}` : "no JSON"}, trying again`, { status: res.status, attempt: attempt + 1, body: text.slice(0, 160) });
      await new Promise((r) => setTimeout(r, RETRY_MS[attempt]));
      continue;
    }
    if (!parsed) {
      log.error("upstream", `${method} ${path}: no JSON after ${attempt + 1} tries`, { status: res.status, body: text.slice(0, 300) });
      throw new UpstreamError(`Insights service returned non-JSON for ${path} (HTTP ${res.status})`, 502);
    }
    if (!res.ok) {
      const p = json as { title?: string; detail?: string } | null;
      throw new UpstreamError(p?.detail ?? p?.title ?? `Insights service returned ${res.status} for ${path}`, res.status, json);
    }
    if (attempt > 0) log.info("upstream", `${method} ${path} worked on try ${attempt + 1}`);
    upstreamState.ok = true;
    if (useCache) cache.set(key, { at: Date.now(), value: json });
    return json as T;
  }
}

export const ins = {
  get: <T>(path: string, opts?: { cache?: boolean; timeoutMs?: number }) => call<T>("GET", path, undefined, opts),
  post: <T>(path: string, body: unknown, opts?: { cache?: boolean; timeoutMs?: number }) => call<T>("POST", path, body, opts),
  clearCache: () => cache.clear(),
  get base() {
    return base;
  },
};

// ---------- Typed helpers ----------

export const getProfile = (id: string) => ins.get<CustomerProfile>(`/customers/${encodeURIComponent(id)}`);
export const getTimeline = (id: string) => ins.get<TimelineItem[]>(`/customers/${encodeURIComponent(id)}/timeline`);
export const getVocabulary = () => ins.get<Vocabulary>("/meta/vocabulary");

export function searchCustomers(body: { audience?: object; sort?: string; desc?: boolean; limit?: number; offset?: number }) {
  return ins.post<Page<CustomerSummary>>(`/customers/search?limit=${body.limit ?? 50}&offset=${body.offset ?? 0}`, {
    audience: body.audience ?? {},
    sort: body.sort ?? "value_at_risk",
    desc: body.desc ?? true,
  });
}

export interface RowsResult<T> {
  rows: T[];
  total: number;
}
export function queryRows<T>(dataset: string, fields: string[], filters: { field: string; op?: string; value?: unknown }[], limit = 200, offset = 0) {
  return ins.post<RowsResult<T>>("/query/rows", { dataset, fields, filters, limit, ...(offset ? { offset } : {}) });
}
export function aggregate<T>(body: object) {
  return ins.post<{ rows: T[] }>("/query/aggregate", body);
}

/** Runs `fn` over `items` with at most `n` requests in flight. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}
