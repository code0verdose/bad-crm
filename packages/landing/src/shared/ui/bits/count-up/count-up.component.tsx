import { useInView, useMotionValue, useSpring } from 'motion/react';
import { useEffect, useRef } from 'react';

import { useReducedMotion } from '@/shared/lib/use-reduced-motion.hook.js';

/*
 * Ported from React Bits (MIT) — see `SOURCE.md` for the origin and the list of changes.
 *
 * The number is written straight into the DOM node from a motion value subscription, so counting
 * from 0 to 100 costs zero React renders.
 */

interface CountUpProps {
  to: number;
  locale: string;
  /** Seconds. Tuned into a spring rather than used as a duration — see below. */
  duration?: number;
  className?: string | undefined;
}

export const CountUp = ({ to, locale, duration = 1.8, className }: CountUpProps) => {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();

  const value = useMotionValue(0);
  // Upstream's mapping from a wanted duration onto spring constants: a longer count is a softer,
  // less stiff spring. It is not an exact duration and does not need to be — what matters is that
  // six tiles counting at once feel like one gesture.
  const spring = useSpring(value, { damping: 20 + 40 / duration, stiffness: 100 / duration });

  const inView = useInView(ref, { once: true });

  useEffect(() => {
    if (inView) value.set(to);
  }, [inView, to, value]);

  useEffect(() => {
    const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });

    if (reduced) {
      if (ref.current) ref.current.textContent = format.format(to);
      return;
    }

    // The markup renders the final number (see below); once the spring is live it owns the node,
    // so it writes its current value straight away instead of waiting for the first change.
    if (ref.current) ref.current.textContent = format.format(spring.get());

    return spring.on('change', (latest) => {
      if (ref.current) ref.current.textContent = format.format(latest);
    });
  }, [spring, locale, reduced, to]);

  // Rendered with the final value so that the number exists before any script runs — a count-up
  // that starts empty is a blank tile for anybody whose JavaScript is slow, blocked or off.
  return (
    <span ref={ref} className={className}>
      {to}
    </span>
  );
};
