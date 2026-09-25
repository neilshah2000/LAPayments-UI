import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { app } from './app.ts';
import { close } from './db.ts';
import { RATE_BURST, RATE_PER_MIN, resetRateLimits, take } from './ratelimit.ts';

after(close);
beforeEach(resetRateLimits);

test('a burst is allowed, then the client waits for the refill', () => {
  const t = 1_000_000;
  for (let i = 0; i < RATE_BURST; i++) assert.equal(take('a', t), 0);
  const wait = take('a', t);
  assert.ok(wait > 0 && wait <= Math.ceil(60 / RATE_PER_MIN), `wait ${wait}s`);
  assert.equal(take('b', t), 0, 'buckets are per client');
  assert.equal(take('a', t + 60_000 / RATE_PER_MIN), 0, 'one token back after one refill interval');
});

test('/api returns 429 with Retry-After once spent, keyed on the rightmost X-Forwarded-For', async () => {
  const headers = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' };
  for (let i = 0; i < RATE_BURST; i++) take('10.0.0.1');
  const res = await app.request('/api/councils/NOPE', { headers });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  // A forged left-hand entry does not buy a fresh bucket.
  const forged = await app.request('/api/councils/NOPE', { headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' } });
  assert.equal(forged.status, 429);
});

test('/api/health is never rate limited', async () => {
  for (let i = 0; i < RATE_BURST + 5; i++) take('10.0.0.2');
  const res = await app.request('/api/health', { headers: { 'x-forwarded-for': '10.0.0.2' } });
  assert.equal(res.status, 200);
});
