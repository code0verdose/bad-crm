import { motion } from 'motion/react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';

import classes from './app-frame.module.css';

/**
 * The board view of the mock window.
 *
 * The cards carry what a real card carries — a tag, an estimate, a subtask count and whose it is —
 * because the section's claim is "this is the product", and a rectangle with one line of text is a
 * wireframe.
 *
 * `columnOf` comes from the frame so that the movement stays in one place: the card slides between
 * columns on a shared `layoutId`, and only the parent knows when the window is finished unfolding
 * and allowed to start.
 */
export const BoardView = ({ columnOf }: { columnOf: readonly number[] }) => {
  const { copy } = useLocale();
  const frame = copy.showcase.frame;

  return (
    <div className={classes['board']}>
      {frame.boardColumns.map((column, columnIndex) => (
        <div key={column} className={classes['column']}>
          <span className={classes['columnTitle']}>{column}</span>

          {frame.cards
            .filter((_card, cardIndex) => columnOf[cardIndex] === columnIndex)
            .map((card) => (
              <motion.div
                key={card.title}
                layoutId={`frame-${card.title}`}
                layout
                className={classes['card']}
                transition={{ type: 'spring', stiffness: 220, damping: 24 }}
              >
                <span className={classes['cardTitle']}>{card.title}</span>

                <span className={classes['cardMeta']}>
                  <span className={classes['tag']}>{card.tag}</span>
                  <span className={classes['subtasks']}>{card.subtasks}</span>
                  <span className={classes['estimate']}>{card.estimate}</span>
                  <span className={classes['who']}>{card.who}</span>
                </span>
              </motion.div>
            ))}
        </div>
      ))}
    </div>
  );
};
