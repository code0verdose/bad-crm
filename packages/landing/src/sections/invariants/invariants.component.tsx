import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { SECTION_IDS } from '@/shared/lib/site-links.constant.js';
import { PageSection } from '@/shared/ui/page-section.component.js';
import { SectionHeading } from '@/shared/ui/section-heading.component.js';

import { InvariantCard } from './invariant-card.component.js';
import classes from './invariants.module.css';

/**
 * The four decisions the product will not trade away, as a stack of cards that overlap on the way
 * past. Named `security` in the navigation because that is what a visitor is looking for when three
 * of the four are about isolation, authorisation and encryption.
 */
export const Invariants = () => {
  const { copy } = useLocale();

  return (
    <PageSection id={SECTION_IDS.security} labelledBy="invariants-heading">
      <SectionHeading title={copy.invariants.title} id="invariants-heading" />

      <div className={classes['stack']}>
        {copy.invariants.items.map((item, index) => (
          <InvariantCard
            key={item.tag}
            index={index}
            tag={item.tag}
            title={item.title}
            body={item.body}
            proof={item.proof}
          />
        ))}
      </div>
    </PageSection>
  );
};
