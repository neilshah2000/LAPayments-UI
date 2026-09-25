import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { app } from './app.ts';
import { close, query } from './db.ts';
import { WINDOW_FROM, today } from './policy.ts';
import type { Breakdown, Summary, Suppliers, Timeseries } from './aggregates.ts';

after(close);

const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
};
const sum = (xs: { sum_pence: number }[]) => xs.reduce((a, x) => a + x.sum_pence, 0);
const rows = (xs: { rows: number }[]) => xs.reduce((a, x) => a + x.rows, 0);

// Reconcile against councils that exercise the traps, chosen from the catalogue rather than
// hardcoded: the smallest file (fast, clean), the one with the most null dates (coverage
// view), and one with mixed amount_kind (ranking / nesting). Duplicates collapse.
const cases: { label: string; la: string }[] = [];
before(async () => {
  const pick = async (label: string, sql: string) => {
    const [{ la_code }] = (await query(sql)) as { la_code: string }[];
    if (!cases.some((c) => c.la === la_code)) cases.push({ label, la: la_code });
  };
  await pick('smallest', 'SELECT la_code FROM catalogue ORDER BY rows LIMIT 1');
  await pick('most null dates', `
    SELECT la_code FROM (
      SELECT la_code, count(*) FILTER (date IS NULL) AS n FROM read_parquet('data/serving/*.parquet') GROUP BY 1
    ) ORDER BY n DESC LIMIT 1`);
  await pick('mixed amount_kind', `
    SELECT la_code FROM (
      SELECT la_code, count(DISTINCT amount_kind) AS k, count(*) AS n FROM read_parquet('data/serving/*.parquet') GROUP BY 1
    ) WHERE k > 1 ORDER BY n LIMIT 1`);
});

// node:test needs the cases at definition time, so drive them from a runtime loop inside one test each.
async function forEachCase(fn: (la: string, src: string, label: string) => Promise<void>) {
  assert.ok(cases.length >= 2, 'expected at least two distinct reconciliation councils');
  for (const c of cases) await fn(c.la, `read_parquet('data/serving/${c.la}.parquet')`, c.label);
}

