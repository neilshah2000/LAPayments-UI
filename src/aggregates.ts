// Single-council aggregates. Each reads exactly one Parquet file via councilParquet().
// Every £ figure is grouped by amount_kind (and date_kind where dates matter) -- the UI
// must never sum net with gross without knowing it.
import { z } from 'zod';
import { councilParquet, query, UnknownCouncil, type Row } from './db.ts';
import { FACET_COLUMNS, getCouncil } from './councils.ts';
import { applied, excludedSelect, type Filters } from './policy.ts';
import type {
  AggregateBase as Base, Breakdown, Excluded, FacetColumn, Kinded, Ranked, Summary, Suppliers, Timeseries,
} from './api-types.ts';

export type { Breakdown, Summary, Suppliers, Timeseries };

const KINDED = `amount_kind, count(*) AS rows, coalesce(sum(amount), 0) AS sum_pence,
                coalesce(sum(amount) FILTER (amount < 0), 0) AS credits_pence`;

async function base(la_code: string, f: Filters, on: 'date' | 'period_start' = 'date') {
  const src = await councilParquet(la_code);
  const w = applied(f, on);
  const ex = excludedSelect(f, on);
  const excluded = query(`SELECT ${ex.sql} FROM ${src}`, ex.params).then(([r]) => r as unknown as Excluded);
  // Started here, awaited only in head(), so it runs alongside the caller's own aggregate.
  // If that aggregate rejects first, head() is never reached and this rejection would go
  // unobserved -- which Node treats as an unhandled rejection and exits the process on.
  // Mark it observed; whoever awaits `excluded` still gets the error.
  excluded.catch(() => {});
  return { src, w, excluded, head: async (): Promise<Base> => ({ la_code, window: w.window, min_pence: f.min_pence ?? null, excluded: await excluded }) };
}

// --- summary ------------------------------------------------------------------------------

export async function summary(la_code: string, f: Filters): Promise<Summary> {
  const { src, w, head } = await base(la_code, f);
  const by_kind = await query(
    `SELECT date_kind, ${KINDED} FROM ${src} WHERE ${w.where} GROUP BY ALL ORDER BY sum_pence DESC`,
    w.params,
  );
  return { ...(await head()), by_kind: by_kind as unknown as Summary['by_kind'] };
}

// --- timeseries ---------------------------------------------------------------------------

export const timeseriesSchema = z.object({
  by: z.enum(['month', 'quarter', 'year']).default('month'),
  /** date = the row's own date (time series); period = the file label period_start (coverage:
   *  which months has the council published?). The window applies to the same column. */
  key: z.enum(['date', 'period']).default('date'),
});
export type TimeseriesOpts = z.infer<typeof timeseriesSchema>;

export async function timeseries(la_code: string, f: Filters, o: TimeseriesOpts): Promise<Timeseries> {
  const col = o.key === 'date' ? 'date' : 'period_start';
  const { src, w, head } = await base(la_code, f, col);
  const bucket =
    o.by === 'quarter' ? `strftime(${col}, '%Y-Q') || quarter(${col})`
    : o.by === 'year' ? `strftime(${col}, '%Y')`
    : `strftime(${col}, '%Y-%m')`;
  const series = await query(
    `SELECT ${bucket} AS period, ${KINDED}, list_sort(list_distinct(list(date_kind))) AS date_kinds
     FROM ${src} WHERE ${w.where} GROUP BY ALL ORDER BY period, amount_kind`,
    w.params,
  );
  return {
    ...(await head()),
    by: o.by,
    key: o.key,
    series: series.map((r) => ({ ...r, date_kinds: parseList(r.date_kinds) })) as unknown as Timeseries['series'],
  };
}

// DuckDB LIST values come back stringified by the JSON policy ("[paid, invoice]"); unpack.
function parseList(v: unknown): string[] {
  const s = String(v ?? '[]').trim();
  return s === '[]' ? [] : s.slice(1, -1).split(', ').map((x) => x.replace(/^'|'$/g, ''));
}

// --- ranked breakdowns (shared by breakdown and suppliers) --------------------------------

