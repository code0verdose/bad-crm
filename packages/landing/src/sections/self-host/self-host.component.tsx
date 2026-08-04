import clsx from 'clsx';
import { motion } from 'motion/react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { EASE_OUT, IN_VIEW } from '@/shared/lib/motion-presets.constant.js';
import { SECTION_IDS } from '@/shared/lib/site-links.constant.js';
import { BrandMark } from '@/shared/ui/brand-mark.component.js';
import { PageSection } from '@/shared/ui/page-section.component.js';
import { SectionHeading } from '@/shared/ui/section-heading.component.js';
import { WindowChrome } from '@/shared/ui/window-chrome.component.js';

import classes from './self-host.module.css';

/** Seconds between two lines appearing — slow enough to read as a machine working. */
const LINE_DELAY = 0.18;

/**
 * The install, as the terminal you would actually see.
 *
 * Lines arrive one after another when the block comes into view, which is the closest a static page
 * gets to showing a command running. The caret keeps blinking afterwards — the session is alive,
 * the stack is up, nothing is waiting for you.
 *
 * Beside it the whole pricing model: one number, and it is zero.
 */
export const SelfHost = () => {
  const { copy } = useLocale();

  return (
    <PageSection id={SECTION_IDS.selfHost} labelledBy="self-host-heading">
      <SectionHeading
        title={copy.selfHost.title}
        subtitle={copy.selfHost.subtitle}
        id="self-host-heading"
      />

      <div className={classes['layout']}>
        <div className={classes['terminal']}>
          <WindowChrome title={copy.selfHost.terminalTitle} />

          <motion.div
            className={classes['screen']}
            initial="hidden"
            whileInView="visible"
            viewport={IN_VIEW}
            variants={{ hidden: {}, visible: { transition: { staggerChildren: LINE_DELAY } } }}
          >
            {copy.selfHost.terminal.map((line, index) => (
              <motion.span
                key={`${index}-${line}`}
                className={clsx(
                  classes['line'],
                  line.startsWith('$') && classes['command'],
                  line.startsWith('ok') && classes['ok'],
                )}
                variants={{
                  hidden: { opacity: 0, x: -8 },
                  visible: { opacity: 1, x: 0, transition: { duration: 0.3, ease: EASE_OUT } },
                }}
              >
                {line === '' ? ' ' : line}
              </motion.span>
            ))}

            <span className={classes['caret']} aria-hidden="true" />
          </motion.div>
        </div>

        <div className={classes['price']}>
          <span className={classes['compare']}>{copy.selfHost.priceCompare}</span>

          <ul className={classes['rows']}>
            {copy.selfHost.priceRows.map((row) => (
              <li key={row.name} className={classes['row']}>
                <span className={classes['rowName']}>
                  <BrandMark name={row.brand} className={classes['rowMark']} />
                  {row.name}
                </span>
                <span>{row.cost}</span>
              </li>
            ))}
          </ul>

          <span className={classes['total']}>
            {copy.selfHost.priceTotal}
            <span className={classes['totalValue']}>{copy.selfHost.priceTotalValue}</span>
          </span>

          <div className={classes['ours']}>
            <span className={classes['priceValue']}>$0</span>
            <span className={classes['priceLabel']}>{copy.selfHost.priceLabel}</span>
            <br />
            <span className={classes['priceNote']}>{copy.selfHost.priceNote}</span>
          </div>
        </div>
      </div>
    </PageSection>
  );
};
