// Cleaning policy v1 -- the one place that decides what an aggregate includes by default.
// See docs/serving-context.md §4 and the README. Every aggregate response echoes the policy
// it applied and the rows it excluded, so no figure is unexplained.
import { z } from 'zod';
import type { DateColumn, Excluded, Window } from './api-types.ts';

export type { DateColumn, Excluded, Window };

/** Lower bound of the default date window: FY2015/16, when the Transparency Code became
 *  a statutory requirement. Rows before it (1.76M at 2026-09-22) are reported, not lost. */
export const WINDOW_FROM = '2015-04-01';

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// A real calendar date, not just the shape of one: "2020-13-01" must be a 400, not a DuckDB error.
const isoDate = z.string().refine((s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}, 'must be a valid YYYY-MM-DD date');

export const filtersSchema = z
  .object({
    from: isoDate.default(WINDOW_FROM),
    to: isoDate.default(today),
    /** opt-in threshold on |amount| in integer pence, e.g. 50000 for "over £500". Applies to
     *  credits too: a -£12,000 credit note is kept, a -£3 reversal is not. Filtering positives
     *  only would drop every credit and push totals *up* (RDB: +£11.5m on one org_1). */
    min_pence: z.coerce.number().int().nonnegative().optional(),
  })
  .refine((f) => f.from <= f.to, { message: 'from must be <= to' });

export type Filters = z.infer<typeof filtersSchema>;

/** WHERE clause + params for the rows an aggregate includes. */
export function applied(f: Filters, on: DateColumn = 'date') {
  const where = [`${on} BETWEEN ? AND ?`];
  const params: (string | number)[] = [f.from, f.to];
  if (f.min_pence !== undefined) {
    where.push('abs(amount) >= ?');
    params.push(f.min_pence);
  }
  return { where: where.join(' AND '), params, window: { from: f.from, to: f.to, on } satisfies Window };
}

/** SELECT list computing Excluded over the unfiltered file; included + excluded = every row. */
export function excludedSelect(f: Filters, on: DateColumn = 'date') {
  const params: (string | number)[] = [f.from, f.to];
  let belowMin = '0';
  if (f.min_pence !== undefined) {
    belowMin = `count(*) FILTER (${on} BETWEEN ? AND ? AND (abs(amount) < ? OR amount IS NULL))`;
    params.push(f.from, f.to, f.min_pence);
  }
  return {
    sql: `count(*) FILTER (${on} IS NOT NULL AND ${on} NOT BETWEEN ? AND ?) AS out_of_window,
          count(*) FILTER (${on} IS NULL) AS null_date,
          ${belowMin} AS below_min`,
    params,
  };
}
