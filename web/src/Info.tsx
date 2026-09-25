import type { ReactNode } from 'react';

/** Top-right "i" on a card. Hover or keyboard-focus shows the explanation; screen readers get it
 *  as the button's description. Pure CSS, so it works without JS state. */
export function Info({ children }: { children: ReactNode }) {
  return (
    <span className="info">
      <button type="button" aria-label="What is this?">i</button>
      <div className="info-pop" role="tooltip">{children}</div>
    </span>
  );
}
