// Raw rows from the insights service's datasets, paged and cached. Kompass aggregates them itself
// where /query/aggregate cannot: hour of day, and joins with customer attributes.
import { queryRows } from "./upstream.ts";

const TTL_MS = 15 * 60_000;
const PAGE = 1000;
const cache = new Map<string, { at: number; rows: Promise<unknown[]> }>();

/** All rows of a dataset (all are small: the largest has about 6,000 rows). */
export function loadDataset<T = Record<string, unknown>>(dataset: string, fields: string[] = []): Promise<T[]> {
  const key = `${dataset}|${fields.join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows as Promise<T[]>;
  const rows = (async () => {
    const out: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await queryRows<T>(dataset, fields, [], PAGE, offset);
      out.push(...page.rows);
      if (page.rows.length < PAGE || out.length >= page.total) return out;
    }
  })();
  cache.set(key, { at: Date.now(), rows });
  rows.catch(() => cache.delete(key));
  return rows;
}

export const hourOf = (iso: unknown) => {
  const m = typeof iso === "string" ? /T(\d{2}):/.exec(iso) : null;
  return m ? Number(m[1]) : null;
};
