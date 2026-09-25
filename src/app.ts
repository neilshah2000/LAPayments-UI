import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { zValidator as zv } from '@hono/zod-validator';
import type { ZodType } from 'zod';
import { getCouncil, listCouncils } from './councils.ts';
import { isMissingData, query, UnknownCouncil } from './db.ts';
import { filtersSchema } from './policy.ts';
import { cacheControl } from './cache.ts';
import { rateLimit } from './ratelimit.ts';
import {
  breakdown, breakdownSchema, summary, suppliers, suppliersSchema,
  timeseries, timeseriesSchema, UnsupportedFacet,
} from './aggregates.ts';

// Query-string validation with a compact error body instead of the default ZodError dump.
const zValidator = <T extends ZodType>(target: 'query', schema: T) =>
  zv(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: 'invalid query', issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        400,
      );
    }
  });

// Each aggregate takes the shared filters (from, to, min_pence) plus its own options,
// both from the query string. Everything lives under /api so the built web/ app can be
// served from the same origin later.
export const api = new Hono()
  // Touches the catalogue on purpose: a health check that cannot fail is a health check
  // that keeps a broken task in service. It catches DuckDB or the catalogue source going
  // unreachable after startup. It says nothing about the boot warm -- server.ts awaits
  // listCouncils() before serve(), so until that finishes the port is not listening at all
  // and a checker gets a refused connection. The health check grace period is the only
  // lever there; size it against the warm, which grows with the number of councils.
  .get('/health', async (c) => {
    const [r] = await query('SELECT count(*) AS councils FROM catalogue');
    return c.json({ ok: true, councils: r.councils as number });
  })
  // Registered after /health on purpose: Hono runs handlers in registration order and /health
  // returns without calling next(), so ALB health checks never spend a client's tokens and
  // are never marked cacheable.
  .use('*', rateLimit)
  .use('*', cacheControl)
  .get('/councils', async (c) => c.json(await listCouncils()))
  .get('/councils/:la', async (c) => {
    const council = await getCouncil(c.req.param('la'));
    return council ? c.json(council) : c.json({ error: 'unknown council' }, 404);
  })
  .get('/councils/:la/summary', zValidator('query', filtersSchema), async (c) =>
    c.json(await summary(c.req.param('la'), c.req.valid('query'))),
  )
  .get('/councils/:la/timeseries', zValidator('query', filtersSchema.and(timeseriesSchema)), async (c) => {
    const q = c.req.valid('query');
    return c.json(await timeseries(c.req.param('la'), q, q));
  })
  .get('/councils/:la/breakdown', zValidator('query', filtersSchema.and(breakdownSchema)), async (c) => {
    const q = c.req.valid('query');
    return c.json(await breakdown(c.req.param('la'), q, q));
  })
  .get('/councils/:la/suppliers', zValidator('query', filtersSchema.and(suppliersSchema)), async (c) => {
    const q = c.req.valid('query');
    return c.json(await suppliers(c.req.param('la'), q, q));
  })
  .onError((err, c) => {
    if (err instanceof UnknownCouncil) return c.json({ error: err.message }, 404);
    if (err instanceof UnsupportedFacet) return c.json({ error: err.message }, 400);
    // Catalogued but its file is not readable: the council exists, the data does not (yet).
    // 503, not 500 -- it is transient and a caller should retry rather than treat it as a bug.
    if (isMissingData(err)) {
      console.error(err);
      return c.json({ error: 'council data unavailable', retryable: true }, 503);
    }
    console.error(err);
    return c.json({ error: 'internal error' }, 500);
  });

// /api first, then the built web/ app from the same origin -- no CORS, and the SPA is
// hash-routed so there is no deep-link rewrite to configure. serveStatic's root is
// cwd-relative by design; the image sets WORKDIR to match.
export const app = new Hono()
  .route('/api', api)
  .use('/*', serveStatic({ root: process.env.LAP_WEB_DIR ?? './web/dist' }));
export type Api = typeof api;
