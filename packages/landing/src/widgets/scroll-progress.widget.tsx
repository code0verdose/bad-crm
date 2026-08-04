import { motion, useScroll, useSpring } from 'motion/react';

import { SCROLL_SPRING } from '@/shared/lib/motion-presets.constant.js';

import classes from './scroll-progress.module.css';

/**
 * How far through the page you are, as a two-pixel line.
 *
 * Purely decorative — `aria-hidden`, no `progressbar` role: a screen reader already knows where the
 * reading position is, and announcing it again on every scroll is noise. It is left running under
 * reduced motion on purpose: the bar does not move by itself, it tracks a gesture the reader is
 * making, and the spring only removes the jitter of a trackpad.
 */
export const ScrollProgress = () => {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, SCROLL_SPRING);

  return <motion.div className={classes['bar']} style={{ scaleX }} aria-hidden="true" />;
};
