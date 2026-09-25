#!/usr/bin/env python3
"""Drift check for the serving data in data/ (see docs/serving-context.md).

Reads the catalogue first, then checks each council's Parquet file against its
catalogue row one file at a time -- never a cross-file glob, which can straddle
an in-place weekly rebuild. Exits non-zero on any mismatch.

  python3 scripts/sanity.py                    # assertions only
  python3 scripts/sanity.py --report           # also print the profile tables
  python3 scripts/sanity.py --update-baseline  # rewrite baseline/catalogue.csv from the live catalogue
"""
import hashlib, sys
from pathlib import Path
import duckdb

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
BASELINE = ROOT / "baseline" / "catalogue.csv"
EXPECTED_COLS = 33
IN_SCOPE = 382
BASELINE_COLS = "la_code, rows, size_bytes, sha256, source_digest, parser_versions"  # by name, not position

con = duckdb.connect()
fails = []

def check(ok, msg):
    if not ok:
        fails.append(msg)
        print(f"FAIL  {msg}")

def sha256(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while b := f.read(chunk):
            h.update(b)
    return h.hexdigest()

# 1. catalogue first
cat = con.sql(f"SELECT * FROM read_csv('{DATA}/serving_files.csv') ORDER BY la_code").fetchall()
cols = [d[0] for d in con.sql(f"SELECT * FROM read_csv('{DATA}/serving_files.csv') LIMIT 0").description]
cat = [dict(zip(cols, r)) for r in cat]
print(f"catalogue: {len(cat)} councils")

# catalogue <-> files, both directions
files = {p.stem for p in (DATA / "serving").glob("*.parquet")}
listed = {c["la_code"] for c in cat}
check(files == listed, f"catalogue/file mismatch: only in files {files - listed}, only in catalogue {listed - files}")

# 2. per-file checks against the catalogue row
for c in cat:
    la = c["la_code"]
    f = DATA / "serving" / f"{la}.parquet"
    if not f.exists():
        continue
    ncols = len(con.sql(f"SELECT * FROM read_parquet('{f}') LIMIT 0").description)
    check(ncols == EXPECTED_COLS, f"{la}: {ncols} columns, expected {EXPECTED_COLS}")
    check(f.stat().st_size == c["size_bytes"], f"{la}: size {f.stat().st_size} != catalogue {c['size_bytes']}")
    check(sha256(f) == c["sha256"], f"{la}: sha256 differs from catalogue (file rebuilt after catalogue written?)")
    rows, first, last, las = con.sql(
        f"SELECT count(*), min(date), max(date), count(DISTINCT la_code) FROM read_parquet('{f}')").fetchone()
    check(rows == c["rows"], f"{la}: {rows} rows != catalogue {c['rows']}")
    check(first == c["first_date"] and last == c["last_date"],
          f"{la}: date range {first}..{last} != catalogue {c['first_date']}..{c['last_date']}")
    check(las == 1, f"{la}: file contains {las} distinct la_code values")
    print(f"ok    {la}  {rows:>9,} rows  {first} .. {last}  v{c['parser_versions']}")

# 3. reference data
n = con.sql(f"SELECT count(*) FROM read_csv('{DATA}/councils_master.csv') WHERE in_scope").fetchone()[0]
check(n == IN_SCOPE, f"councils_master in_scope = {n}, expected {IN_SCOPE}")
missing = con.sql(f"""SELECT list(la_code) FROM read_csv('{DATA}/serving_files.csv')
    WHERE la_code NOT IN (SELECT la_code FROM read_csv('{DATA}/councils_master.csv'))""").fetchone()[0]
check(not missing, f"served councils missing from councils_master: {missing}")

# 4. refresh or diff against committed baseline
if "--update-baseline" in sys.argv:
    con.sql(f"COPY (SELECT {BASELINE_COLS} FROM read_csv('{DATA}/serving_files.csv') ORDER BY la_code) "
            f"TO '{BASELINE}' (HEADER)")
    print(f"baseline: rewritten {BASELINE.relative_to(ROOT)}")
# diff against committed baseline (informational: the data is allowed to move, but say so)
if BASELINE.exists():
    diff = con.sql(f"""
        SELECT coalesce(l.la_code, b.la_code) la_code,
               CASE WHEN b.la_code IS NULL THEN 'new'
                    WHEN l.la_code IS NULL THEN 'removed'
                    WHEN l.sha256 <> b.sha256 THEN 'rebuilt' END AS change,
               b.rows AS rows_baseline, l.rows AS rows_now,
               b.parser_versions AS pv_baseline, l.parser_versions AS pv_now,
               l.source_digest <> b.source_digest AS sources_changed
        FROM read_csv('{DATA}/serving_files.csv') l FULL JOIN read_csv('{BASELINE}') b USING (la_code)
        WHERE change IS NOT NULL ORDER BY 1""").fetchall()
    if diff:
        print(f"\nDRIFT vs baseline/catalogue.csv ({len(diff)} councils) -- if expected, run with --update-baseline:")
        for r in diff:
            print("   ", r)
    else:
        print("baseline: no drift")

# 5. optional profile report
if "--report" in sys.argv:
    P = f"read_parquet('{DATA}/serving/*.parquet')"
    for title, sql in [
        ("amount_kind", f"SELECT amount_kind, count(*) n FROM {P} GROUP BY 1 ORDER BY 2 DESC"),
        ("date_kind", f"SELECT date_kind, count(*) n FROM {P} GROUP BY 1 ORDER BY 2 DESC"),
        ("traps", f"""SELECT count(*) FILTER (date IS NULL) null_dates, count(*) FILTER (date > current_date) future,
            count(*) FILTER (date < '2008-01-01') pre2008, count(*) FILTER (amount < 0) negative,
            count(*) FILTER (amount = 0) zero, count(*) FILTER (redacted) redacted FROM {P}"""),
        ("coverage", f"""SELECT la_code, count(org_1) org_1, count(exp_1) exp_1, count(supplier_id) supplier_id,
            count(cost_centre) cost_centre, count(narrative) narrative, count(std_proclass) std_proclass,
            count(invoice_ref) invoice_ref, count(capital_revenue) cap_rev, count(purpose) purpose
            FROM {P} GROUP BY 1 ORDER BY 1"""),
    ]:
        print(f"\n== {title} ==")
        print(con.sql(sql).to_df().to_string(index=False))

print(f"\n{len(fails)} failure(s)")
sys.exit(1 if fails else 0)