/** Top N values by |total| across kinds, each with its per-kind split. `extra` selects
 *  additional per-value columns (e.g. first/last seen). Returns N values, not N (value, kind) rows. */
async function ranked(src: string, valueExpr: string, where: string, params: unknown[], top: number, extra = '') {
  const rows = await query(
    `WITH r AS (
       SELECT ${valueExpr} AS value, ${KINDED}${extra} FROM ${src} WHERE ${where} GROUP BY ALL
     ), t AS (
       SELECT value, sum(sum_pence) AS total FROM r GROUP BY value ORDER BY abs(total) DESC, value LIMIT ?
     )
     SELECT r.* FROM r JOIN t USING (value) ORDER BY abs(t.total) DESC, value, amount_kind`,
    [...params, top] as never,
  );
  return nest(rows, extra !== '');
}

function nest(rows: Row[], withSeen: boolean): (Ranked & { value: string; first?: string; last?: string })[] {
  const out = new Map<string, Ranked & { value: string; first?: string; last?: string }>();
  for (const r of rows) {
    const value = r.value as string;
    let v = out.get(value);
    if (!v) {
      v = { value, rows: 0, sum_pence: 0, credits_pence: 0, by_kind: [] };
      out.set(value, v);
    }
    const k = { amount_kind: r.amount_kind as string, rows: r.rows as number, sum_pence: r.sum_pence as number, credits_pence: r.credits_pence as number };
    v.by_kind.push(k);
    v.rows += k.rows;
    v.sum_pence += k.sum_pence;
    v.credits_pence += k.credits_pence;
    if (withSeen) {
      v.first = v.first === undefined || (r.first as string) < v.first ? (r.first as string) : v.first;
      v.last = v.last === undefined || (r.last as string) > v.last ? (r.last as string) : v.last;
    }
  }
  return [...out.values()];
}

export const breakdownSchema = z.object({
  dim: z.enum(FACET_COLUMNS),
  top: z.coerce.number().int().min(1).max(500).default(25),
});
export type BreakdownOpts = z.infer<typeof breakdownSchema>;

export class UnsupportedFacet extends Error {
  constructor(la_code: string, dim: FacetColumn) {
    super(`${la_code} does not publish ${dim}`);
  }
}

export async function breakdown(la_code: string, f: Filters, o: BreakdownOpts): Promise<Breakdown> {
  const council = await getCouncil(la_code);
  if (!council) throw new UnknownCouncil(la_code);
  // With no profile the file is unreadable, so we cannot know whether this council publishes
  // the column. Fall through and let the read below raise the missing-data error (503).
  // Answering UnsupportedFacet (400) here would blame the caller for our own outage.
  if (council.profile && !council.profile.facets.includes(o.dim)) throw new UnsupportedFacet(la_code, o.dim);
  const { src, w, head } = await base(la_code, f);
  const [values, unclassified] = await Promise.all([
    ranked(src, o.dim, `${w.where} AND ${o.dim} IS NOT NULL`, w.params, o.top),
    query(`SELECT ${KINDED} FROM ${src} WHERE ${w.where} AND ${o.dim} IS NULL GROUP BY ALL`, w.params),
  ]);
  return { ...(await head()), dim: o.dim, unclassified: unclassified as unknown as Kinded[], values };
}

export const suppliersSchema = z.object({
  top: z.coerce.number().int().min(1).max(500).default(50),
});
export type SuppliersOpts = z.infer<typeof suppliersSchema>;

export async function suppliers(la_code: string, f: Filters, o: SuppliersOpts): Promise<Suppliers> {
  const { src, w, head } = await base(la_code, f);
  const [ranks, redacted] = await Promise.all([
    ranked(src, 'supplier', `${w.where} AND NOT redacted AND supplier IS NOT NULL AND supplier <> ''`, w.params, o.top,
      ', min(date) AS first, max(date) AS last'),
    query(`SELECT ${KINDED} FROM ${src} WHERE ${w.where} AND redacted GROUP BY ALL`, w.params),
  ]);
  return {
    ...(await head()),
    canonical: false,
    redacted: redacted as unknown as Kinded[],
    suppliers: ranks.map(({ value, ...r }) => ({ supplier: value, ...r })) as Suppliers['suppliers'],
  };
}
