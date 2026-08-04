import clsx from 'clsx';
import { motion, useInView } from 'motion/react';
import { useRef } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { EASE_OUT } from '@/shared/lib/motion-presets.constant.js';
import { CountUp } from '@/shared/ui/bits/count-up/count-up.component.js';
import { SpotlightCard } from '@/shared/ui/bits/spotlight-card/spotlight-card.component.js';
import { PageSection } from '@/shared/ui/page-section.component.js';
import { SectionHeading } from '@/shared/ui/section-heading.component.js';

import { MetricVisual } from './metric-visual.component.js';
import classes from './metrics.module.css';

/**
 * Six claims, each with the figure that makes it mean something, in a bento that tiles exactly.
 *
 * Four of them are numbers and two are phrases: "no seat limit" written as a literal 0 read as a
 * rendering bug rather than as a claim, and a zero with no unit beside it says nothing at all.
 *
 * Two animations, and they are deliberately separate. The tiles arrive one after another — that is
 * `motion`, per tile, on the way in. The charts inside fill from a single class on the grid, which
 * flips one custom property from 0 to 1; one observer for the section instead of six, and no chart
 * that plays before anybody can see it.
 *
 * `SpotlightCard` is the React Bits port: the highlight follows the pointer across whichever tile it
 * is over, which is the interaction the grid was missing — six static rectangles do not reward
 * moving the mouse.
 */
export const Metrics = () => {
  const { copy, locale } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.25 });

  return (
    <PageSection labelledBy="metrics-heading">
      <SectionHeading title={copy.metrics.title} id="metrics-heading" />

      <div ref={ref} className={classes['grid']}>
        {copy.metrics.items.map((item, index) => (
          <motion.div
            key={item.caption}
            initial={{ opacity: 0, y: 24 }}
            animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
            transition={{ duration: 0.55, ease: EASE_OUT, delay: index * 0.07 }}
            className={clsx(classes['tile'], inView && classes['tileVisible'])}
          >
            <SpotlightCard className={classes['surface']}>
              {item.kind === 'number' ? (
                <span className={classes['value']}>
                  {item.prefix}
                  <CountUp to={item.value} locale={locale} />
                  {item.suffix}
                </span>
              ) : (
                <span className={classes['headline']}>{item.headline}</span>
              )}
              <span className={classes['caption']}>{item.caption}</span>

              <MetricVisual index={index} />
            </SpotlightCard>
          </motion.div>
        ))}
      </div>
    </PageSection>
  );
};
