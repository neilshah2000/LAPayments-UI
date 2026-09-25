// Response shapes of the /api endpoints. No runtime imports: this file is shared with web/.

export const FACET_COLUMNS = [
  'org_1', 'org_2', 'org_3', 'org_4', 'org_code',
  'exp_1', 'exp_2', 'exp_3', 'exp_code',
  'supplier_id', 'cost_centre', 'cost_centre_desc', 'purpose', 'narrative', 'supplier_type',
  'capital_revenue', 'std_cipfa', 'std_proclass', 'std_cpv', 'invoice_ref', 'transaction_ref', 'vat',
] as const;
export type FacetColumn = (typeof FACET_COLUMNS)[number];

export interface CouncilProfile {
  rows: number;
  /** share of rows (0-1) with a non-null value, per facet column */
  coverage: Record<FacetColumn, number>;
  /** facet columns this council publishes at all (coverage > 0) */
  facets: FacetColumn[];
  amount_kind: Record<string, number>;
  date_kind: Record<string, number>;
  /** the §4.2 tells -- counts, not filters */
  dates: { null: number; future: number; pre_2008: number };
  amounts: { negative: number; zero: number; null: number; redacted: number };
}

/** Why a catalogued council has no profile. The catalogue is the source of truth and can
 *  legitimately run ahead of the object store (a rebuild publishes the catalogue row before
 *  the Parquet file lands), so this is a transient state that is reported, never hidden. */
export interface Unavailable {
  reason: string;
}

export interface Council {
  la_code: string;
  official_name: string;
  short_name: string;
  gss_code: string;
  nation: string;
  region: string;
  body_type: string;
  tier: string;
  population: number | null;
  spend_threshold: number | null;
  spend_page_url: string | null;
  homepage_url: string | null;
  // catalogue
  built_at: string;
  objects: number;
  rows: number;
  first_date: string | null;
  last_date: string | null;
  size_bytes: number;
  sha256: string;
  source_digest: string;
  parser_versions: string;
  warnings: string | null;
  /** null when the council's file could not be read -- see `unavailable` */
  profile: CouncilProfile | null;
  unavailable?: Unavailable;
}

/** Which column the window constrains: the row's own date, or the file label. */
export type DateColumn = 'date' | 'period_start';

export interface Window {
  from: string;
  to: string;
  on: DateColumn;
}

export interface Excluded {
  /** non-null window column outside [from, to] */
  out_of_window: number;
  /** window column is null */
  null_date: number;
  /** |amount| < min_pence or amount null (only when min_pence given) */
  below_min: number;
}

export interface Kinded {
  amount_kind: string;
  rows: number;
  sum_pence: number;
  /** sum of the negative amounts only (credit notes, reversals); <= 0. Already inside sum_pence. */
  credits_pence: number;
}

/** A ranked value (supplier, org_1, ...): totals across kinds plus the per-kind split.
 *  by_kind.length > 1 means the total mixes amount kinds -- the UI should say so. */
export interface Ranked {
  rows: number;
  sum_pence: number;
  credits_pence: number;
  by_kind: Kinded[];
}

export interface AggregateBase {
  la_code: string;
  window: Window;
  min_pence: number | null;
  excluded: Excluded;
}

export interface Summary extends AggregateBase {
  by_kind: (Kinded & { date_kind: string })[];
}

export type TimeseriesBy = 'month' | 'quarter' | 'year';
export type TimeseriesKey = 'date' | 'period';

export interface Timeseries extends AggregateBase {
  by: TimeseriesBy;
  key: TimeseriesKey;
  /** one row per period x amount_kind; date_kind mix inside a period is reported as a list */
  series: (Kinded & { period: string; date_kinds: string[] })[];
}

export interface Breakdown extends AggregateBase {
  dim: FacetColumn;
  /** rows in the window with a null value for dim, so `values` is known to be partial */
  unclassified: Kinded[];
  values: (Ranked & { value: string })[];
}

export interface Suppliers extends AggregateBase {
  /** names are as published -- not canonicalised; spelling variants rank separately */
  canonical: false;
  redacted: Kinded[];
  suppliers: (Ranked & { supplier: string; first: string; last: string })[];
}
