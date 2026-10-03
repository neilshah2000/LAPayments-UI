import { api } from './api.ts';
import { useFetch } from './useFetch.ts';
import { int } from './format.ts';
import { KindBadges } from './Kinds.tsx';

// 19+ councils with many attributes each: a table, not a chart.
export function CouncilList() {
  const { data, error } = useFetch(() => api.councils(), []);
  if (error) return <p className="error">{error.message}</p>;
  if (!data) return <p className="sub">Loading…</p>;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <h1>Council supplier payments</h1>
      <div className="card table">
        <table>
          <thead>
            <tr>
              <th>Council</th>
              <th className="num">Rows</th>
              <th>Dates</th>
              <th className="num">Threshold</th>
              <th>Amounts are</th>
              <th>Dates are</th>
              <th>Tells</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.la_code} className="row">
                <td>
                  <a href={`#/${c.la_code}`}>{c.official_name}</a>
                </td>
                <td className="num">{int(c.rows)}</td>
                <td className="dates">{c.first_date} → {c.last_date}</td>
                <td className="num">{c.spend_threshold === 0 ? 'none' : `£${c.spend_threshold}`}</td>
                <td>{c.profile ? <KindBadges kinds={c.profile.amount_kind} /> : <span className="sub">—</span>}</td>
                <td>{c.profile ? <KindBadges kinds={c.profile.date_kind} swatch={false} /> : <span className="sub">—</span>}</td>
                <td>
                  {/* Catalogued but unreadable: say so rather than showing a blank row. */}
                  {!c.profile && <span className="badge critical" title={c.unavailable?.reason}>file unavailable</span>}
                  {c.last_date && c.last_date > today && <span className="badge critical">dates to {c.last_date}</span>}
                  {c.profile && c.profile.dates.null > 0 && <span className="badge warn">{int(c.profile.dates.null)} undated</span>}
                  {c.profile && c.profile.dates.pre_2008 > 0 && <span className="badge warn">{int(c.profile.dates.pre_2008)} pre-2008</span>}
                  {c.profile && c.profile.amounts.redacted > 0 && <span className="badge">{Math.round((c.profile.amounts.redacted / c.rows) * 100)}% redacted</span>}
                  {c.warnings && <span className="badge warn" title={c.warnings}>re-issue</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
