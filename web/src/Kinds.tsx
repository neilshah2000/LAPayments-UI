import { int } from './format.ts';

/** amount_kind / date_kind mix as badges. The kind is a caveat on every figure (§4.1). */
export function KindBadges({ kinds, prefix, swatch = true }: { kinds: Record<string, number>; prefix?: string; swatch?: boolean }) {
  const total = Object.values(kinds).reduce((a, b) => a + b, 0);
  return (
    <>
      {Object.entries(kinds)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => (
          <span key={k} className={swatch ? `badge kind ${k}` : 'badge'} title={`${int(n)} rows`}>
            {prefix}{k}{Object.keys(kinds).length > 1 ? ` ${Math.round((n / total) * 100)}%` : ''}
          </span>
        ))}
    </>
  );
}

export const kindColor = (k: string) => `var(--kind-${k === 'net' || k === 'gross' ? k : 'unknown'})`;
export const KIND_ORDER = ['net', 'gross', 'unknown'];
