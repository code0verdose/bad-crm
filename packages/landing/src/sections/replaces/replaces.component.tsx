import clsx from 'clsx';
import { useInView } from 'motion/react';
import { type CSSProperties, useRef } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { BrandMark } from '@/shared/ui/brand-mark.component.js';
import { Icon } from '@/shared/ui/icon.component.js';
import { VelocityMarquee } from '@/shared/ui/bits/velocity-marquee/velocity-marquee.component.js';
import { PageSection } from '@/shared/ui/page-section.component.js';
import { SectionHeading } from '@/shared/ui/section-heading.component.js';

import classes from './replaces.module.css';

/**
 * The stack being cancelled, on a band that drifts with the scroll.
 *
 * The band never stops — that is the `VelocityMarquee` port — and it speeds up, skews and reverses
 * with how hard the reader flicks the page. The strike-through is a separate, one-shot gesture:
 * when the band comes into view each name is crossed out in turn, 90 ms apart, so the row reads as
 * a list being cancelled rather than as decoration that happens to have lines on it.
 *
 * The band is `aria-hidden` inside the marquee (repeated copies would be read out four times); the
 * heading and the footnote carry the meaning for anybody not looking at it.
 */
export const Replaces = () => {
  const { copy } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const struck = useInView(ref, { once: true, amount: 0.5 });

  return (
    <PageSection className={classes['section']}>
      <SectionHeading title={copy.replaces.title} subtitle={copy.replaces.subtitle} />

      <div ref={ref} className={clsx(classes['marquee'], struck && classes['struck'])}>
        <VelocityMarquee baseVelocity={35} className={classes['row']}>
          {copy.replaces.tools.map((tool, index) => (
            <span
              key={tool.name}
              className={classes['item']}
              style={{ '--bcl-strike-index': index } as CSSProperties}
            >
              <BrandMark name={tool.brand} className={classes['mark']} />
              {tool.name}
            </span>
          ))}
        </VelocityMarquee>
      </div>

      <p className={classes['footnote']}>
        <Icon name="arrowRight" className={classes['arrow']} />
        {copy.replaces.footnote}
      </p>
    </PageSection>
  );
};
