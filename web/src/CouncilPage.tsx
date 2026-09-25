import { useMemo, useState } from 'react';
import { api, type Council, type Excluded, type FacetColumn, type Filters, type Kinded, type Ranked, type TimeseriesBy, type TimeseriesKey } from './api.ts';
import { useFetch } from './useFetch.ts';
import { gbp, gbpShort, int } from './format.ts';
import { KindBadges } from './Kinds.tsx';
import { SpendChart } from './SpendChart.tsx';
import { Info } from './Info.tsx';

const WINDOW_FROM = '2015-04-01';
const today = () => new Date().toISOString().slice(0, 10);

// Default window: the statutory floor → today, narrowed to where this council has data, so a
// council that starts in 2024 does not open on nine empty years. Clamped rather than taken
// as-is because first_date/last_date are the file's extremes and include junk (EAL spans
// 1998 → 2042): a stray early date falls back to the floor, a future one to today.
function defaultWindow(c: Council): { from: string; to: string } {
  const first = c.first_date?.slice(0, 10);
  const last = c.last_date?.slice(0, 10);
  const t = today();
  return {
    from: first && first > WINDOW_FROM ? first : WINDOW_FROM,
    to: last && last < t ? last : t,
  };
}

export function CouncilPage({ la }: { la: string }) {
  const council = useFetch(() => api.council(la), [la]);
  // One filter row scopes every card below it.
  // Unset until the user picks a date; until then each council gets its own default window.
  const [fromSet, setFrom] = useState<string>();
  const [toSet, setTo] = useState<string>();
  const [overThreshold, setOverThreshold] = useState(false);
  const [by, setBy] = useState<TimeseriesBy>('month');
  const [key, setKey] = useState<TimeseriesKey>('date');
  const [dim, setDim] = useState<FacetColumn | ''>('');

  // useFetch keeps the previous council's data while the next one loads; wait for THIS one,
  // or the aggregates would fire once with the previous council's window and then again.
  const c = council.data?.la_code === la ? council.data : undefined;
  const win = c ? defaultWindow(c) : undefined;
  const from = fromSet ?? win?.from ?? WINDOW_FROM;
  const to = toSet ?? win?.to ?? today();
  const filters: Filters = useMemo(
    () => ({ from, to, min_pence: overThreshold && c?.spend_threshold ? c.spend_threshold * 100 : undefined }),
    [from, to, overThreshold, c?.spend_threshold],
  );
  const fkey = JSON.stringify(filters);

  const ready = !!c;
  const summary = useFetch(() => (ready ? api.summary(la, filters) : Promise.resolve(undefined)), [la, fkey, ready]);
  const series = useFetch(() => (ready ? api.timeseries(la, filters, by, key) : Promise.resolve(undefined)), [la, fkey, by, key, ready]);
  const suppliers = useFetch(() => (ready ? api.suppliers(la, filters) : Promise.resolve(undefined)), [la, fkey, ready]);
  const hierarchy = c?.profile?.facets.filter((f) => /^(org|exp)_\d$|^cost_centre$|^capital_revenue$|^supplier_type$/.test(f)) ?? [];
  const effDim = dim || hierarchy[0] || '';
  const breakdown = useFetch(() => (ready && effDim ? api.breakdown(la, filters, effDim) : Promise.resolve(undefined)), [la, fkey, effDim, ready]);

  if (council.error) return <p className="error">{council.error.message} — <a href="#/">back</a></p>;
  if (!c) return <p className="sub">Loading…</p>;

  // OGL attribution: link the council's own publication, falling back to its homepage.
  const source = c.spend_page_url ?? c.homepage_url;

  return (
    <>
      <a className="crumb" href="#/">← All councils</a>
      <h1>{c.official_name}</h1>
      <p className="sub">
        {int(c.rows)} rows · {c.first_date} → {c.last_date} · {c.spend_threshold === 0 ? 'publishes all payments (no threshold)' : `publishes at £${c.spend_threshold}`} · {c.objects} source files · built {c.built_at}
        {c.profile && <>{' · '}amounts <KindBadges kinds={c.profile.amount_kind} /> dates <KindBadges kinds={c.profile.date_kind} swatch={false} /></>}
        {source && <>{' · '}Source: <a href={source}>{c.short_name ?? c.official_name}'s spending data</a></>}
      </p>
      {/* The catalogue lists this council but its file could not be read -- usually the
          catalogue running ahead of the object store during a rebuild. Everything below
          will fail until it lands, so say so once, here, rather than in every card. */}
      {!c.profile && (
        <p className="error">
          This council is in the catalogue but its data file could not be read, so the figures
          below are unavailable. This usually resolves once the current rebuild finishes.
          {c.unavailable && <><br /><span className="sub">{c.unavailable.reason}</span></>}
        </p>
      )}

      <div className="card filters">
        <Info>
          <p><b>Filters.</b> Every section below is computed on this one slice of the council's file, so the numbers always agree with each other.</p>
          <p><b>From / To</b> default to this council's first and last payment, but never before April 2015 (when publishing became statutory) or after today. Rows outside are counted in each section's footer, never silently dropped.</p>
          {c.spend_threshold ? <p><b>£{c.spend_threshold}+</b> is the council's own publishing threshold, applied to the size of the amount so credit notes of £{c.spend_threshold}+ are kept too.</p> : null}
          <p><b>Date from</b>: "each row's date" is the payment/invoice date on the row; "the file's period label" is the month the council said the file covers. They differ for late-published or undated rows.</p>
        </Info>
        <label>From<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        {/* A council with no threshold (0) publishes everything, so there is nothing to filter to. */}
        {c.spend_threshold ? (
          <label className="check">
            <input type="checkbox" checked={overThreshold} onChange={(e) => setOverThreshold(e.target.checked)} />
            only rows of £{c.spend_threshold}+ (payments or credits)
          </label>
        ) : null}
        <label>Bucket<select value={by} onChange={(e) => setBy(e.target.value as TimeseriesBy)}>
          <option value="month">month</option><option value="quarter">quarter</option><option value="year">year</option>
        </select></label>
        <label>Date from<select value={key} onChange={(e) => setKey(e.target.value as TimeseriesKey)}>
          <option value="date">each row's date</option><option value="period">the file's period label</option>
        </select></label>
      </div>

      {summary.error && <p className="error">{summary.error.message}</p>}
      {summary.data && <Kpis by_kind={summary.data.by_kind} busy={summary.busy} threshold={c.spend_threshold} />}

      <div className={`card${series.busy ? ' busy' : ''}`}>
        <Info>
          <p><b>Spend per {by}</b>: the same rows as the tiles, bucketed by the date column chosen in "Date from".</p>
          <p>One colour when the council publishes one kind of amount. When kinds are mixed the bars stack, with a fixed colour per kind (net blue, gross orange, unknown grey) and a legend.</p>
          <p>Hover a bar for the exact £, row count and whether those rows carry a paid or invoice date. <b>Table view</b> is the same data as numbers.</p>
          <p>The footer lists rows in the file that could not be placed on this axis (no date, outside the range).</p>
        </Info>
        <h2>Spend per {by}{key === 'period' ? ' (by published period)' : ''}</h2>
        {series.data && <SpendChart data={series.data} />}
        {series.data && <ExcludedNote ex={series.data.excluded} on={series.data.window.on} minPence={series.data.min_pence} />}
      </div>

      <div className="grid two">
        <div className={`card${suppliers.busy ? ' busy' : ''}`}>
          <Info>
            <p><b>Top 15 suppliers</b> by total in the window, ranked on the size of the total.</p>
            <p>Names are exactly as the council typed them -- "CAPITA" and "Capita Business Services Ltd" rank separately. No canonical supplier list exists yet.</p>
            <p><b>mixed</b> flags a supplier whose total spans more than one kind of amount (e.g. gross + unknown).</p>
            <p><b>Redacted</b> rows (payments to individuals the council has anonymised) are excluded from the ranking and totalled underneath instead of appearing as a supplier.</p>
          </Info>
          <h2>Top suppliers <span className="badge">names as published, not canonicalised</span></h2>
          {suppliers.data && (
            <>
              <BarList rows={suppliers.data.suppliers.map((s) => ({ name: s.supplier, sub: `${s.first} → ${s.last}`, ...s }))} />
              {suppliers.data.redacted.length > 0 && (
                <p className="foot">
                  Redacted suppliers (not ranked): <b>{gbpShort(sum(suppliers.data.redacted))}</b> across {int(rows(suppliers.data.redacted))} rows.
                </p>
              )}
            </>
          )}
        </div>
        <div className={`card${breakdown.busy ? ' busy' : ''}`}>
          <Info>
            <p><b>Spend by the council's own categories.</b> <b>org_1…4</b> is who spent it (directorate → service → team); <b>exp_1…3</b> is what was bought (expenditure category); <b>cost_centre</b>, <b>capital_revenue</b>, <b>supplier_type</b> where published.</p>
            <p>The dropdown only lists columns this council fills in, with the share of rows that have a value. Rows with no value are totalled as <b>Unclassified</b> underneath.</p>
            <p>Level numbers only mean something within one council: one council's org_1 is a directorate, another's is a service.</p>
          </Info>
          <h2>
            Spend by{' '}
            {hierarchy.length > 0 ? (
              <select value={effDim} onChange={(e) => setDim(e.target.value as FacetColumn)}>
                {hierarchy.map((f) => <option key={f} value={f}>{f} ({Math.round((c.profile?.coverage[f] ?? 0) * 100)}% of rows)</option>)}
              </select>
            ) : (
              <span className="badge warn">no hierarchy columns published</span>
            )}
          </h2>
          {breakdown.data && (
            <>
              <BarList rows={breakdown.data.values.map((v) => ({ name: v.value, ...v }))} />
              {breakdown.data.unclassified.length > 0 && (
                <p className="foot">
                  Unclassified (no {breakdown.data.dim}): <b>{gbpShort(sum(breakdown.data.unclassified))}</b> across {int(rows(breakdown.data.unclassified))} rows.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

const sum = (xs: { sum_pence: number }[]) => xs.reduce((a, x) => a + x.sum_pence, 0);
const rows = (xs: { rows: number }[]) => xs.reduce((a, x) => a + x.rows, 0);

/** One tile per amount_kind (a single kind is the common case). Payments and credits are
 *  shown separately: credits_pence is negative and already inside sum_pence. */
function Kpis({ by_kind, busy, threshold }: { by_kind: (Kinded & { date_kind: string })[]; busy: boolean; threshold: number | null }) {
  const byAmount = new Map<string, { rows: number; sum: number; credits: number; dateKinds: Set<string> }>();
  for (const k of by_kind) {
    const v = byAmount.get(k.amount_kind) ?? { rows: 0, sum: 0, credits: 0, dateKinds: new Set() };
    v.rows += k.rows; v.sum += k.sum_pence; v.credits += k.credits_pence; v.dateKinds.add(k.date_kind);
    byAmount.set(k.amount_kind, v);
  }
  return (
    <div className={`card kpis${busy ? ' busy' : ''}`}>
      <Info>
        <p><b>Totals in the window</b>, one tile per kind of amount the council publishes.</p>
        <p><b>net</b> = excluding VAT, <b>gross</b> = including VAT, <b>unknown</b> = the council doesn't say. A council that changed what it publishes gets two tiles, and those two totals must not be added together.</p>
        <p>The big number is net of credits. <b>Payments</b> is the positive rows only; <b>credits</b> is the negative rows (credit notes, reversals) only.</p>
        {threshold ? <p>Rows below £{threshold} are included unless the filter is on -- many councils publish everything they have.</p> : null}
      </Info>
      {[...byAmount.entries()].map(([kind, v]) => (
        <div className="tile" key={kind}>
          <div className="label"><span className={`badge kind ${kind}`}>{kind}</span> total in window</div>
          <div className="value" title={gbp(v.sum)}>{gbpShort(v.sum)}</div>
          <div className="note">
            {int(v.rows)} rows · payments {gbpShort(v.sum - v.credits)} · credits {gbpShort(v.credits)}
            {v.dateKinds.size > 1 && <> · dates are {[...v.dateKinds].join(' + ')}</>}
          </div>
        </div>
      ))}
      {byAmount.size === 0 && <div className="tile"><div className="label">no rows in window</div></div>}
    </div>
  );
}

export function ExcludedNote({ ex, on, minPence }: { ex: Excluded; on: string; minPence: number | null }) {
  const parts: string[] = [];
  if (ex.out_of_window) parts.push(`${int(ex.out_of_window)} outside the date range`);
  if (ex.null_date) parts.push(on === 'date'
    ? `${int(ex.null_date)} with no date (switch "Date from" to the file's period label to include them)`
    : `${int(ex.null_date)} with no period label`);
  if (ex.below_min) parts.push(`${int(ex.below_min)} under £${(minPence ?? 0) / 100} in either direction, or with no amount`);
  if (parts.length === 0) return <p className="foot">Every row in the file is included.</p>;
  return <p className="foot">Not shown: {parts.join(' · ')}. Windowed on <b>{on}</b>.</p>;
}

/** Horizontal bar list: one hue (magnitude), 2px gap between kind segments, value at the end.
 *  It is its own table view. A value with >1 kind is flagged because its total mixes kinds. */
function BarList({ rows }: { rows: (Ranked & { name: string; sub?: string })[] }) {
  if (rows.length === 0) return <p className="foot">Nothing in this window.</p>;
  const max = Math.max(...rows.map((r) => Math.abs(r.sum_pence)));
  return (
    <div className="bars">
      {rows.map((r) => (
        <Row key={r.name} r={r} max={max} />
      ))}
    </div>
  );
}

function Row({ r, max }: { r: Ranked & { name: string; sub?: string }; max: number }) {
  const mixed = r.by_kind.length > 1;
  const title = `${r.name}\n${gbp(r.sum_pence)} across ${int(r.rows)} rows` + (mixed ? `\nmixes ${r.by_kind.map((k) => `${k.amount_kind} ${gbpShort(k.sum_pence)}`).join(' + ')}` : '');
  return (
    <>
      <div className="name" title={title}>
        {r.name}
        {r.sub && <p className="sub">{r.sub}</p>}
      </div>
      <div className="track" title={title}>
        <div className={`fill${r.sum_pence < 0 ? ' neg' : ''}`} style={{ width: `${(Math.abs(r.sum_pence) / max) * 100}%` }} />
      </div>
      <div className="val" title={title}>
        {gbpShort(r.sum_pence)}
        {mixed && <p className="sub">mixed: {r.by_kind.map((k) => k.amount_kind).join(' + ')}</p>}
      </div>
    </>
  );
}
