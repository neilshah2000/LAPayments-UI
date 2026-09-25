// Single DuckDB instance over the serving layer (see docs/serving-context.md).
//
// Read convention: one council = one file, {DATA_DIR}/serving/{la_code}.parquet, resolved
// through councilFile() which allowlists la_code against the catalogue. The glob over
// every file is deliberately not exposed here.
//
// DATA_DIR is either a local directory (dev: data/ symlinks) or an object-store prefix
// ("s3://bucket", deployed). Everything below works against both; the only differences are
// how a child path is joined and whether httpfs/aws get loaded.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.LAP_DATA_DIR ?? path.join(ROOT, 'data');
// serving_files.csv and councils_master.csv may or may not sit beside the Parquet files
// (README open decision #1 is still open). Default: beside them, as in dev.
export const CATALOGUE_DIR = process.env.LAP_CATALOGUE_DIR ?? DATA_DIR;
// serving_files.csv alone can be read from somewhere else: the weekly job publishes it to
// s3://…/registers/, but councils_master.csv is hand-maintained and stays baked in. Pointing
// this at S3 is what lets a rebuild reach the app on the catalogue TTL, with no redeploy.
export const REGISTERS_DIR = process.env.LAP_REGISTERS_DIR ?? CATALOGUE_DIR;

const REMOTE_URI = /^[a-z][a-z0-9+.-]*:\/\//i;

export function isRemote(base: string): boolean {
  return REMOTE_URI.test(base);
}

// path.join() eats the "//" in "s3://bucket" and yields "s3:/bucket", so joining a child
// path has to be scheme-aware. Local paths still go through path.join.
export function joinData(base: string, ...parts: string[]): string {
  return isRemote(base) ? [base.replace(/\/+$/, ''), ...parts].join('/') : path.join(base, ...parts);
}

const sqlLit = (s: string): string => s.replaceAll("'", "''");

