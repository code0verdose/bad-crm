import clsx from 'clsx';
import { motion } from 'motion/react';

import { FADE_UP, IN_VIEW, STAGGER } from '@/shared/lib/motion-presets.constant.js';

import { WordReveal } from './word-reveal.component.js';
import classes from './section-heading.module.css';

/**
 * Heading and subtitle — the two lines that open every section, so that twelve sections introduce
 * themselves the same way.
 *
 * There is no eyebrow. Every section used to carry a small capitalised label above its heading, and
 * twelve of them in a row read as a template rather than as an argument: the heading already says
 * what the section is, and the label was a second, quieter copy of it.
 */
interface SectionHeadingProps {
  title: string;
  subtitle?: string | undefined;
  id?: string | undefined;
  centered?: boolean;
}

export const SectionHeading = ({ title, subtitle, id, centered = false }: SectionHeadingProps) => (
  <motion.div
    className={clsx(classes['heading'], centered && classes['centered'])}
    variants={STAGGER}
    initial="hidden"
    whileInView="visible"
    viewport={IN_VIEW}
  >
    <h2 id={id} className={classes['title']}>
      <WordReveal text={title} />
    </h2>

    {subtitle ? (
      <motion.p className={classes['subtitle']} variants={FADE_UP}>
        {subtitle}
      </motion.p>
    ) : null}
  </motion.div>
);
