import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { VelocityMarquee } from '@/shared/ui/bits/velocity-marquee/velocity-marquee.component.js';
import { BrandMark } from '@/shared/ui/brand-mark.component.js';
import { PageSection } from '@/shared/ui/page-section.component.js';
import { SectionHeading } from '@/shared/ui/section-heading.component.js';

import classes from './stack.module.css';

/**
 * What the thing is made of, on a band drifting the other way from the one in "cancel the stack" —
 * the two bands bracket the page and read as an answer to each other.
 *
 * Every name carries its mark and its job. A logo wall says "we use popular things"; a name plus a
 * job says what you would be operating.
 */
export const Stack = () => {
  const { copy } = useLocale();

  return (
    <PageSection labelledBy="stack-heading">
      <SectionHeading title={copy.stack.title} id="stack-heading" />

      <div className={classes['band']}>
        <VelocityMarquee baseVelocity={-28} className={classes['row']}>
          {copy.stack.items.map((item) => (
            <span key={item.name} className={classes['chip']}>
              <BrandMark name={item.brand} className={classes['mark']} />
              <span className={classes['text']}>
                <span className={classes['name']}>{item.name}</span>
                <span className={classes['role']}>{item.role}</span>
              </span>
            </span>
          ))}
        </VelocityMarquee>
      </div>
    </PageSection>
  );
};
