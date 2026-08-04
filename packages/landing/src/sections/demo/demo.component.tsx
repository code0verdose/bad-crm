import clsx from 'clsx';
import { AnimatePresence, motion, useInView } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { useReducedMotion } from '@/shared/lib/use-reduced-motion.hook.js';
import { PageSection } from '@/shared/ui/page-section.component.js';
import { SectionHeading } from '@/shared/ui/section-heading.component.js';
import { WindowChrome } from '@/shared/ui/window-chrome.component.js';

import { participantsOf } from './participants.util.js';
import classes from './demo.module.css';

/** How long a card rests in a column before it moves on. */
const STEP_MS = 2200;
const COLUMN_COUNT = 3;

/** How long the typing indicator runs before the next message lands. */
const TYPING_MS = 1600;

/** How long the thread rests on a full message before the next one starts being typed. */
const MESSAGE_MS = 2600;

/**
 * The board that plays itself.
 *
 * Every couple of seconds one card moves a column to the right, and it *slides* there rather than
 * disappearing and reappearing: the cards share a `layoutId`, so `motion` animates the position
 * change between two different parents. That single behaviour is what makes the section read as
 * "other people are working in here" instead of as a screenshot with a caption.
 *
 * The cards carry what a real card carries — a label, an estimate and whose it is — because a
 * moving rectangle with a sentence in it is a diagram, and this section is supposed to look like
 * the product.
 *
 * The timer only runs while the section is on screen and only when motion is allowed. A loop that
 * keeps firing in a tab nobody is looking at is a battery bug with an animation attached.
 */
