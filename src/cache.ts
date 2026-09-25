// HTTP caching for /api. The data changes weekly, so a browser can reuse a successful
// response for MAX_AGE_S without asking again -- switching back and forth between councils
// or filters is then instant. Staleness is bounded by the same window: after a weekly
// rebuild or a deploy, a browser may show the previous figures for up to MAX_AGE_S.
// No ETag on purpose: revalidation would only help a view revisited after the window, and
// its validator would have to track the build, the date and the catalogue sha256.
// Only 200s are marked cacheable: a 404/429/503 must be retried, not reused.
import type { MiddlewareHandler } from 'hono';
import { intEnv } from './db.ts';

export const MAX_AGE_S = intEnv('LAP_CACHE_MAX_AGE_S', 300, 0);

export const cacheControl: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.status === 200) c.header('Cache-Control', `public, max-age=${MAX_AGE_S}`);
};
