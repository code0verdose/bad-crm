import { motion } from 'motion/react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { FADE_UP, IN_VIEW, STAGGER } from '@/shared/lib/motion-presets.constant.js';
import { GITHUB_URL } from '@/shared/lib/site-links.constant.js';
import { ActionLink } from '@/shared/ui/action-link.component.js';
import { PageSection } from '@/shared/ui/page-section.component.js';
import { WordReveal } from '@/shared/ui/word-reveal.component.js';

import { FeedbackForm } from './feedback-form.component.js';
import classes from './cta.module.css';

/**
 * The last screen: the headline assembles the same way the hero's did, so the page closes on the
 * gesture it opened with.
 */
export const Cta = () => {
  const { copy } = useLocale();

  return (
    <PageSection className={classes['section']} labelledBy="cta-heading">
      <div className={classes['backdrop']} aria-hidden="true">
        <span className={classes['grid']} />
        <span className={classes['aurora']} />
        <span className={classes['auroraSecond']} />
      </div>

      <motion.div
        className={classes['inner']}
        variants={STAGGER}
        initial="hidden"
        whileInView="visible"
        viewport={IN_VIEW}
      >
        <h2 id="cta-heading" className={classes['title']}>
          <WordReveal text={copy.cta.title} />
        </h2>

        <motion.p className={classes['subtitle']} variants={FADE_UP}>
          {copy.cta.subtitle}
        </motion.p>

        <motion.div className={classes['actions']} variants={FADE_UP}>
          <ActionLink href={GITHUB_URL} size="lg">
            {copy.cta.primary}
          </ActionLink>
          <ActionLink href={GITHUB_URL} variant="ghost" size="lg">
            {copy.cta.secondary}
          </ActionLink>
        </motion.div>

        <motion.div className={classes['formSlot']} variants={FADE_UP}>
          <FeedbackForm />
        </motion.div>
      </motion.div>
    </PageSection>
  );
};
