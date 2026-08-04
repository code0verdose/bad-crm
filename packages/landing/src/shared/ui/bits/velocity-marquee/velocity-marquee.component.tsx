import clsx from 'clsx';
import {
  motion,
  useAnimationFrame,
  useMotionValue,
  useScroll,
  useSpring,
  useTransform,
  useVelocity,
} from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { useReducedMotion } from '@/shared/lib/use-reduced-motion.hook.js';

import classes from './velocity-marquee.module.css';

/*
 * Ported from React Bits (MIT) — see `SOURCE.md` for the origin and the list of changes.
 *
 * A row that always drifts, and drifts faster — and, past a hard flick, backwards — with the speed
 * of the page scroll. The trick is `wrap`: the row holds N identical copies and its x is wrapped
 * into the width of one, so it never actually travels anywhere.
 */

interface VelocityMarqueeProps {
  children: ReactNode;
  /** Pixels per second at rest. Negative drifts the other way. */
  baseVelocity?: number;
  copies?: number;
  className?: string | undefined;
}

const wrap = (min: number, max: number, value: number): number => {
  const range = max - min;
  return ((((value - min) % range) + range) % range) + min;
};

export const VelocityMarquee = ({
  children,
  baseVelocity = 40,
  copies = 4,
  className,
}: VelocityMarqueeProps) => {
  const reduced = useReducedMotion();
  const copyRef = useRef<HTMLSpanElement>(null);
  const [copyWidth, setCopyWidth] = useState(0);

  // A genuine external subscription: the row's width changes when the font loads or the language
  // switches, neither of which is a window resize.
  useEffect(() => {
    const node = copyRef.current;
    if (!node) return;

    const observer = new ResizeObserver(([entry]) => {
      setCopyWidth(entry?.contentRect.width ?? 0);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const baseX = useMotionValue(0);
  const { scrollY } = useScroll();
  const scrollVelocity = useVelocity(scrollY);
  const smoothVelocity = useSpring(scrollVelocity, { damping: 50, stiffness: 400 });
  const velocityFactor = useTransform(smoothVelocity, [0, 1000], [0, 4], { clamp: false });

  const x = useTransform(baseX, (value) =>
    copyWidth === 0 ? '0rem' : `${wrap(-copyWidth, 0, value)}px`,
  );

  const direction = useRef(1);

  useAnimationFrame((_time, delta) => {
    if (reduced) return;

    const factor = velocityFactor.get();
    if (factor < 0) direction.current = -1;
    if (factor > 0) direction.current = 1;

    let moveBy = direction.current * baseVelocity * (delta / 1000);
    moveBy += direction.current * moveBy * factor;
    baseX.set(baseX.get() + moveBy);
  });

  return (
    <div className={classes['viewport']} aria-hidden="true">
      <motion.div className={classes['row']} style={{ x: reduced ? 0 : x }}>
        {Array.from({ length: reduced ? 1 : copies }, (_unused, index) => (
          <span
            key={index}
            className={clsx(classes['copy'], className)}
            ref={index === 0 ? copyRef : null}
          >
            {children}
          </span>
        ))}
      </motion.div>
    </div>
  );
};
