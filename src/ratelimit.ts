// Per-client rate limit on /api, in memory, one token bucket per client IP.
//
// The aggregates scan whole council files (LBH /suppliers is ~1.6s), so one script looping
// over them can make the service slow for everyone. A bucket rather than a fixed window
// because real use is bursty: a council page is 5 requests on load and 4 more on every
// filter change, and a date input fires on each step. The burst absorbs that; the refill
// rate is what a script cannot exceed.
//
// Per task, not global: with 1-2 tasks behind the ALB a client gets at most that multiple.
// Good enough for an alpha; WAF or a shared store is the next step if it is not.
import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { intEnv } from './db.ts';

/** Requests a client can make at once before being throttled. */
export const RATE_BURST = intEnv('LAP_RATE_BURST', 120);
/** Sustained requests per minute once the burst is spent. */
export const RATE_PER_MIN = intEnv('LAP_RATE_PER_MIN', 120);

type Bucket = { tokens: number; at: number; limited: boolean };
const buckets = new Map<string, Bucket>();

// A full bucket carries no information, so drop it; keeps the map bounded by active clients.
const FULL_AFTER_MS = (RATE_BURST / RATE_PER_MIN) * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.at >= FULL_AFTER_MS) buckets.delete(ip);
}, 60_000).unref();

// Behind the ALB every connection comes from the load balancer, so the client is in
// X-Forwarded-For. The ALB APPENDS the address it saw, so the rightmost entry is the one it
// vouches for; anything to its left was sent by the client and can be forged. Without the
// header (local dev, app.request in tests) fall back to the socket.
export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',').at(-1)!.trim();
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // no Node socket, e.g. app.request()
  }
}

/** Take one token for `ip`; returns seconds until one is available if there are none. */
export function take(ip: string, now = Date.now()): number {
  const b = buckets.get(ip) ?? { tokens: RATE_BURST, at: now, limited: false };
  b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.at) / 60_000) * RATE_PER_MIN);
  b.at = now;
  buckets.set(ip, b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    b.limited = false;
    return 0;
  }
  // Log the transition into limited, not every rejected request, so a flood cannot flood the logs.
  if (!b.limited) console.warn(`rate limited: ${ip}`);
  b.limited = true;
  return Math.ceil(((1 - b.tokens) / RATE_PER_MIN) * 60);
}

export function resetRateLimits(): void {
  buckets.clear();
}

export const rateLimit: MiddlewareHandler = async (c, next) => {
  const wait = take(clientIp(c));
  if (wait > 0) {
    c.header('Retry-After', String(wait));
    return c.json({ error: 'too many requests -- try again in a few seconds', retryable: true }, 429);
  }
  await next();
};
