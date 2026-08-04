import { motion } from 'motion/react';
import { Fragment } from 'react';

import { IN_VIEW, STAGGER, WORD_REVEAL } from '@/shared/lib/motion-presets.constant.js';

import classes from './word-reveal.module.css';

/**
 * A line of text that assembles itself word by word.
 *
 * React Bits ships this as `SplitText`, and that version is deliberately **not** ported: it is
 * built on GSAP's `SplitText` plugin, and GSAP's licence is not OSI-approved — which
 * `rules/dependencies.mdc` rules out for an AGPL-3.0 repository. The effect itself is a few
 * `motion` variants, so the dependency was the whole cost.
 *
 * Splitting on spaces rather than on characters is a choice about reading, not about effort: a
 * per-character reveal on a Cyrillic headline reads as a glitch, and a screen reader announcing a
 * heading letter by letter is worse than one announcing it word by word.
 *
 * **The spaces between the words are real text nodes, and that is the whole subtlety here.** A
 * margin looks identical and is what this component did first — until the page's own text came back
 * as `Однорабочееместо.`: with the gap in CSS, the heading has no spaces at all as far as
 * copy-paste, a screen reader or a search engine is concerned. Measured on the running page, not
 * assumed.
 */
interface WordRevealProps {
  text: string;
  /** Seconds added before this line starts — how a multi-line headline cascades. */
  delay?: number;
}

export const WordReveal = ({ text, delay = 0 }: WordRevealProps) => {
  const words = text.split(' ');

  return (
    <motion.span
      /**
       * Keyed on the text, which is the fix for a heading that vanished on the language switch.
       *
       * `whileInView` with `once: true` detaches its observer after the first run. Swap the
       * dictionary and the words remount with `initial="hidden"` under a parent whose observer is
       * gone — nothing ever tells them to become visible, so the heading is simply not there. A new
       * key remounts the whole line, the observer is attached again, and because the line is already
       * on screen it fires immediately.
       */
      key={text}
      className={classes['line']}
      variants={STAGGER}
      initial="hidden"
      whileInView="visible"
      viewport={IN_VIEW}
      transition={{ delayChildren: delay }}
    >
      {words.map((word, index) => (
        <Fragment key={`${word}-${index}`}>
          <motion.span className={classes['word']} variants={WORD_REVEAL}>
            {word}
          </motion.span>
          {index < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </motion.span>
  );
};