// Number('b') is NaN and Math.max(1, NaN) is NaN, so an unparsable value used to propagate
// silently: a NaN pool size built an empty pool and every request waited forever on a
// connection that could never be released. A typo in a tuning knob must not be able to do
// that, so every numeric setting comes through here -- warn loudly, fall back to the default.
export function intEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    console.warn(`${name}="${raw}" is not a number >= ${min}; using ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

// Nothing about the runtime is left to detection: inside a container DuckDB's defaults are
// derived from what it can see of the host, which is not the task's cgroup limit -- an
// over-committed memory_limit is an OOM kill (exit 137), not a spill. temp_directory
// likewise defaults to ".tmp", relative to cwd, which fails on a read-only root filesystem.
function instanceConfig(): Record<string, string> {
  const cfg: Record<string, string> = {};
  const { LAP_MEMORY_LIMIT, LAP_THREADS, LAP_TEMP_DIR, DUCKDB_EXTENSION_DIR } = process.env;
  if (LAP_MEMORY_LIMIT) cfg.memory_limit = LAP_MEMORY_LIMIT;
  if (LAP_THREADS) cfg.threads = LAP_THREADS;
  if (LAP_TEMP_DIR) cfg.temp_directory = LAP_TEMP_DIR;
  if (DUCKDB_EXTENSION_DIR) cfg.extension_directory = DUCKDB_EXTENSION_DIR;
  return cfg;
}

/** How often the s3 secret is re-issued. Must be comfortably inside the credential lifetime
 *  the environment hands out. STS AssumeRole DurationSeconds has a documented minimum of 900s
 *  (15 min) and a maximum of 43200s (12h), default 3600s; AWS does not publish what ECS vends.
 *  5 minutes is inside even the shortest session STS can issue, and the cost is one request to
 *  a link-local endpoint. */
export const SECRET_REFRESH_MS = intEnv('LAP_SECRET_REFRESH_MS', 5 * 60_000, 1000);

/** Connections in the read pool. DuckDB serialises statements on a single connection, so
 *  one connection made Promise.all in listCouncils() look concurrent while the queries
 *  actually queued -- the cost was queueing, not S3 latency.
 *
 *  Boot warm, 29 councils over S3, 1 vCPU:
 *    pool 1  178.0s     pool 8   43.1s
 *    pool 16  43.7s     pool 32  43.1s
 *  4x at 8, then flat -- past that the limit is elsewhere (CPU / DuckDB's own threads),
 *  so raising it buys nothing. The work is I/O bound on range reads, which is why the
 *  pool can usefully exceed the core count at all. */
export const POOL_SIZE = intEnv('LAP_POOL_SIZE', 8);

let instance: DuckDBInstance | undefined;
let ddl: DuckDBConnection | undefined; // DDL only -- catalogue loads and the s3 secret
let pool: DuckDBConnection[] = [];
let idle: DuckDBConnection[] = [];
let waiters: ((c: DuckDBConnection) => void)[] = [];
let opening: Promise<DuckDBConnection> | undefined;
let secretTimer: NodeJS.Timeout | undefined;

// Hand out a connection, queueing when all are busy. Bounded by POOL_SIZE so a burst of
// requests cannot open unbounded connections.
async function acquire(): Promise<DuckDBConnection> {
  await db();
  const free = idle.pop();
  if (free) return free;
  return new Promise((resolve) => waiters.push(resolve));
}

function release(con: DuckDBConnection): void {
  const next = waiters.shift();
  if (next) next(con);
  else idle.push(con);
}

// REGION is pinned only when set explicitly; otherwise the chain resolves it as the AWS CLI does.
async function createSecret(con: DuckDBConnection): Promise<void> {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const opts = ['TYPE s3', 'PROVIDER credential_chain', ...(region ? [`REGION '${sqlLit(region)}'`] : [])];
  await con.run(`CREATE OR REPLACE SECRET lap (${opts.join(', ')})`);
}

/** The DDL connection, opening the instance and pool on first call. */
export function db(): Promise<DuckDBConnection> {
  if (ddl) return Promise.resolve(ddl);
  return (opening ??= open());
}

async function open(): Promise<DuckDBConnection> {
  instance = await DuckDBInstance.create(':memory:', instanceConfig());
  const con = await instance.connect();
  // Extensions are baked into the image (scripts/install-extensions.mjs). Autoinstall is on
  // by default and would silently fetch httpfs from extensions.duckdb.org on the first
  // s3:// read -- which succeeds in dev and black-holes on a task without egress, at request
  // time rather than at boot. Off, so a missing extension fails here, loudly.
  await con.run('SET autoinstall_known_extensions = false');
  await con.run('SET autoload_known_extensions = false');
  if (isRemote(DATA_DIR) || isRemote(CATALOGUE_DIR) || isRemote(REGISTERS_DIR)) {
    await con.run('LOAD httpfs');
    await con.run('LOAD aws');
    await createSecret(con);
    // credential_chain resolves ONCE, when the secret is created, and caches the result --
    // measured: a fake ECS credential endpoint is called exactly once no matter how long the
    // process runs, and `REFRESH auto` did not change that. ECS task-role credentials expire
    // (STS sessions are 15 min to 12 h), so without this the service works for a while and
    // then starts failing with 403s.
    // Re-issuing the secret does force a fresh fetch, so do that well inside the lifetime.
    secretTimer = setInterval(() => {
      createSecret(con).catch((err) => console.error('s3 credential refresh failed:', err));
    }, SECRET_REFRESH_MS);
    secretTimer.unref(); // never keep the process alive on this alone
  }
  ddl = con;
  // Extensions, secrets and the catalogue tables all live on the instance, so pool
  // connections inherit them and need no setup of their own. Opened after the secret
  // exists: a concurrent CREATE SECRET from several connections is a write-write conflict.
  pool = await Promise.all(Array.from({ length: POOL_SIZE }, () => instance!.connect()));
  idle = [...pool];
  await loadCatalogue(con, true);
  return con;
}

// --- catalogue -----------------------------------------------------------------------

// catalogue and councils_master are TABLES, not views over the CSVs. servedCodes() runs on
// every councilFile() call, and a view re-reads its file on every query -- one HTTP request
// per API request once the CSVs are remote. Reloaded on a TTL instead, which keeps the
// property the view was there for: a council added by the weekly rebuild appears without a
// restart, just within LAP_CATALOGUE_TTL_MS rather than instantly.
export const CATALOGUE_TTL_MS = intEnv('LAP_CATALOGUE_TTL_MS', 60_000, 0);
let loadedAt = 0;
let reloading: Promise<void> | undefined;

// `initial` distinguishes the two cases: without a catalogue at startup there is nothing to
// serve, so that failure is fatal. A later refresh that fails leaves the previous tables in
// place (CREATE OR REPLACE is atomic), so the service keeps serving slightly stale data and
// retries on the next TTL -- much better than failing a user's request.
async function loadCatalogue(con: DuckDBConnection, initial = false): Promise<void> {
  try {
    await loadCatalogueTables(con);
    loadedAt = Date.now();
  } catch (err) {
    if (initial) throw err;
    console.error('catalogue refresh failed, keeping the previous one:', err);
  }
}

async function loadCatalogueTables(con: DuckDBConnection): Promise<void> {
  // parser_versions is a space-separated list ("1.3 1.4"); stop the sniffer reading "1.4" as a DOUBLE
  await con.run(
    `CREATE OR REPLACE TABLE catalogue AS SELECT * FROM read_csv('${sqlLit(joinData(REGISTERS_DIR, 'serving_files.csv'))}', types = {'parser_versions': 'VARCHAR', 'warnings': 'VARCHAR'})`,
  );
  await con.run(
    `CREATE OR REPLACE TABLE councils_master AS SELECT * FROM read_csv('${sqlLit(joinData(CATALOGUE_DIR, 'councils_master.csv'))}')`,
  );
}

/** Reload the catalogue if it is older than the TTL. Concurrent callers share one reload. */
export async function refreshCatalogue(force = false): Promise<void> {
  const con = await db();
  if (!force && Date.now() - loadedAt < CATALOGUE_TTL_MS) return;
  // On the DDL connection, never a pooled one: CREATE OR REPLACE TABLE while pool
  // connections are mid-read is the one place writes and reads meet.
  reloading ??= loadCatalogue(con).finally(() => {
    reloading = undefined;
  });
  await reloading;
}

// --- queries --------------------------------------------------------------------------

// JSON conversion policy, decided once: BIGINT -> number (all magnitudes here are far
// below 2^53; amounts stay integer pence), DATE/TIMESTAMP -> ISO-ish string as DuckDB
// prints it, everything else as-is.
export type Row = Record<string, unknown>;

export function plain(v: DuckDBValue): unknown {
  if (typeof v === 'bigint') {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`BIGINT ${v} exceeds Number.MAX_SAFE_INTEGER`);
    }
    return Number(v);
  }
  if (v !== null && typeof v === 'object') return String(v);
  return v;
}

export async function query(sql: string, params: DuckDBValue[] = []): Promise<Row[]> {
  const con = await acquire();
  try {
    const stmt = await con.prepare(sql);
    stmt.bind(params);
    const result = await stmt.runAndReadAll();
    return result.getRowObjects().map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])));
  } finally {
    release(con); // must return the connection even when the query throws, or the pool drains
  }
}

// --- council files -------------------------------------------------------------------

const LA_CODE = /^[A-Z]{3}$/;

// Served la_codes, from the catalogue table, refreshed on the TTL above.
export async function servedCodes(): Promise<Set<string>> {
  await refreshCatalogue();
  const rows = await query('SELECT la_code FROM catalogue');
  return new Set(rows.map((r) => r.la_code as string));
}

export class UnknownCouncil extends Error {
  readonly la_code: string;
  constructor(la_code: string) {
    super(`unknown council: ${la_code}`);
    this.la_code = la_code;
  }
}

// Absolute path or URI for one council's Parquet file, or UnknownCouncil. Allowlisted
// against the catalogue -- never derived from user input by sanitising.
export async function councilFile(la_code: string): Promise<string> {
  if (!LA_CODE.test(la_code) || !(await servedCodes()).has(la_code)) throw new UnknownCouncil(la_code);
  return joinData(DATA_DIR, 'serving', `${la_code}.parquet`);
}

// SQL fragment reading one council's file. Path is from councilFile() so it is safe to inline.
export async function councilParquet(la_code: string): Promise<string> {
  return `read_parquet('${sqlLit(await councilFile(la_code))}')`;
}

// True for the error DuckDB raises when a council's Parquet file is not where the
// catalogue says it is. Heuristic on the message on purpose: DuckDB does not expose a
// structured code here, and the alternative -- a HEAD request before every read -- costs a
// round trip on the happy path. Over-matching turns a 500 into a 503, which is the safer
// direction; the message is logged either way.
export function isMissingData(err: unknown): boolean {
  const m = err instanceof Error ? err.message : '';
  return /HTTP 404|No files found|IO Error: Cannot open file|NoSuchKey/i.test(m);
}

export async function close(): Promise<void> {
  if (secretTimer) clearInterval(secretTimer);
  secretTimer = undefined;
  for (const con of pool) con.closeSync();
  ddl?.closeSync();
  instance?.closeSync();
  pool = [];
  idle = [];
  waiters = [];
  ddl = undefined;
  instance = undefined;
  opening = undefined;
  loadedAt = 0;
}
