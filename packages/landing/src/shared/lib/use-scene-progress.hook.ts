import {
  type MotionValue,
  useMotionValue,
  useScroll,
  type UseScrollOptions,
  useSpring,
} from 'motion/react';
import { type RefObject } from 'react';

import { SCROLL_SPRING } from './motion-presets.constant.js';
import { useReducedMotion } from './use-reduced-motion.hook.js';

interface SceneOptions {
  /** Where the scene starts and ends relative to the viewport, in `useScroll` terms. */
  offset: NonNullable<UseScrollOptions['offset']>;
  /**
   * The progress the scene is frozen at when motion is reduced.
   *
   * There is no universal answer, which is why it is a parameter: a hero that folds away as you
   * leave it has to stay at 0, while a showcase that unfolds a screenshot has to be shown already
   * unfolded, at 1. Freezing everything at the same end would leave half the page invisible to the
   * people the setting exists for.
   */
  staticProgress?: number;
  /** Raw progress, unsmoothed — for transforms that must track the wheel exactly (pinned scroll). */
  raw?: boolean;
}

/**
 * One scroll timeline for one section.
 *
 * Every scroll-driven section on the page goes through this hook instead of calling `useScroll`
 * directly, for two reasons: the spring is the same everywhere, and `prefers-reduced-motion` is
 * handled once rather than remembered twelve times.
 */
export const useSceneProgress = (
  target: RefObject<HTMLElement | null>,
  { offset, staticProgress = 0, raw = false }: SceneOptions,
): MotionValue<number> => {
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target, offset });
  const smoothed = useSpring(scrollYProgress, SCROLL_SPRING);
  const frozen = useMotionValue(staticProgress);

  if (reduced) return frozen;

  return raw ? scrollYProgress : smoothed;
};
