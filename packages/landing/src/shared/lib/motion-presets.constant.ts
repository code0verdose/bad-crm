import { type Transition, type Variants } from 'motion/react';

/**
 * The page's motion vocabulary. Durations and easings are decided here so that twelve sections
 * written on twelve afternoons still feel like one document scrolling.
 *
 * The easing is the same curve `--bcl-ease-out` names in CSS: things arrive fast and settle slowly,
 * which is what makes a scroll-linked transform feel attached to the wheel rather than chased by it.
 */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;

/** Spring used to smooth raw scroll progress. Low stiffness, high damping: no overshoot, no wobble. */
export const SCROLL_SPRING: Transition = { stiffness: 120, damping: 30, mass: 0.4 };

/** When a section enters: once, and only after a third of it is on screen. */
export const IN_VIEW = { once: true, amount: 0.3 } as const;

export const FADE_UP: Variants = {
  hidden: { opacity: 0, y: 28 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE_OUT } },
};

export const FADE_IN: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.6, ease: EASE_OUT } },
};

/** Parent of a staggered group — children inherit `hidden`/`visible` by name. */
export const STAGGER: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
};

/** A word in a headline: blurred and low, resolving into place. */
export const WORD_REVEAL: Variants = {
  hidden: { opacity: 0, y: '0.4em', filter: 'blur(0.5rem)' },
  visible: {
    opacity: 1,
    y: '0em',
    filter: 'blur(0rem)',
    transition: { duration: 0.9, ease: EASE_OUT },
  },
};
