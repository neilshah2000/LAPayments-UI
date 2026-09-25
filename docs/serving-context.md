# LAPayments serving data — context for the backend/UI repo

Written 2026-09-21 from the LAPayments collection repo. Everything load-bearing is inlined; nothing here
requires reading that repo. Figures are a snapshot of that date and will move (see "Snapshot caveats").

## 1. What the data is

The UK Local Government Transparency Code 2015 requires English councils to publish every supplier
payment over £500 (Scotland/Wales publish voluntarily). The collection repo lists, downloads and parses
those files for every principal council (382 in scope) and compacts each council's rows into one
Parquet file. Those per-council Parquet files are the **serving layer** this repo consumes.

Pipeline upstream (not this repo's concern, but explains the shape):
`list → download (raw/, content-addressed) → parse (parsed/, one Parquet per source file) → serving (one Parquet per council)`.

Rules baked into the parser and carried into serving, which the backend inherits:
**no dedup, no threshold filter, no re-slicing by date, no supplier normalisation.** One serving row =
one source row, as published. Every cleaning decision is deliberately left to the consumer.

## 2. Where the files are

| | Location | Notes |
|---|---|---|
| S3 | `s3://lapayments-<account-id>/serving/{la_code}.parquet` | us-east-1, private bucket, no versioning. Credentials from `~/.aws` (AWS CLI v2 profile). The collection repo uses only the `aws` CLI, no SDK. |
| Local (collection repo) | `serving/{la_code}.parquet` | gitignored, regenerable; byte-identical to S3 |
| Catalogue | `registers/serving_files.csv` in the collection repo (committed to git) | one row per council — see §5 |

Get a local copy (the local-first path is faster and simpler; ~150 MB today):

```
aws s3 sync s3://lapayments-<account-id>/serving/ ./data/serving/
```

Sibling prefixes `raw/` and `parsed/` exist in the same bucket. **Do not query `parsed/`** for normal
serving: it is the provenance layout (one object per source file, ~1,760 objects now, tens of thousands
at full scale) and S3 costs ~130 ms per object opened regardless of size. Read it only to drill into one
object by `sha256` when the verbatim `src_*` source columns are needed (they are stripped from serving).

Files are written through a `.part` temp file and renamed, so a reader never sees a partial file, but a
file is **replaced in place** on every rebuild (the one store that is not content-addressed). The
change key is `source_digest` / `sha256` in `serving_files.csv`.

## 3. File format

One Parquet per council, identical schema in every file (no `union_by_name` needed), 33 columns,
zstd, 100,000-row row groups, sorted by `(date ASC nulls last, sha256, source_row)`. The sort means
DuckDB prunes date-range predicates from row-group statistics — a quarter of a council reads 1–2 of
its ~15 row groups.

Measured locally: three aggregate queries (totals, group by kind, per-council coverage) over all 16
files / 15.6M rows / 149 MB in 0.37 s total. From S3 via httpfs, one council's quarter with a date and
amount predicate: 1.2 s cold.

Schema as DuckDB reports it (`DESCRIBE SELECT * FROM read_parquet('serving/*.parquet')`):

| Group | Column | DuckDB type | Meaning |
|---|---|---|---|
| provenance | `la_code` | VARCHAR | 3-letter council code, primary key to `councils_master.csv` (§6) |
| | `sha256` | VARCHAR | hash of the source file this row came from; key into `parsed/` and the registers |
| | `source_row` | INTEGER | 1-based record ordinal in the source file (incl. preamble/blank lines) |
| | `period_start`, `period_end` | DATE | the **file's label** (the month/quarter/year the council said it covers) — not the row's date |
| core | `date` | DATE | the row's date; nullable |
| | `date_kind` | VARCHAR | what `date` means in this file's era: `paid` / `invoice` / `transaction` / `none` |
| | `amount` | BIGINT | **signed integer pence**. £123.45 = 12345. Nullable |
| | `amount_kind` | VARCHAR | `gross` / `net` / `unknown` |
| | `vat` | BIGINT | pence, nullable (populated in ~20% of rows) |
| | `supplier` | VARCHAR | as published, whitespace/nbsp stripped, **not canonicalised** |
| | `supplier_id` | VARCHAR | council's own supplier reference, raw string; empty for half the councils |
| | `redacted` | BOOLEAN | supplier matched the council's redaction marker (e.g. "REDACTED", "Personal — Individual") |
| organisational hierarchy | `org_1` … `org_4` | VARCHAR | who spent it, top-down, as many levels as the council publishes |
| | `org_code` | VARCHAR | |
| economic hierarchy | `exp_1` … `exp_3` | VARCHAR | what was bought (expenditure category) |
| | `exp_code` | VARCHAR | |
| other categorisation | `cost_centre`, `cost_centre_desc`, `purpose`, `narrative`, `supplier_type` | VARCHAR | |
| | `capital_revenue` | VARCHAR | `capital` / `revenue` / NULL |
| | `std_cipfa`, `std_proclass`, `std_cpv` | VARCHAR | standard classification codes, only where published |
| identifiers | `invoice_ref`, `transaction_ref` | VARCHAR | |

All columns nullable. Level numbers (`org_1` vs `org_2`) are **comparable within a council only** —
one council's `org_1` is a directorate, another's is a service. A cross-council mapping onto a common
scheme does not exist yet; it is planned as a separate, revisable table over the parsed data, never in
parser code.

## 4. Traps — things a naive API/UI will get wrong

Ordered by how badly they mislead.

1. **Cross-council £ totals are not like-for-like.** `amount_kind` is mixed: of 15.6M rows, 6.0M are
   `net`, 0.6M `gross`, 9.0M `unknown`. A league table of "spend by council" that sums `amount` across
   councils compares net with gross. Either filter to one `amount_kind`, or surface the kind on every
   figure. Same for `date_kind` (`paid` 8.0M / `transaction` 5.5M / `invoice` 2.0M / `none` 0.1M): a
   "spend by month" chart mixes payment months with invoice months.
2. **Dates are dirty and unfiltered.** 131,768 null dates; 25 rows dated after today; 163 before 2008;
   council maxima of **2042-04-30 (EAL), 2039-11-30 (STN), 2036-03-06 (RDB)** — source typos, or a date
   form the parser read wrong; upstream treats them as a tell to investigate, not a filter, so they may
   change on a re-parse.
   Every date axis, "latest month", and default date range needs a policy (e.g. clamp to
   `[2010-04-01, today]` and show the excluded count). `period_start`/`period_end` are the file label
   and usually the better "which month is this" key for coverage views; `date` is the better key for
   time series. They disagree for rows published late or mislabelled.
3. **`amount` is signed pence.** 772,314 negative rows (credit notes, reversals), 225,935 zeros, 76
   nulls. Divide by 100 for display; decide whether net-of-credits or payments-only.
4. **Duplicates are kept.** Upstream counted **3.42M rows (22%) as exact duplicates** of an earlier row
   in the same file (identical across every source column). Some are genuine repeated payments, some
   are publishing errors; the pipeline cannot tell and does not remove them. Row counts are not
   "number of payments".
5. **Sub-threshold rows are kept.** 2.62M rows have `0 < amount < council's threshold`. Councils
   publish at £500 or £250 (`spend_threshold` in `councils_master.csv`), and some publish every
   payment with no threshold at all (`0`, e.g. Haringey); many above a threshold include everything too.
   "Payments over £500" needs a `WHERE amount >= 50000`.
6. **Suppliers are not canonical.** No normalisation anywhere in the pipeline. "Capita", "CAPITA
   BUSINESS SERVICES LTD", "Capita Business Services Limited" are three suppliers. 2.64M rows (17%)
   are `redacted = true`; 999 have an empty supplier. Any top-suppliers view fragments on spelling
   until this repo (or a later table) builds a canonical-name mapping.
7. **Re-issued files: both versions may be present.** When a council republishes a month under the
   same URL with different bytes, both objects are parsed and *both* go into the serving file; the
   catalogue row's `warnings` says `N file_url with >1 object: …`. Which version to serve is
   explicitly not decided upstream — the backend inherits that choice. No council carries this
   warning today, but it will happen. One case that is *not* a duplicate: the same bytes at two URLs
   (BEX April 2025) is read once.
8. **Column coverage differs per council** — see the matrix in §7. An API that offers a "cost centre"
   facet must know it is empty for 12 of 16 councils.

## 5. Catalogue: `serving_files.csv` (one row per council)

The natural source for a `/councils` endpoint and for cache invalidation. Columns:

| Column | Meaning |
|---|---|
| `la_code` | |
| `built_at` | `YYYY-MM-DDTHH:MM` |
| `objects` | source files compacted |
| `rows` | rows in the Parquet (= sum over source files, checked) |
| `first_date`, `last_date` | min/max of non-null `date` — out-of-range values here are the same tell, not a filter |
| `size_bytes`, `sha256` | of the serving Parquet — **the change key**: if unchanged, the file is byte-identical |
| `source_digest` | sha256 over the sorted (source sha256, parser_version) pairs — changes when a file is added, removed or re-parsed |
| `parser_versions` | distinct parser versions among the sources, space-separated |
| `warnings` | re-issue / repeat notes as in §4.7 |

Snapshot 2026-09-21 (16 councils, all London; 15,644,045 rows; 149 MB total):

```
la_code  objects   rows     first_date  last_date   size_bytes  parser_versions
BDG      110       585064   2017-01-03  2026-06-30  5809348     1.3
BEN      25        434100   2020-03-02  2026-06-30  4059593     1.3
BEX      113       1009320  2002-06-22  2026-07-31  11916574    1.3   (1 object registered under >1 row, read once)
BNE      149       1970307  2013-04-02  2026-07-31  17971205    1.3
BRY      53        245982   2022-04-01  2026-08-28  2732261     1.3
EAL      158       1366138  1998-06-07  2042-04-30  15253480    1.4
HIL      196       780132   2010-10-01  2026-08-28  5693241     1.3
LEW      150       917039   2014-08-05  2026-07-31  5981135     1.3
LND      24        85360    2024-04-02  2026-03-31  857231      1.3
MRT      90        708281   1999-11-15  2026-09-01  9049579     1.3
NWM      101       2441128  2018-04-02  2026-08-31  13121152    1.3
RDB      196       2581312  2000-10-15  2036-03-06  29395458    1.3
RIC      90        202774   2019-01-02  2026-07-31  1095936     1.3
STN      97        440623   2000-07-01  2039-11-30  5153064     1.3
SWK      186       1463191  2014-11-01  2026-05-30  16926767    1.3
WSM      21        413294   2021-04-01  2026-06-30  3472681     1.3
```

## 6. Council reference data: `councils_master.csv`

Lives in the collection repo (root, hand-maintained, committed). The UI will need it for names, region,
type, population and threshold. Relevant columns (28 in total):

| Column | Example | Notes |
|---|---|---|
| `la_code` | `SWK` | **primary key**, stable; join on this, never on names |
| `official_name` | `London Borough of Southwark` | |
| `short_name` | `Southwark` | display |
| `gss_code` | `E09000028` | current ONS code — join key to ONS/MHCLG data |
| `nation`, `region` | `England`, `London` | |
| `body_type` | `LBO` | `NMD` `UA` `MD` `LBO` `CC` `CTY` `SCO` `WPA` `NID` `COMB` `SRA` |
| `tier` | `unitary` | `upper` / `lower` / `unitary` / `combined` / `regional` |
| `county_la` | | parent county `la_code` for two-tier districts |
| `population` | `318000` | for per-head figures |
| `spend_threshold` | `250` | £ threshold the council actually publishes at: 500, 250, or 0 for no threshold (publishes every payment) |
| `spend_page_url` | | the transparency page scraped |
| `homepage_url` | | |
| `in_scope`, `is_current`, `start_date`, `end_date`, `replaced_by` | | 382 of 470 rows in scope; abolished bodies keep a row |

Conventions: UTF-8 CSV, ISO dates, `TRUE`/`FALSE`, unknown = empty string. Only councils with a
`serving_files.csv` row have data; the master has 470 rows.

The 16 served councils today: BDG Barking and Dagenham, BEN Brent, BEX Bexley, BNE Barnet (£250),
BRY Bromley, EAL Ealing (£250), HIL Hillingdon, LEW Lewisham (£250), LND City of London (`CC`),
MRT Merton, NWM Newham (£250), RDB Redbridge, RIC Richmond upon Thames, STN Sutton, SWK Southwark
(£250), WSM Westminster. All `LBO` except LND; all region `London`.

## 7. Per-council column coverage (rows with a non-null value, 2026-09-21)

The spec for a capability-aware API: which facets/filters each council can support.

```
la    rows     £m(sum)  org_1    exp_1    supplier_id  cost_centre  narrative  std_proclass  invoice_ref
BDG   585064   7908.5   582808   585064   0            451207       0          0             0
BEN   434100   4950.9   0        434100   0            434100       0          0             0
BEX   1009320  5783.3   840901   1002711  999021       63906        0          0             0
BNE   1970307  9451.0   1950784  1832482  0            0            0          0             1307442
BRY   245982   3704.9   245978   200029   38979        0            0          0             0
EAL   1366138  6765.4   1364179  1363058  707984       93877        142        0             58407
HIL   780132   10648.3  766140   780129   0            0            0          0             0
LEW   917039   11558.4  485299   917039   0            0            0          0             0
LND   85360    1135.8   85360    85360    0            0            0          0             0
MRT   708281   6460.5   688746   699625   372579       9639         225649     0             372579
NWM   2441128  7242.5   2441128  2441128  0            0            0          0             0
RDB   2581312  6727.8   2581247  2581312  694405       2581312      0          2581312       0
RIC   202774   2886.6   202774   202774   1293         0            0          0             0
STN   440623   2748.0   440596   440623   112712       0            0          0             0
SWK   1463191  16756.4  1218838  1218832  945843       0            0          0             0
WSM   413294   5771.8   413294   234998   413294       0            0          0             0
```

`£m(sum)` is the raw signed sum across mixed `amount_kind`s — illustrative only (§4.1).
`std_cipfa`, `std_cpv`, `supplier_type`, `capital_revenue`, `purpose` were not profiled here; query them
the same way (`SELECT la_code, count(col) FROM read_parquet(...) GROUP BY 1`).

## 8. Reading with DuckDB

```sql
-- local mirror
SELECT la_code, count(*), sum(amount)/100.0 AS gbp
FROM read_parquet('serving/*.parquet') GROUP BY 1;

-- straight from S3 (verified 2026-09-21 with DuckDB 1.4.5 and ~/.aws credentials)
INSTALL httpfs; LOAD httpfs;
CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION 'us-east-1');
SELECT * FROM read_parquet('s3://lapayments-<account-id>/serving/SWK.parquet')
WHERE date BETWEEN '2025-04-01' AND '2025-06-30' AND amount >= 50000;
```

Notes:
- `read_parquet('serving/*.parquet')` unions all councils with no schema reconciliation.
- Predicates on `date` prune row groups (files are sorted by it). Predicates on `supplier` do not —
  the file is not sorted or partitioned by supplier; a supplier index/summary table is this repo's job.
- Sync strategy question for this repo (open, see §9): copy the Parquet files locally on a schedule
  keyed on `serving_files.csv` `sha256`, versus query S3 directly with httpfs. Local was 0.37 s for
  a 16-file full scan; S3 pays per-file latency but the files are few and large by design.
- Amounts: `amount / 100.0` for £; keep integer pence in any summary tables.

## 9. Open questions — decisions for the repo owner, not the agent

1. **How does `councils_master.csv` reach this repo?** It is hand-maintained in the collection repo.
   Options: copy it in (goes stale), publish it to `s3://…/serving/councils_master.csv` from the
   collection side (needs a change there), or read it from the collection repo's GitHub raw URL.
2. **How does `serving_files.csv` reach this repo?** Same question; it is the catalogue and the change
   key. Today it exists only in the collection repo's git.
3. **Refresh cadence and trigger.** The collection side runs a weekly container
   (`scripts/weekly_update.py`) that rebuilds a council's serving file whenever it has new or re-parsed
   objects and replaces the S3 object in place. Nothing notifies downstream. Poll `serving_files.csv`
   `sha256`, or S3 `ETag`/`LastModified`, or add an S3 event later.
4. **Cleaning policy** for §4 items 1–7 — filter defaults, whether to build derived summary tables
   (per council × month × supplier) in this repo, and where a supplier-canonicalisation table would live.
5. **Re-issue policy** (§4.7): serve latest object per `file_url`, or both with a flag.
6. **Licence / attribution.** Council spend data is generally published under the Open Government
   Licence, but this has not been checked per council; a public UI republishing it needs a statement.
7. **Node DuckDB binding.** `@duckdb/node-api` is the current official binding; `duckdb` (node) and
   `duckdb-async` are the older generation. Pick before writing the first query.

## 10. Snapshot caveats and scale

- Figures above are from 2026-09-21 mid-build-out. EAL is at parser version 1.4, the other 15 at 1.3;
  a deferred cross-council re-parse (`PARSE_DEFER_RECHECK`) is owed and will change `source_digest`
  (and possibly rows) for every council when it lands. Treat the numbers as shape, not contract.
- 16 of 382 in-scope councils are served today (all London). At full scale expect ~25× the rows
  (roughly 350–400M) and ~3–4 GB of Parquet, still one file per council (1–30 MB each today; the
  largest English counties will be larger). Design queries to touch one council's file where possible.
- ~45 councils need a headed browser to collect (Cloudflare/Akamai), so their coverage will lag.
- Parquet reading: `pyarrow` output is deterministic; `sha256` in the catalogue is of the file bytes.
