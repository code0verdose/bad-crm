import { motion, useMotionValueEvent, useTransform, type Variants } from 'motion/react';
import { useRef, useState } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { EASE_OUT, IN_VIEW } from '@/shared/lib/motion-presets.constant.js';
import { SECTION_IDS } from '@/shared/lib/site-links.constant.js';
import { useMediaQuery } from '@/shared/lib/use-media-query.hook.js';
import { useSceneProgress } from '@/shared/lib/use-scene-progress.hook.js';
import { SectionHeading } from '@/shared/ui/section-heading.component.js';

import { AppFrame } from './app-frame.component.js';
import classes from './showcase.module.css';

/**
 * The screenshot that unfolds.
 *
 * A tall scene with a sticky viewport inside it: the page scrolls, the picture stays, and the
 * scroll distance is spent straightening the frame instead of moving it. It starts small, tilted
 * away and rounded like an object on a desk, and ends flat and full width — the moment the mock-up
 * stops being an illustration and becomes the interface.
 *
 * The panels inside do **not** drift. They used to, for parallax, and the effect cost more than it
 * bought: a picture of an interface that shifts internally reads as a broken layout, and the drift
 * was what carried the side panels over the title bar. The depth comes from the fold alone.
 *
 * Frozen at 1 under reduced motion: the unfolded state is the one that shows the product. The board
 * inside then stays still — a frozen motion value emits no changes, so `live` never turns on, and
 * `AppFrame` refuses to run its timer under reduced motion anyway. Two independent reasons for the
 * same correct behaviour, which is the level of redundancy that setting deserves.
 */
/**
 * The phone version of the unfolding: the same arrival — smaller, tilted, fading up into place —
 * played once on entry instead of being scrubbed by a scroll track that no longer exists there.
 */
const REVEAL: Variants = {
  hidden: { opacity: 0, y: 28, scale: 0.94 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.6, ease: EASE_OUT } },
};

export const Showcase = () => {
  const { copy } = useLocale();
  const ref = useRef<HTMLDivElement>(null);

  /**
   * Below this width the stylesheet unpins the scene, and the scroll timeline has to go with it: an
   * `end end` offset over an element shorter than the viewport finishes before it starts, so the
   * unfolding played backwards — the frame folded away as you scrolled towards it.
   *
   * The arrival is not dropped, it changes shape. Scrubbing needs scroll distance the phone layout
   * no longer spends; a one-shot reveal on entry gives the same beat without the timeline.
   */
  const narrow = useMediaQuery('(width <= 62em)');

  const progress = useSceneProgress(ref, {
    offset: ['start start', 'end end'],
    staticProgress: 1,
    frozenBelow: '(width <= 62em)',
  });

  const scale = useTransform(progress, [0, 0.7], [0.66, 1]);
  const rotateX = useTransform(progress, [0, 0.7], [24, 0]);
  // Never fully transparent: the frame is already on screen when the scene starts, so fading it in
  // from zero would read as a broken image rather than as an arrival.
  const opacity = useTransform(progress, [0, 0.2], [0.4, 1]);

  /**
   * The board inside the window comes alive once the unfolding is done.
   *
   * The threshold is the same 0.7 the transform finishes at, so the two never overlap: the frame
   * settles, and then the work in it starts moving.
   */
  const [live, setLive] = useState(false);
  useMotionValueEvent(progress, 'change', (value) => setLive(value >= 0.7));

  return (
    <div id={SECTION_IDS.workspace} ref={ref} className={classes['scene']}>
      <div className={classes['sticky']}>
        <div className={classes['heading']}>
          <SectionHeading title={copy.showcase.title} centered />
        </div>

        {narrow ? (
          <motion.div
            className={classes['stage']}
            initial="hidden"
            whileInView="visible"
            viewport={IN_VIEW}
            variants={REVEAL}
            onViewportEnter={() => setLive(true)}
          >
            <AppFrame live={live} />
          </motion.div>
        ) : (
          <motion.div
            className={classes['stage']}
            style={{ scale, rotateX, opacity, transformOrigin: 'center center' }}
          >
            <AppFrame live={live} />
          </motion.div>
        )}

        <p className={classes['caption']}>{copy.showcase.caption}</p>
      </div>
    </div>
  );
};
