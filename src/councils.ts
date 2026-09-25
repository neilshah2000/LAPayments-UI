// GET /councils source: councils_master ⋈ catalogue ⋈ per-council profile.
//
// The profile (facet coverage, amount_kind / date_kind mix, date-quality tells) is computed
// one council file at a time and cached on that council's catalogue sha256, so a rebuild of
// one council re-profiles only that council. Nothing here scans serving/*.parquet.
import { councilParquet, intEnv, isMissingData, query, refreshCatalogue, type Row } from './db.ts';
import { FACET_COLUMNS, type Council, type CouncilProfile, type FacetColumn, type Unavailable } from './api-types.ts';

export { FACET_COLUMNS, type Council, type CouncilProfile, type FacetColumn, type Unavailable };

// Columns a UI might offer as a facet/filter. `facets` lists the ones this council publishes
// at all (any non-null row); `coverage` gives the share so the UI can apply its own cut-off
// (MRT narrative is 32%, EAL narrative is 0.01%). See docs/serving-context.md §4.8, §7.
const profileCache = new Map<string, { sha256: string; profile: CouncilProfile }>();

// A council whose file cannot be read is remembered separately and retried on an interval,
// not cached for the life of the process: the usual cause is the catalogue running ahead of
// the object store during a rebuild, which resolves itself once the file lands. One such
// council must not take the other 21 down with it -- see listCouncils().
export const PROFILE_RETRY_MS = intEnv('LAP_PROFILE_RETRY_MS', 60_000, 0);
const profileFailures = new Map<string, { sha256: string; reason: string; at: number }>();

type ProfileResult = { profile: CouncilProfile } | { unavailable: Unavailable };

export async function profileCouncil(la_code: string): Promise<CouncilProfile> {
  const src = await councilParquet(la_code);
  const counts = FACET_COLUMNS.map((c) => `count(${c}) AS "${c}"`).join(', ');
  const [r] = await query(`
    SELECT count(*) AS rows, ${counts},
      count(*) FILTER (date IS NULL) AS d_null,
      count(*) FILTER (date > current_date) AS d_future,
      count(*) FILTER (date < DATE '2008-01-01') AS d_pre2008,
      count(*) FILTER (amount < 0) AS a_neg,
      count(*) FILTER (amount = 0) AS a_zero,
      count(*) FILTER (amount IS NULL) AS a_null,
      count(*) FILTER (redacted) AS redacted
    FROM ${src}`);
  const kinds = await query(`
    SELECT 'amount' AS which, amount_kind AS kind, count(*) AS n FROM ${src} GROUP BY ALL
    UNION ALL
    SELECT 'date', date_kind, count(*) FROM ${src} GROUP BY ALL`);

  const rows = r.rows as number;
  const coverage = Object.fromEntries(
    FACET_COLUMNS.map((c) => [c, rows ? (r[c] as number) / rows : 0]),
  ) as Record<FacetColumn, number>;
  const mix = (which: string) =>
    Object.fromEntries(kinds.filter((k) => k.which === which).map((k) => [String(k.kind ?? 'null'), k.n as number]));

  return {
    rows,
    coverage,
    facets: FACET_COLUMNS.filter((c) => coverage[c] > 0),
    amount_kind: mix('amount'),
    date_kind: mix('date'),
    dates: { null: r.d_null as number, future: r.d_future as number, pre_2008: r.d_pre2008 as number },
    amounts: { negative: r.a_neg as number, zero: r.a_zero as number, null: r.a_null as number, redacted: r.redacted as number },
  };
}

async function cachedProfile(la_code: string, sha256: string): Promise<ProfileResult> {
  const hit = profileCache.get(la_code);
  if (hit && hit.sha256 === sha256) return { profile: hit.profile };

  const failed = profileFailures.get(la_code);
  if (failed && failed.sha256 === sha256 && Date.now() - failed.at < PROFILE_RETRY_MS) {
    return { unavailable: { reason: failed.reason } };
  }

  try {
    const profile = await profileCouncil(la_code);
    profileCache.set(la_code, { sha256, profile });
    profileFailures.delete(la_code);
    return { profile };
  } catch (err) {
    if (!isMissingData(err)) throw err; // a real bug still fails loudly
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    profileFailures.set(la_code, { sha256, reason, at: Date.now() });
    console.error(`profile ${la_code}: unavailable -- ${reason}`);
    return { unavailable: { reason } };
  }
}

const MASTER_COLS =
  'official_name, short_name, gss_code, nation, region, body_type, tier, population, spend_threshold, spend_page_url, homepage_url';
const CATALOGUE_COLS =
  'built_at, objects, rows, first_date, last_date, size_bytes, sha256, source_digest, parser_versions, warnings';

function toCouncil(r: Row, result: ProfileResult): Council {
  const base = r as unknown as Omit<Council, 'profile' | 'unavailable'>;
  return 'profile' in result ? { ...base, profile: result.profile } : { ...base, profile: null, ...result };
}

// Inner join: a served council missing from councils_master would vanish from the list.
// scripts/sanity.py asserts that never happens.
export async function listCouncils(): Promise<Council[]> {
  await refreshCatalogue();
  const rows = await query(`
    SELECT c.la_code, ${MASTER_COLS}, ${CATALOGUE_COLS}
    FROM catalogue c JOIN councils_master m USING (la_code)
    ORDER BY c.la_code`);
  return Promise.all(rows.map(async (r) => toCouncil(r, await cachedProfile(r.la_code as string, r.sha256 as string))));
}

export async function getCouncil(la_code: string): Promise<Council | undefined> {
  await refreshCatalogue();
  const [r] = await query(
    `SELECT c.la_code, ${MASTER_COLS}, ${CATALOGUE_COLS}
     FROM catalogue c JOIN councils_master m USING (la_code) WHERE c.la_code = ?`,
    [la_code],
  );
  return r && toCouncil(r, await cachedProfile(r.la_code as string, r.sha256 as string));
}
