# LAPayments-UI

Backend + UI over the LAPayments serving layer: one Parquet file per council of
published supplier payments (UK Local Government Transparency Code). Full spec of
the data in [docs/serving-context.md](docs/serving-context.md).

## Data

`data/` is gitignored. Today it is symlinks into the local collection repo:

```
data/serving/             -> ~/LAPayments/serving/            {la_code}.parquet, one per council
data/serving_files.csv    -> ~/LAPayments/registers/serving_files.csv   catalogue: one row per council, sha256 = change key
data/councils_master.csv  -> ~/LAPayments/councils_master.csv           reference data, join on la_code
```

This is a dev shortcut, not the answer to how those files reach the repo (open
decision, see below). The S3 copy is byte-identical:
`aws s3 sync s3://lapayments-<account-id>/serving/ data/serving/`.

**Read convention:** the primary read path is one council's file,
`data/serving/{la_code}.parquet`. The glob `data/serving/*.parquet` is for
catalogue-wide aggregates only -- fine at 16 files, not at 382.

## Four things every consumer must know

1. `amount` is **signed integer pence** (£123.45 = 12345). Negatives are credits; zeros and nulls exist.
2. `amount_kind` (net/gross/unknown) and `date_kind` (paid/invoice/transaction/none) are **mixed**.
   Cross-council totals and monthly series must filter to one kind or label the kind on every figure.
3. Upstream does **no dedup, no threshold filter, no supplier normalisation**. Per the collection repo's profiling
   (against source columns not present in serving), 22% of rows are exact duplicates within their source file;
   2.6M sub-threshold rows, 17% redacted, spelling variants are separate suppliers. Every cleaning decision is ours.
4. **Dates are dirty**: 131k nulls, rows out to 2042. Every date axis needs a clamp policy and an excluded count.
   `date` for time series; `period_start`/`period_end` (the file label) for coverage.

## Running

```
npm install && npm --prefix web install
npm run dev        # API on http://localhost:3000 (tsx watch)
npm run web        # UI on http://localhost:5173, proxies /api to :3000
npm test           # node:test against the live data/ files
npm run typecheck  # server and web
```

Server: Node 24 + TypeScript, [Hono](https://hono.dev) on `@hono/node-server`, `@duckdb/node-api`.
Web (`web/`): Vite + React + Recharts, hash-routed (`#/` list, `#/SWK` council). Response
shapes are shared through `src/api-types.ts`, which has no runtime imports.

### API

All endpoints are under `/api`, rate limited per client IP (`src/ratelimit.ts`; 429 with
`Retry-After` once a client's burst is spent) except `/api/health`.
Successful responses carry `Cache-Control: public, max-age=300` (`src/cache.ts`), so a
browser reuses them for 5 minutes; after a weekly rebuild or a deploy it may show the
previous figures for up to that long. No ETags.

| Endpoint | Returns |
|---|---|
| `GET /councils` | every served council: `councils_master` ⋈ catalogue ⋈ `profile` |
| `GET /councils/:la` | one council, 404 if not in the catalogue |
| `GET /councils/:la/summary` | rows, sum, credits by `amount_kind` × `date_kind` |
| `GET /councils/:la/timeseries?by=month\|quarter\|year&key=date\|period` | one row per period × `amount_kind`; `key=period` buckets on the file label `period_start` |
| `GET /councils/:la/breakdown?dim=org_1\|exp_1\|…&top=N` | spend per value of one facet column; 400 if the council does not publish it; `unclassified` = rows with a null value |
| `GET /councils/:la/suppliers?top=N` | as-published supplier names ranked by \|sum\|; redacted rows as a separate bucket |

All four take the shared filters `from`, `to` (YYYY-MM-DD) and `min_pence`, read exactly one
Parquet file, and echo `window`, `min_pence` and `excluded` so no figure is unexplained.

### Web

Two screens. The council list is a table (19+ rows × many attributes) with the kind mix and
the §4 tells as badges. The council page has one filter row (date range, "only payments ≥ the
council's threshold", bucket, date-vs-period) that scopes everything below it: a tile per
`amount_kind` (payments and credits shown separately -- `credits_pence` is already inside
`sum_pence`), the spend chart, top suppliers and a breakdown by whichever hierarchy columns
the council publishes. Every card prints what was excluded and why.

Chart rules (see the `dataviz` skill): a single `amount_kind` -- 15 of 19 councils -- draws in
one hue with no legend; several stack with a fixed colour per kind (`net` blue, `gross` orange,
`unknown` de-emphasis grey; validated CVD-safe in light and dark), a legend, and the kind named
in the tooltip. A ranked supplier or category whose total mixes kinds is flagged inline. Every
chart has a table view. £ formatting is integer arithmetic on pence.

### Cleaning policy v1 (`src/policy.ts`)

| | Default | Override |
|---|---|---|
| Date window | `date BETWEEN 2015-04-01 AND today` (FY2015/16, when the Code became statutory). Rows outside are counted in `excluded.out_of_window`; null dates in `excluded.null_date` | `from`, `to` |
| Threshold | none -- the data is what was published | `min_pence=50000` for "over £500"; rows below counted in `excluded.below_min` |
| `amount_kind` / `date_kind` | never filtered; every figure is grouped by `amount_kind`, `date_kind` reported alongside | -- |
| Negatives | included (net of credits); `credits_pence` carries the negative part separately | -- |
| Redacted | in totals; out of supplier rankings, returned as `redacted` | -- |
| Duplicates, supplier spelling | untouched (`canonical: false` on suppliers) | later stages |

`profile` is computed per council file (never a glob) and cached on the council's catalogue
`sha256`: `coverage` (share of rows populated, per candidate facet column), `facets` (columns
the council publishes at all -- apply your own cut-off from `coverage`), `amount_kind` / `date_kind` mix, and the §4 tells (null / future /
pre-2008 dates; negative / zero / null amounts; redacted rows). Amounts in JSON are integer pence.

`src/db.ts` owns the one DuckDB connection, the JSON conversion policy (BIGINT → number,
DATE/TIMESTAMP → string), and `councilFile(la_code)`, which allowlists codes against the
catalogue before anything reaches the filesystem or SQL.

## Sanity / drift check

```
python3 scripts/sanity.py           # asserts each file against the catalogue; exit 1 on mismatch
python3 scripts/sanity.py --report  # also prints kind mix, trap counts, per-council column coverage
```

Needs Python `duckdb` (1.4.5 installed). Reads the catalogue first, then checks each
file individually -- a cross-file scan can straddle an in-place weekly rebuild.
`baseline/catalogue.csv` is a committed snapshot of the catalogue; the script reports
any council whose `sha256` has moved since (informational, exit 0). Once a rebuild is
confirmed expected, `python3 scripts/sanity.py --update-baseline` rewrites the snapshot.

## Open decisions (not yet made)

| # | Decision | Leaning |
|---|---|---|
| 1 | How `councils_master.csv` / `serving_files.csv` reach this repo | publish to `s3://…/serving/` from the collection side |
| 2 | Refresh trigger | poll catalogue `sha256` |
| 3 | Re-issue policy (both versions of a republished file are present) | defer; no council triggers it yet |
| 4 | Licence / attribution statement | blocker for any public deploy |
