import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { listCouncils } from './councils.ts';
import { close } from './db.ts';

const port = Number(process.env.PORT ?? 3000);

// Backstop, not a substitute for handling: an unhandled rejection anywhere would otherwise
// exit the process, and this one takes ~2 minutes to warm before it can serve again. A
// single bad request must not cost that. Anything reaching here is a bug -- it is logged in
// full so it is findable, and the service stays up.
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));

// Warm the per-council profiles so the first /councils request is not a 16-file scan.
// A council whose file is missing is reported and skipped, never fatal: the catalogue can
// run ahead of the object store during a rebuild, and one absent file must not keep the
// other 21 councils off the air (which, with the warm ahead of serve(), means the port
// never opening and a deploy that restart-loops).
// LAP_SKIP_WARM opens the port immediately and lets profiles compute lazily on first use.
// Nothing depends on the warm for correctness -- it only front-loads work the first
// /councils request would otherwise do. Use it when what you are testing is the
// infrastructure (image pull, task role, S3 reach, logging) rather than the data, so an
// iteration costs seconds instead of the full warm.
if (process.env.LAP_SKIP_WARM) {
  console.log('LAP_SKIP_WARM set -- profiles will be computed on demand');
} else {
  const t = performance.now();
  const councils = await listCouncils();
  const missing = councils.filter((c) => c.unavailable);
  console.log(`profiled ${councils.length - missing.length}/${councils.length} councils in ${Math.round(performance.now() - t)} ms`);
  for (const c of missing) console.warn(`  unavailable: ${c.la_code} -- ${c.unavailable?.reason}`);
}

const server = serve({ fetch: app.fetch, port }, (info) => console.log(`listening on http://localhost:${info.port}`));

// ECS sends SIGTERM on task stop and SIGKILLs after the grace period. Nothing here buffers
// writes -- DuckDB is :memory: and every read is idempotent -- so this only needs to stop
// accepting, drop the connection and exit 0, so an ordinary deploy is not logged as a crash.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`${sig}: shutting down`);
    server.close(() => void close().then(() => process.exit(0)));
  });
}
