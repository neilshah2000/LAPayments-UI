import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { app } from './app.ts';
import { close } from './db.ts';

after(close);

test('successful /api responses are cacheable, errors and health are not', async () => {
  const ok = await app.request('/api/councils');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('cache-control') ?? '', /^public, max-age=\d+$/);

  const missing = await app.request('/api/councils/NOPE/summary');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), null);

  const health = await app.request('/api/health');
  assert.equal(health.headers.get('cache-control'), null, 'a cached health check would hide an outage');
});
