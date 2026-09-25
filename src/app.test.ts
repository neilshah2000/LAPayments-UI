import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from './app.ts';
import { close, query } from './db.ts';
import type { Council } from './councils.ts';

after(close);

const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
};

// Invariants only. Council-specific figures are a snapshot that moves with every weekly
// rebuild -- those belong in scripts/sanity.py and baseline/, not here.
test('GET /councils lists every catalogued council with a profile', async () => {
  const catalogue = (await query('SELECT la_code, rows FROM catalogue ORDER BY la_code')) as { la_code: string; rows: number }[];
  const { status, body } = await get('/api/councils');
  assert.equal(status, 200);
  const councils = body as Council[];
  assert.deepEqual(councils.map((c) => c.la_code), catalogue.map((c) => c.la_code));
  for (const c of councils) {
    // A catalogued council whose file cannot be read stays in the list, carrying the reason:
    // the catalogue is the source of truth and may run ahead of the object store.
    if (!c.profile) {
      assert.ok(c.unavailable?.reason, `${c.la_code}: no profile, so it must say why`);
      continue;
    }
    assert.equal(c.profile.rows, c.rows, `${c.la_code}: profile rows must equal catalogue rows`);
    assert.equal(
      Object.values(c.profile.amount_kind).reduce((a, b) => a + b, 0),
      c.rows,
      `${c.la_code}: amount_kind counts partition the rows`,
    );
    assert.equal(typeof c.parser_versions, 'string');
    assert.equal(typeof c.sha256, 'string');
    assert.ok(Number.isInteger(c.population));
    for (const f of c.profile.facets) assert.ok(c.profile.coverage[f] > 0);
  }
});

test('profile matches a direct query of the same file (§7 coverage, §4 tells)', async () => {
  const [{ la_code }] = await query('SELECT la_code FROM catalogue ORDER BY rows LIMIT 1'); // smallest file
  const { status, body } = await get(`/api/councils/${la_code}`);
  assert.equal(status, 200);
  const c = body as Council;
  assert.ok(c.profile, `${la_code} is read straight from data/, so it must profile`);
  const [direct] = await query(`
    SELECT count(org_1) / count(*) AS org_1, count(narrative) / count(*) AS narrative,
      count(*) FILTER (date > current_date) AS future, count(*) FILTER (amount < 0) AS negative
    FROM read_parquet('data/serving/${la_code}.parquet')`);
  assert.equal(c.profile.coverage.org_1, direct.org_1);
  assert.equal(c.profile.coverage.narrative, direct.narrative);
  assert.equal(c.profile.dates.future, direct.future);
  assert.equal(c.profile.amounts.negative, direct.negative);
  assert.equal(c.profile.facets.includes('org_1'), (direct.org_1 as number) > 0);
  // future-dated rows are a tell that is reported, never filtered
  assert.equal(c.profile.dates.future > 0, (c.last_date as string) > new Date().toISOString().slice(0, 10));
});

test('unknown or malformed council codes are 404', async () => {
  assert.equal((await get('/api/councils/ZZZ')).status, 404);
  assert.equal((await get('/api/councils/..%2F..%2Fetc')).status, 404);
  assert.equal((await get('/api/councils/swk')).status, 404, 'codes are upper-case only');
});
