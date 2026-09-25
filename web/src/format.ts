// Display formatting. Amounts arrive as integer pence and must not pick up float drift.

/** £ with pence, exact: integer arithmetic on pence. */
export function gbp(pence: number): string {
  const neg = pence < 0;
  const abs = Math.abs(pence);
  const pounds = Math.floor(abs / 100);
  const pp = abs % 100;
  return `${neg ? '−' : ''}£${pounds.toLocaleString('en-GB')}.${pp.toString().padStart(2, '0')}`;
}

/** £ compact for axes, tiles and bars: £1.2bn, £340m, £52k, £900. */
export function gbpShort(pence: number): string {
  const neg = pence < 0;
  const p = Math.abs(pence) / 100;
  const f = (n: number, s: string) => `${neg ? '−' : ''}£${n.toLocaleString('en-GB', { maximumFractionDigits: n < 10 ? 2 : n < 100 ? 1 : 0 })}${s}`;
  if (p >= 1e9) return f(p / 1e9, 'bn');
  if (p >= 1e6) return f(p / 1e6, 'm');
  if (p >= 1e3) return f(p / 1e3, 'k');
  return f(p, '');
}

export const int = (n: number) => n.toLocaleString('en-GB');

export const pct = (share: number) => `${Math.round(share * 100)}%`;

/** Period label from the API's bucket key: 2025-04 -> Apr 2025; 2025-Q1; 2025. */
export function period(p: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  return p;
}
