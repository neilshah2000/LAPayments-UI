// Thin typed fetch layer over /api. Response shapes come from the server's api-types.ts.
import type { Breakdown, Council, Excluded, FacetColumn, Kinded, Ranked, Summary, Suppliers, Timeseries, TimeseriesBy, TimeseriesKey } from '../../src/api-types.ts';

export type { Breakdown, Council, Excluded, FacetColumn, Kinded, Ranked, Summary, Suppliers, Timeseries, TimeseriesBy, TimeseriesKey };

export interface Filters {
  from?: string;
  to?: string;
  min_pence?: number;
  [k: string]: string | number | undefined;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const qs = q.toString();
  const res = await fetch(`/api${path}${qs ? `?${qs}` : ''}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  councils: () => get<Council[]>('/councils'),
  council: (la: string) => get<Council>(`/councils/${la}`),
  summary: (la: string, f: Filters) => get<Summary>(`/councils/${la}/summary`, f),
  timeseries: (la: string, f: Filters, by: TimeseriesBy, key: TimeseriesKey) =>
    get<Timeseries>(`/councils/${la}/timeseries`, { ...f, by, key }),
  breakdown: (la: string, f: Filters, dim: FacetColumn, top = 15) => get<Breakdown>(`/councils/${la}/breakdown`, { ...f, dim, top }),
  suppliers: (la: string, f: Filters, top = 15) => get<Suppliers>(`/councils/${la}/suppliers`, { ...f, top }),
};