export const Demo = () => {
  const { copy } = useLocale();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });

  const [columnOf, setColumnOf] = useState<readonly number[]>(() =>
    copy.demo.cards.map((_card, index) => index % COLUMN_COUNT),
  );
  const nextCard = useRef(0);

  /**
   * The thread plays itself: two messages are already there when you arrive, then each new one is
   * announced by the typing indicator and lands a beat later.
   *
   * `shown` counts messages, `typing` is the beat before the next. A chat that is merely *drawn*
   * with a static "Nina is typing" under it claims something that never happens; this one does the
   * thing it claims, on a loop, and stops the moment the section leaves the screen.
   */
  const [shown, setShown] = useState(2);
  const [typing, setTyping] = useState(false);

  /**
   * Whose turn it is to be typing.
   *
   * The thread alternates: somebody writes, then you write back. Both are animated — there is no
   * input to type into, because the section is a demonstration of the product and a field that
   * accepts text promises something this page cannot deliver.
   */
  const [typingOwn, setTypingOwn] = useState(false);

  /**
   * What the composer is showing.
   *
   * The field is `readOnly` on purpose — this is a picture of a chat, and a field that accepts text
   * promises a conversation the page cannot have. What it does do is *type*: when the next message
   * is yours, it appears in the composer character by character and then leaves, the way it would
   * if you had written and sent it.
   */
  const [composed, setComposed] = useState('');

  useEffect(() => {
    if (reduced || !inView) return;

    const timer = setInterval(() => {
      setColumnOf((current) => {
        const moving = nextCard.current % current.length;
        nextCard.current += 1;
        return current.map((column, index) =>
          index === moving ? (column + 1) % COLUMN_COUNT : column,
        );
      });
    }, STEP_MS);

    return () => clearInterval(timer);
  }, [reduced, inView]);

  useEffect(() => {
    if (reduced || !inView) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const beat = (typingNow: boolean) => {
      if (cancelled) return;
      setTyping(typingNow);

      if (typingNow) {
        timer = setTimeout(() => {
          if (cancelled) return;
          setTyping(false);
          setShown((current) => {
            const next = current >= copy.demo.chat.length ? 2 : current + 1;
            // Whoever wrote the message that just landed decides which side types next.
            setTypingOwn(copy.demo.chat[next % copy.demo.chat.length]?.own ?? false);
            return next;
          });
          beat(false);
        }, TYPING_MS);
        return;
      }

      timer = setTimeout(() => beat(true), MESSAGE_MS);
    };

    beat(false);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reduced, inView, copy.demo.chat]);

  // The composer types the upcoming message while it is your turn, and clears when it lands.
  useEffect(() => {
    if (reduced || !typing || !typingOwn) return;

    const text = copy.demo.chat[shown % copy.demo.chat.length]?.text ?? '';
    const step = Math.max(24, TYPING_MS / Math.max(text.length, 1));
    let index = 0;

    const timer = setInterval(() => {
      index += 1;
      setComposed(text.slice(0, index));
      if (index >= text.length) clearInterval(timer);
    }, step);

    return () => {
      clearInterval(timer);
      // The field empties as the message leaves it — on the way out of the typing beat, which is
      // where “sent” happens.
      setComposed('');
    };
  }, [reduced, typing, typingOwn, shown, copy.demo.chat]);

  return (
    <PageSection labelledBy="demo-heading">
      <SectionHeading title={copy.demo.title} subtitle={copy.demo.subtitle} id="demo-heading" />

      <div ref={ref} className={classes['layout']}>
        <div className={classes['window']}>
          <WindowChrome title={copy.demo.windowTitle} />

          <div className={classes['board']}>
            {copy.demo.columns.map((column, columnIndex) => {
              const cards = copy.demo.cards.filter(
                (_card, cardIndex) => columnOf[cardIndex] === columnIndex,
              );

              return (
                <div key={column} className={classes['column']}>
                  <span className={classes['columnHead']}>
                    {column}
                    <span className={classes['count']}>{cards.length}</span>
                  </span>

                  {cards.map((card) => (
                    <motion.div
                      key={card.title}
                      layoutId={card.title}
                      layout
                      className={classes['card']}
                      transition={{ type: 'spring', stiffness: 240, damping: 26 }}
                    >
                      <span className={classes['cardTitle']}>{card.title}</span>
                      <span className={classes['cardMeta']}>
                        <span className={classes['tag']}>{card.tag}</span>
                        <span className={classes['estimate']}>{card.estimate}</span>
                        <span className={classes['who']}>{card.who}</span>
                      </span>
                    </motion.div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className={classes['chat']}>
          <div className={classes['chatHead']}>
            <span className={classes['presence']}>
              {participantsOf(copy.demo.chat).map((message) => (
                <span key={message.author} className={classes['avatar']}>
                  {message.initials}
                </span>
              ))}
            </span>
            {copy.demo.online}
          </div>

          <div className={classes['thread']}>
            <AnimatePresence initial={false}>
              {copy.demo.chat.slice(0, shown).map((message) => (
                <motion.div
                  key={message.text}
                  layout
                  className={clsx(classes['message'], message.own && classes['messageOwn'])}
                  initial={{ opacity: 0, y: 12, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 26 }}
                >
                  <span className={classes['avatar']}>{message.initials}</span>
                  <span>
                    <span className={classes['author']}>{message.author}</span>
                    <br />
                    <span className={classes['bubble']}>{message.text}</span>
                  </span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <div className={classes['typingSlot']}>
            {typing ? (
              <span className={clsx(classes['typing'], typingOwn && classes['typingOwn'])}>
                <span className={classes['typingDots']} aria-hidden="true">
                  <span className={classes['typingDot']} />
                  <span className={classes['typingDot']} />
                  <span className={classes['typingDot']} />
                </span>
                {typingOwn ? copy.demo.youTyping : copy.demo.typing}
              </span>
            ) : null}
          </div>

          {/* Read-only: the animation is the point, and a field that takes input would be a promise
              this page cannot keep. It is still a real form control, so it is announced as one. */}
          <div className={classes['composer']}>
            <input
              className={classes['composerInput']}
              type="text"
              readOnly
              value={composed}
              placeholder={copy.demo.composerPlaceholder}
              aria-label={copy.demo.composerPlaceholder}
              tabIndex={-1}
            />
            <span
              className={clsx(classes['composerSend'], composed !== '' && classes['composerReady'])}
              aria-hidden="true"
            >
              {copy.demo.send}
            </span>
          </div>
        </div>
      </div>
    </PageSection>
  );
};