describe('aggregates reconcile to direct queries', () => {
  test('summary: included + excluded partition the file; sums match', () =>
    forEachCase(async (la, src, label) => {
      const { status, body } = await get(`/api/councils/${la}/summary`);
      assert.equal(status, 200, label);
      const s = body as Summary;
      assert.deepEqual(s.window, { from: WINDOW_FROM, to: today(), on: 'date' });
      const [d] = await query(
        `SELECT count(*) FILTER (date BETWEEN ? AND ?) AS rows,
                coalesce(sum(amount) FILTER (date BETWEEN ? AND ?), 0) AS sum_pence,
                count(*) FILTER (date IS NULL) AS null_date,
                count(*) FILTER (date IS NOT NULL AND date NOT BETWEEN ? AND ?) AS out_of_window,
                count(*) AS total
         FROM ${src}`,
        [s.window.from, s.window.to, s.window.from, s.window.to, s.window.from, s.window.to],
      );
      assert.equal(rows(s.by_kind), d.rows, `${la} rows`);
      assert.equal(sum(s.by_kind), d.sum_pence, `${la} sum`);
      assert.equal(s.excluded.null_date, d.null_date, `${la} null_date`);
      assert.equal(s.excluded.out_of_window, d.out_of_window, `${la} out_of_window`);
      assert.equal(s.excluded.below_min, 0);
      assert.equal(rows(s.by_kind) + s.excluded.null_date + s.excluded.out_of_window, d.total, `${la} partition`);
      for (const k of s.by_kind) assert.ok(k.credits_pence <= 0);
    }));

  test('summary with min_pence: threshold is on |amount|, so large credits are kept', () =>
    forEachCase(async (la, src) => {
      const { body } = await get(`/api/councils/${la}/summary?from=2024-04-01&to=2025-03-31&min_pence=50000`);
      const s = body as Summary;
      const [d] = await query(
        `SELECT count(*) FILTER (date BETWEEN '2024-04-01' AND '2025-03-31' AND abs(amount) >= 50000) AS rows,
                count(*) FILTER (date BETWEEN '2024-04-01' AND '2025-03-31' AND (abs(amount) < 50000 OR amount IS NULL)) AS below_min,
                count(*) FILTER (date BETWEEN '2024-04-01' AND '2025-03-31') AS in_window,
                coalesce(sum(amount) FILTER (date BETWEEN '2024-04-01' AND '2025-03-31' AND amount <= -50000), 0) AS big_credits
         FROM ${src}`,
      );
      assert.equal(rows(s.by_kind), d.rows, la);
      assert.equal(s.excluded.below_min, d.below_min, la);
      assert.equal(rows(s.by_kind) + s.excluded.below_min, d.in_window, `${la}: in-window rows partition into kept + below_min`);
      assert.equal(s.min_pence, 50000);
      // credits of |amount| >= threshold survive the filter and still show up in credits_pence
      assert.equal(s.by_kind.reduce((a, k) => a + k.credits_pence, 0), d.big_credits, `${la}: credits >= threshold kept`);
    }));

  test('timeseries key=date sums to the summary; periods inside the window; unique sorted keys', () =>
    forEachCase(async (la) => {
      const [{ body: sb }, { body: tb }] = await Promise.all([get(`/api/councils/${la}/summary`), get(`/api/councils/${la}/timeseries?by=month`)]);
      const s = sb as Summary;
      const t = tb as Timeseries;
      assert.equal(t.window.on, 'date');
      assert.equal(sum(t.series), sum(s.by_kind), la);
      assert.equal(rows(t.series), rows(s.by_kind), la);
      for (const p of t.series) {
        assert.match(p.period, /^\d{4}-\d{2}$/);
        assert.ok(p.period >= WINDOW_FROM.slice(0, 7) && p.period <= today().slice(0, 7), `${la} ${p.period}`);
        assert.ok(p.date_kinds.length >= 1);
      }
      const keys = t.series.map((p) => `${p.period}|${p.amount_kind}`);
      assert.deepEqual(keys, [...new Set(keys)].sort());
    }));

  test('timeseries key=period windows on period_start and keeps null-date rows', () =>
    forEachCase(async (la, src) => {
      const { body } = await get(`/api/councils/${la}/timeseries?key=period&by=year`);
      const t = body as Timeseries;
      assert.equal(t.window.on, 'period_start');
      const [d] = await query(
        `SELECT count(*) FILTER (period_start BETWEEN ? AND ?) AS rows,
                coalesce(sum(amount) FILTER (period_start BETWEEN ? AND ?), 0) AS sum_pence,
                count(*) FILTER (period_start BETWEEN ? AND ? AND date IS NULL) AS null_date_kept,
                count(*) FILTER (period_start IS NULL) AS null_period,
                count(*) AS total
         FROM ${src}`,
        [t.window.from, t.window.to, t.window.from, t.window.to, t.window.from, t.window.to],
      );
      assert.equal(rows(t.series), d.rows, `${la}: null-date rows with a period label are kept (${d.null_date_kept})`);
      assert.equal(sum(t.series), d.sum_pence, la);
      assert.equal(t.excluded.null_date, d.null_period, `${la}: excluded.null_date counts null period_start`);
      assert.equal(rows(t.series) + t.excluded.null_date + t.excluded.out_of_window, d.total, `${la} partition`);
      for (const p of t.series) assert.match(p.period, /^\d{4}$/);
    }));

  test('breakdown: top N is N values (kinds nested); values + unclassified reconcile; bad dims 400', () =>
    forEachCase(async (la, src) => {
      const { body: cb } = await get(`/api/councils/${la}`);
      const facets = (cb as { profile: { facets: string[] } }).profile.facets;
      const dim = facets.find((f) => f.startsWith('org_') || f.startsWith('exp_'));
      assert.ok(dim, `${la} has a hierarchy facet`);
      const [{ body: sb }, { status, body: bb }] = await Promise.all([get(`/api/councils/${la}/summary`), get(`/api/councils/${la}/breakdown?dim=${dim}&top=500`)]);
      assert.equal(status, 200);
      const b = bb as Breakdown;
      const s = sb as Summary;
      const values = b.values.map((v) => v.value);
      assert.deepEqual(values, [...new Set(values)], `${la}: one entry per value`);
      assert.ok(values.length <= 500);
      for (const v of b.values) {
        assert.equal(v.rows, rows(v.by_kind));
        assert.equal(v.sum_pence, sum(v.by_kind));
      }
      const [d] = await query(`SELECT count(DISTINCT ${dim}) AS n FROM ${src} WHERE date BETWEEN ? AND ?`, [b.window.from, b.window.to]);
      if ((d.n as number) <= 500) {
        assert.equal(sum(b.values) + sum(b.unclassified), sum(s.by_kind), `${la} sum`);
        assert.equal(rows(b.values) + rows(b.unclassified), rows(s.by_kind), `${la} rows`);
      }
      const mags = b.values.map((x) => Math.abs(x.sum_pence));
      assert.deepEqual(mags, [...mags].sort((a, c) => c - a), `${la}: ranked by |total|`);
      const unsupported = ['org_1', 'exp_1', 'narrative', 'std_proclass', 'cost_centre'].find((f) => !facets.includes(f));
      if (unsupported) {
        const r = await get(`/api/councils/${la}/breakdown?dim=${unsupported}`);
        assert.equal(r.status, 400);
        assert.match((r.body as { error: string }).error, /does not publish/);
      }
    }));

  test('suppliers: top N suppliers, redacted separate, kinds nested and totalled', () =>
    forEachCase(async (la, src) => {
      const { body } = await get(`/api/councils/${la}/suppliers?top=10`);
      const sp = body as Suppliers;
      assert.equal(sp.canonical, false);
      assert.ok(sp.suppliers.length <= 10);
      const names = sp.suppliers.map((x) => x.supplier);
      assert.deepEqual(names, [...new Set(names)], `${la}: one entry per supplier`);
      const [d] = await query(`SELECT count(*) AS redacted FROM ${src} WHERE date BETWEEN ? AND ? AND redacted`, [sp.window.from, sp.window.to]);
      assert.equal(rows(sp.redacted), d.redacted, la);
      // the #1 supplier's total and split must match a direct query
      const top = sp.suppliers[0];
      const direct = await query(
        `SELECT amount_kind, count(*) AS rows, sum(amount) AS sum_pence FROM ${src}
         WHERE date BETWEEN ? AND ? AND supplier = ? GROUP BY 1 ORDER BY 1`,
        [sp.window.from, sp.window.to, top.supplier],
      );
      assert.equal(top.sum_pence, sum(direct as { sum_pence: number }[]), `${la} ${top.supplier}`);
      assert.deepEqual(top.by_kind.map((k) => k.amount_kind).sort(), direct.map((r) => r.amount_kind));
      const mags = sp.suppliers.map((x) => Math.abs(x.sum_pence));
      assert.deepEqual(mags, [...mags].sort((a, c) => c - a));
      for (const x of sp.suppliers) {
        assert.ok(x.supplier.length > 0);
        assert.ok(x.first <= x.last);
      }
    }));

  test('mixed-kind case actually mixes', () => {
    const mixed = cases.find((c) => c.label === 'mixed amount_kind');
    assert.ok(mixed, 'catalogue should contain a mixed amount_kind council');
    return (async () => {
      const { body } = await get(`/api/councils/${mixed.la}/summary`);
      assert.ok(new Set((body as Summary).by_kind.map((k) => k.amount_kind)).size > 1);
    })();
  });
});

test('query validation and unknown councils on every aggregate', async () => {
  const la = cases[0].la;
  assert.equal((await get(`/api/councils/${la}/summary?from=2020-13-01`)).status, 400);
  assert.equal((await get(`/api/councils/${la}/summary?from=2020-02-30`)).status, 400);
  assert.equal((await get(`/api/councils/${la}/summary?from=2025-01-01&to=2024-01-01`)).status, 400);
  assert.equal((await get(`/api/councils/${la}/summary?min_pence=-1`)).status, 400);
  assert.equal((await get(`/api/councils/${la}/timeseries?by=week`)).status, 400);
  assert.equal((await get(`/api/councils/${la}/breakdown?dim=supplier`)).status, 400);
  assert.equal((await get(`/api/councils/${la}/suppliers?top=0`)).status, 400);
  for (const ep of ['summary', 'timeseries', 'breakdown?dim=org_1', 'suppliers']) {
    assert.equal((await get(`/api/councils/ZZZ/${ep}`)).status, 404, ep);
  }
});
