import { motion, useTransform } from 'motion/react';
import { useRef } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { FADE_UP, IN_VIEW, STAGGER } from '@/shared/lib/motion-presets.constant.js';
import { GITHUB_URL } from '@/shared/lib/site-links.constant.js';
import { useSceneProgress } from '@/shared/lib/use-scene-progress.hook.js';
import { ActionLink } from '@/shared/ui/action-link.component.js';
import { AuroraBackdrop } from '@/shared/ui/bits/aurora/aurora-backdrop.component.js';
import { WordReveal } from '@/shared/ui/word-reveal.component.js';

import classes from './hero.module.css';

/** The aurora's three stops, in the order the shader ramps them left to right. */
const AURORA_STOPS = ['#22d3ee', '#6d8bff', '#c084fc'] as const;

/**
 * The first screen, and the only place on the page with an `h1`.
 *
 * Two motions, layered. On load the headline assembles word by word. On scroll the whole block
 * folds away from the reader — `rotateX` about its top edge with a little scale and blur — so the
 * next section does not merely arrive, it takes over. The perspective that makes the fold read as
 * depth is on the section; the content sits in `transform-style: preserve-3d` inside it.
 *
 * Frozen at 0 under reduced motion, which is the state where everything is upright and legible.
 */
export const Hero = () => {
  const { copy } = useLocale();
  const ref = useRef<HTMLElement>(null);

  const progress = useSceneProgress(ref, { offset: ['start start', 'end start'] });
  const scale = useTransform(progress, [0, 1], [1, 0.88]);
  const rotateX = useTransform(progress, [0, 1], [0, 14]);
  const y = useTransform(progress, [0, 1], ['0%', '10%']);
  const opacity = useTransform(progress, [0, 0.85], [1, 0]);
  const filter = useTransform(progress, [0, 1], ['blur(0rem)', 'blur(0.75rem)']);

  const [firstLine, secondLine, thirdLine] = copy.hero.titleLines;

  return (
    <section id="top" ref={ref} className={classes['hero']}>
      <div className={classes['backdrop']} aria-hidden="true">
        <div className={classes['glow']} />
        <div className={classes['grid']} />
        <div className={classes['aurora']}>
          <AuroraBackdrop colorStops={AURORA_STOPS} />
        </div>
      </div>

      <motion.div
        className={classes['content']}
        style={{ scale, rotateX, y, opacity, filter, transformOrigin: 'center top' }}
      >
        <h1 className={classes['title']}>
          <WordReveal text={firstLine ?? ''} />
          <WordReveal text={secondLine ?? ''} delay={0.12} />
          <span className={classes['accentLine']}>
            <WordReveal text={thirdLine ?? ''} delay={0.24} />
          </span>
        </h1>

        <motion.div
          className={classes['lede']}
          variants={STAGGER}
          initial="hidden"
          whileInView="visible"
          viewport={IN_VIEW}
          transition={{ delayChildren: 0.45 }}
        >
          <motion.p className={classes['subtitle']} variants={FADE_UP}>
            {copy.hero.subtitle}
          </motion.p>

          <motion.div className={classes['actions']} variants={FADE_UP}>
            <ActionLink href={GITHUB_URL} size="lg">
              {copy.hero.ctaPrimary}
            </ActionLink>
            <ActionLink href={GITHUB_URL} variant="ghost" size="lg">
              {copy.hero.ctaSecondary}
            </ActionLink>
          </motion.div>

          <motion.p className={classes['stat']} variants={FADE_UP}>
            {copy.hero.stat}
          </motion.p>
        </motion.div>
      </motion.div>

      <div className={classes['scrollHint']} aria-hidden="true">
        <span>{copy.hero.scrollHint}</span>
        <span className={classes['scrollLine']} />
      </div>
    </section>
  );
};
