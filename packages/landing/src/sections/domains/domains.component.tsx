import clsx from 'clsx';
import { motion } from 'motion/react';
import { useCallback, useState } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { SECTION_IDS } from '@/shared/lib/site-links.constant.js';
import { DomainIcon } from '@/shared/ui/domain-icon.component.js';
import { PageSection } from '@/shared/ui/page-section.component.js';
import { SectionHeading } from '@/shared/ui/section-heading.component.js';

import { DomainPanel } from './domain-panel.component.js';
import classes from './domains.module.css';

/** The pill's own motion. Stiff enough to keep up with a fast scroll, damped enough not to wobble. */
const PILL_TRANSITION = { type: 'spring', stiffness: 420, damping: 38, mass: 0.6 } as const;

/**
 * Eight domains, read as one scroll.
 *
 * The heading and the index stay pinned on the left while the cards move past on the right, and the
 * highlight travels with the reader. It is the shape of a table of contents that reads itself — and
 * it is why this section can be long without feeling like a list.
 *
 * This section briefly took the wheel over and turned the domains into a deck of pages; it is back
 * to plain scrolling on purpose. Whatever a captured scroll buys in rhythm, it costs in the one
 * thing a reader expects a page to do, and the deck read as the page having stopped responding.
 */
export const Domains = () => {
  const { copy } = useLocale();
  const [active, setActive] = useState(0);

  // Stable identity: the panels take this as a prop and call it from an effect, so a new function
  // on every render would re-run that effect on every render of the section.
  const activate = useCallback((index: number) => setActive(index), []);

  return (
    <PageSection id={SECTION_IDS.domains} labelledBy="domains-heading">
      <div className={classes['layout']}>
        <div className={classes['rail']}>
          <SectionHeading title={copy.domains.title} id="domains-heading" />

          <ul className={classes['list']}>
            {copy.domains.items.map((item, index) => (
              <li
                key={item.name}
                className={clsx(classes['entry'], index === active && classes['entryActive'])}
              >
                {index === active ? (
                  <motion.span
                    layoutId="domain-pill"
                    className={classes['pill']}
                    transition={PILL_TRANSITION}
                  />
                ) : null}
                <DomainIcon index={index} className={classes['entryIcon']} />
                <span className={classes['entryLabel']}>{item.name}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className={classes['panels']}>
          {copy.domains.items.map((item, index) => (
            <DomainPanel
              key={item.name}
              index={index}
              name={item.name}
              summary={item.summary}
              points={item.points}
              onEnter={activate}
            />
          ))}
        </div>
      </div>
    </PageSection>
  );
};
