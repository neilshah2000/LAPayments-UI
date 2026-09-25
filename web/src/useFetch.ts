import { useEffect, useRef, useState } from 'react';

/** Fetch keyed on `deps`. Keeps the previous data while refetching (no skeleton flash). */
export function useFetch<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [busy, setBusy] = useState(true);
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    setBusy(true);
    fn().then(
      (d) => { if (id === seq.current) { setData(d); setError(undefined); setBusy(false); } },
      (e: Error) => { if (id === seq.current) { setError(e); setBusy(false); } },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, busy };
}
