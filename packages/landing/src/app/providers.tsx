import { MotionConfig } from 'motion/react';
import { type ReactNode } from 'react';

import { LocaleProvider } from './i18n/locale.provider.js';
import { SmoothScrollProvider } from './providers/smooth-scroll.provider.js';

/**
 * The whole provider tree: language first — the header reads it — then smooth scrolling, which only
 * has to be inside anything that scrolls. There is no theme provider: the landing has one scheme
 * (`app/styles/tokens.css`).
 *
 * `reducedMotion="user"` is the other half of the kill switch. The CSS one in `app/global.css`
 * cannot reach the entrance animations, because `motion` writes them as inline styles; this makes
 * every `motion` component skip transform and opacity moves when the system asks it to.
 */
export const Providers = ({ children }: { children: ReactNode }) => (
  <MotionConfig reducedMotion="user">
    <LocaleProvider>
      <SmoothScrollProvider>{children}</SmoothScrollProvider>
    </LocaleProvider>
  </MotionConfig>
);
