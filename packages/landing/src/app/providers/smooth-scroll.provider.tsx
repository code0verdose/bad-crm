import Lenis from 'lenis';
import { type ReactNode, useEffect } from 'react';

import { registerSmoothScroller } from '@/shared/lib/smooth-scroll.util.js';
import { useReducedMotion } from '@/shared/lib/use-reduced-motion.hook.js';

/**
 * Smooth scrolling, and the reason every scroll-linked transform on this page feels attached to the
 * page rather than to the wheel.
 *
 * Lenis interpolates the native scroll position, so `useScroll` keeps reading a real scroll offset
 * and nothing else in the page has to know this exists. `lerp` is the whole tuning: lower is
 * heavier, and past about `0.05` the page starts feeling like it is resisting the reader.
 *
 * Not mounted at all when motion is reduced — smoothing is precisely the kind of movement that
 * setting is about, and it is the one effect that would otherwise survive the CSS kill switch.
 */
export const SmoothScrollProvider = ({ children }: { children: ReactNode }) => {
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return;

    const lenis = new Lenis({ lerp: 0.09 });
    registerSmoothScroller(lenis);

    let frame = requestAnimationFrame(function raf(time: number) {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    });

    return () => {
      registerSmoothScroller(null);
      cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, [reduced]);

  return children;
};
