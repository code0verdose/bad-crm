import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { useReducedMotion } from '@/shared/lib/use-reduced-motion.hook.js';
import { DomainIcon } from '@/shared/ui/domain-icon.component.js';
import { WindowChrome } from '@/shared/ui/window-chrome.component.js';

import { BoardView } from './board-view.component.js';
import { DocView } from './doc-view.component.js';
import { TimeView } from './time-view.component.js';
import classes from './app-frame.module.css';

/** How long a card rests before the next one is moved, once the window is fully unfolded. */
const CARD_STEP_MS = 2400;

/** How long each section of the app is shown before the sidebar moves on. */
const VIEW_STEP_MS = 3400;

const COLUMN_COUNT = 3;

/**
 * Which sidebar entries the window walks through, as indices into the domain list: tasks, then
 * documents, then time.
 *
 * Three, not six: each one has to be worth drawing, and these three are the ones the page has
 * already claimed share a data model — the board's card, the document that specifies it and the
 * hours booked against it.
 */
const VIEWS = [1, 2, 5];

/**
 * The product, drawn rather than screenshotted.
 *
 * There is no application to photograph yet, and a mock-up in markup is the honest version of the
 * placeholder: it localises, it re-themes, it scales with the type, and it cannot quietly go stale
 * against a design nobody re-exported. Every string comes from the dictionary.
 *
 * Marked `aria-hidden`: this is a picture of an interface, not an interface. The section's own
 * heading and caption say what it shows.
 *
 * @param live - true once the window has finished unfolding. Nothing inside moves before then:
 *   cards sliding between columns while the whole frame is still rotating is two animations
 *   fighting for the same attention, and neither is legible.
 */
export const AppFrame = ({ live }: { live: boolean }) => {
  const { copy } = useLocale();
  const reduced = useReducedMotion();
  const frame = copy.showcase.frame;

  const [columnOf, setColumnOf] = useState<readonly number[]>(() =>
    frame.cards.map((_card, index) => index % COLUMN_COUNT),
  );
  const [view, setView] = useState(0);
  const nextCard = useRef(0);

  useEffect(() => {
    if (!live || reduced) return;

    const cards = setInterval(() => {
      setColumnOf((current) => {
        const moving = nextCard.current % current.length;
        nextCard.current += 1;
        return current.map((column, index) =>
          index === moving ? (column + 1) % COLUMN_COUNT : column,
        );
      });
    }, CARD_STEP_MS);

    const views = setInterval(() => {
      setView((current) => (current + 1) % VIEWS.length);
    }, VIEW_STEP_MS);

    return () => {
      clearInterval(cards);
      clearInterval(views);
    };
  }, [live, reduced]);

  const activeDomain = VIEWS[view] ?? VIEWS[0];
  const aside =
    activeDomain === 2
      ? frame.aside.doc
      : activeDomain === 5
        ? frame.aside.time
        : frame.aside.board;

  return (
    <div className={classes['frame']} aria-hidden="true">
      <WindowChrome title={frame.windowTitle} />

      <div className={classes['body']}>
        <div className={classes['sidebar']}>
          <span className={classes['brand']}>
            <span className={classes['mark']} />
            {frame.sidebarTitle}
          </span>

          {copy.domains.items.slice(0, 6).map((item, index) => (
            <span
              key={item.name}
              className={clsx(
                classes['navItem'],
                index === activeDomain && classes['navItemActive'],
              )}
            >
              <DomainIcon index={index} className={classes['navIcon']} />
              {item.name}
            </span>
          ))}
        </div>

        <div className={classes['main']}>
          <div className={classes['topbar']}>
            <span>
              <span className={classes['projectLabel']}>{frame.projectLabel}</span>
              <br />
              <span className={classes['projectName']}>{frame.projectName}</span>
            </span>
            <span className={classes['timer']}>
              <span className={classes['timerPulse']} />
              {frame.timerValue}
            </span>
          </div>

          {/* The views cross-fade in place; `mode="wait"` would blank the window between two of
              them, which on a 100svh stage is a hole the size of the section. */}
          <div className={classes['stage']}>
            <AnimatePresence initial={false}>
              <motion.div
                key={activeDomain}
                className={classes['view']}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              >
                {activeDomain === 1 ? <BoardView columnOf={columnOf} /> : null}
                {activeDomain === 2 ? <DocView /> : null}
                {activeDomain === 5 ? <TimeView /> : null}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/*
          The right-hand panel belongs to the view beside it: what is happening on the board, what
          the document is linked to, what the week adds up to. A column that stayed the same while
          the middle changed read as a decoration nobody had finished.
        */}
        <div className={classes['aside']}>
          <AnimatePresence initial={false}>
            <motion.div
              key={`aside-${activeDomain}`}
              className={classes['asidePane']}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              <span className={classes['docTitle']}>{aside.title}</span>

              {aside.lines.map((line, lineIndex) => (
                <motion.span
                  key={line}
                  className={classes['asideLine']}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.06 + lineIndex * 0.05, duration: 0.22 }}
                >
                  <span className={classes['asideDot']} />
                  {line}
                </motion.span>
              ))}

              <span className={classes['chat']}>
                <span className={classes['avatar']} />
                <span className={classes['chatText']}>{frame.chatLine}</span>
              </span>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};
