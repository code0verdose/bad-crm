import clsx from 'clsx';
import { motion, useMotionValueEvent, useScroll } from 'motion/react';
import { useRef, useState } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { EASE_OUT } from '@/shared/lib/motion-presets.constant.js';
import { GITHUB_URL, SECTION_IDS } from '@/shared/lib/site-links.constant.js';
import { SectionLink } from '@/shared/ui/section-link.component.js';
import { ActionLink } from '@/shared/ui/action-link.component.js';

import { LanguageSwitch } from './language-switch.widget.js';
import classes from './site-header.module.css';

/** Where the bar switches from transparent to a floating pill, in pixels of scroll. */
const CONDENSE_AT = 80;

/**
 * How far you have to move in one direction before the bar reacts, in pixels.
 *
 * Without it the header flickers: a trackpad delivers scroll in both directions within one gesture,
 * and a bar that hides on every negative pixel spends the page blinking.
 */
const DIRECTION_THRESHOLD = 12;

/**
 * The bar hides when you scroll down and comes back the moment you scroll up.
 *
 * Reading down the page is the one activity the header has nothing to contribute to, and this page
 * is one long read; coming back up is almost always navigation, and that is when it should be
 * there. It never hides while you are still on the first screen — a page that eats its own
 * navigation before you have scrolled anywhere looks broken.
 */
export const SiteHeader = () => {
  const { copy } = useLocale();
  const { scrollY } = useScroll();
  const [condensed, setCondensed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);

  useMotionValueEvent(scrollY, 'change', (value) => {
    setCondensed(value > CONDENSE_AT);

    const delta = value - lastY.current;
    if (Math.abs(delta) < DIRECTION_THRESHOLD) return;

    lastY.current = value;
    setHidden(delta > 0 && value > CONDENSE_AT);
  });

  return (
    <motion.header
      className={classes['header']}
      animate={{ y: hidden ? '-160%' : '0%' }}
      transition={{ duration: 0.35, ease: EASE_OUT }}
    >
      <a href={`#${SECTION_IDS.main}`} className={classes['skipLink']}>
        {copy.meta.skipToContent}
      </a>

      <div className={clsx(classes['bar'], condensed && classes['condensed'])}>
        <SectionLink id="top" className={classes['brand']}>
          <span className={classes['mark']} aria-hidden="true" />
          Bad CRM
        </SectionLink>

        <nav className={classes['nav']} aria-label="Bad CRM">
          <SectionLink className={classes['navLink']} id={SECTION_IDS.workspace}>
            {copy.nav.workspace}
          </SectionLink>
          <SectionLink className={classes['navLink']} id={SECTION_IDS.domains}>
            {copy.nav.domains}
          </SectionLink>
          <SectionLink className={classes['navLink']} id={SECTION_IDS.security}>
            {copy.nav.security}
          </SectionLink>
          <SectionLink className={classes['navLink']} id={SECTION_IDS.selfHost}>
            {copy.nav.selfHost}
          </SectionLink>
        </nav>

        <div className={classes['actions']}>
          <LanguageSwitch />
          <ActionLink href={GITHUB_URL}>{copy.nav.cta}</ActionLink>
        </div>
      </div>
    </motion.header>
  );
};
