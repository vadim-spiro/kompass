// Debug log: one JSON line per entry in server/logs/kompass.log, warnings and errors also on the
// console. Browser errors arrive through POST /api/log and land in the same file (scope "web:…").
// Look things up with:
//   tail -n 50 server/logs/kompass.log
//   grep '"level":"error"' server/logs/kompass.log | tail
//   curl 'localhost:8787/api/logs?level=warn&scope=live&limit=50'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  at: string;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: unknown;
}

const DIR = process.env.LOG_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "logs");
export const LOG_FILE = join(DIR, "kompass.log");
const MAX_BYTES = 5_000_000;
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const SECRET = /token|bearer|authorization|password|secret|api[_-]?key/i;

const recent: LogEntry[] = [];

/** Makes data loggable: errors keep name, message and stack; secrets are redacted; long text is cut. */
function clean(v: unknown, depth = 0): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.split("\n").slice(0, 6).join("\n") };
  if (typeof v === "string") return v.length > 2000 ? `${v.slice(0, 2000)}… (${v.length} chars)` : v;
  if (v == null || typeof v !== "object") return v;
  if (depth > 4) return "[…]";
  if (Array.isArray(v)) return v.length > 50 ? [...v.slice(0, 50).map((x) => clean(x, depth + 1)), `… ${v.length - 50} more`] : v.map((x) => clean(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? "[redacted]" : clean(x, depth + 1)]));
}

let dirReady = false;
function write(level: LogLevel, scope: string, msg: string, data?: unknown) {
  const e: LogEntry = { at: new Date().toISOString(), level, scope, msg, ...(data !== undefined ? { data: clean(data) } : {}) };
  recent.push(e);
  if (recent.length > 2000) recent.shift();
  try {
    if (!dirReady) {
      mkdirSync(DIR, { recursive: true });
      dirReady = true;
    }
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, join(DIR, "kompass.1.log"));
    appendFileSync(LOG_FILE, `${JSON.stringify(e)}\n`);
  } catch {
    /* logging must never break a request */
  }
  if (level === "error") console.error(`[${scope}] ${msg}`, data !== undefined ? e.data : "");
  else if (level === "warn") console.warn(`[${scope}] ${msg}`, data !== undefined ? e.data : "");
}

export const log = {
  debug: (scope: string, msg: string, data?: unknown) => write("debug", scope, msg, data),
  info: (scope: string, msg: string, data?: unknown) => write("info", scope, msg, data),
  warn: (scope: string, msg: string, data?: unknown) => write("warn", scope, msg, data),
  error: (scope: string, msg: string, data?: unknown) => write("error", scope, msg, data),
  /** The latest entries since the server started, newest last. */
  recent(opts: { level?: LogLevel; scope?: string; limit?: number } = {}) {
    const min = RANK[opts.level ?? "debug"] ?? 0;
    const out = recent.filter((e) => RANK[e.level] >= min && (!opts.scope || e.scope.startsWith(opts.scope)));
    return out.slice(-(opts.limit ?? 200));
  },
};

/** Times an async step and logs it when it fails or is slow. */
export async function timed<T>(scope: string, msg: string, fn: () => Promise<T>, slowMs = 3000): Promise<T> {
  const t = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - t;
    if (ms > slowMs) log.warn(scope, `${msg} took ${ms} ms`);
    return out;
  } catch (e) {
    log.error(scope, `${msg} failed after ${Date.now() - t} ms`, e);
    throw e;
  }
}
