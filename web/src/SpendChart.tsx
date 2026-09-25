import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Timeseries } from './api.ts';
import { gbp, gbpShort, int, period as fmtPeriod } from './format.ts';
import { KIND_ORDER, kindColor } from './Kinds.tsx';

interface Point {
  period: string;
  rows: number;
  date_kinds: Set<string>;
  /** sum_pence per amount_kind present in this period */
  kinds: Record<string, number>;
}

/** Column chart of sum per period. Single amount_kind (15 of 19 councils): the accent hue, no
 *  legend -- the kind is named in the KPI tile. Several: stacked, fixed colour per kind (never by
 *  rank), legend + kind named in tooltip. */
export function SpendChart({ data }: { data: Timeseries }) {
  const kinds = KIND_ORDER.filter((k) => data.series.some((s) => s.amount_kind === k))
    .concat([...new Set(data.series.map((s) => s.amount_kind))].filter((k) => !KIND_ORDER.includes(k)));
  const byPeriod = new Map<string, Point>();
  for (const s of data.series) {
    const p = byPeriod.get(s.period) ?? { period: s.period, rows: 0, date_kinds: new Set<string>(), kinds: {} };
    p.kinds[s.amount_kind] = s.sum_pence;
    p.rows += s.rows;
    for (const d of s.date_kinds) p.date_kinds.add(d);
    byPeriod.set(s.period, p);
  }
  const points = [...byPeriod.values()].sort((a, b) => (a.period < b.period ? -1 : 1));
  if (points.length === 0) return <p className="foot">No rows in this window.</p>;

  return (
    <>
      {kinds.length > 1 && (
        <div className="legend">
          {kinds.map((k) => <span key={k} className={`badge kind ${k}`}>{k}</span>)}
        </div>
      )}
      <div style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer>
          <BarChart data={points} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="period" tickFormatter={fmtPeriod} tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={{ stroke: 'var(--axis)' }} tickLine={false} minTickGap={24} />
            <YAxis tickFormatter={gbpShort} tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
            <Tooltip cursor={{ fill: 'color-mix(in srgb, var(--ink) 6%, transparent)' }} content={<Tip kinds={kinds} />} />
            {kinds.map((k, i) => (
              <Bar key={k} dataKey={(p: Point) => p.kinds[k] ?? null} name={k} stackId="a" fill={kinds.length > 1 ? kindColor(k) : 'var(--bar)'} stroke="var(--surface)" strokeWidth={kinds.length > 1 ? 1 : 0}
                radius={i === kinds.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <details>
        <summary>Table view</summary>
        <table>
          <thead><tr><th>Period</th>{kinds.map((k) => <th key={k} className="num">{k}</th>)}<th className="num">Rows</th><th>Date kinds</th></tr></thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.period}>
                <td>{fmtPeriod(p.period)}</td>
                {kinds.map((k) => <td key={k} className="num">{k in p.kinds ? gbp(p.kinds[k]) : '—'}</td>)}
                <td className="num">{int(p.rows)}</td>
                <td>{[...p.date_kinds].join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

function Tip({ active, payload, kinds }: { active?: boolean; payload?: { payload: Point }[]; kinds: string[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="tooltip">
      <div className="t">{fmtPeriod(p.period)}</div>
      {kinds.map((k) => k in p.kinds && (
        <div className="r" key={k}><span><span className={`badge kind ${k}`}>{k}</span></span><span>{gbp(p.kinds[k])}</span></div>
      ))}
      <div className="r" style={{ color: 'var(--muted)' }}><span>{int(p.rows)} rows</span><span>dates: {[...p.date_kinds].join(', ')}</span></div>
    </div>
  );
}
