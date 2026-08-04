import clsx from 'clsx';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { useReducedMotion } from '@/shared/lib/use-reduced-motion.hook.js';
import { PageSection } from '@/shared/ui/page-section.component.js';
import { SectionHeading } from '@/shared/ui/section-heading.component.js';
import { WindowChrome } from '@/shared/ui/window-chrome.component.js';

import { cipherNoise } from './cipher-noise.util.js';
import classes from './e2ee.module.css';

const CHIPS = ['XChaCha20-Poly1305', 'Argon2id', 'nonce: 24B', 'tag: 16B'];

/**
 * A literal id, not `useId`.
 *
 * There is exactly one of this field on the page, so the generated-id machinery buys nothing — and
 * React 19 generates ids containing `«` and `»`, which is the shape that breaks label lookup by
 * CSS selector in the testing library. A control whose label cannot be found by its text is a
 * control a screen-reader user may well not be able to find either.
 */
const SECRET_FIELD_ID = 'e2ee-secret';

/**
 * The longest secret the demonstration accepts.
 *
 * Every character re-renders the whole ciphertext as individually animated spans, so the cost grows
 * with the square of nothing sensible: 256 is well past any real password and short enough that the
 * field stays instant even while somebody holds a key down.
 */
const MAX_SECRET_LENGTH = 256;

/**
 * The one interactive section, and the only one that argues by demonstration.
 *
 * A single window: you type at the top, and what the server receives appears directly underneath.
 * Every character rewrites the whole thing below, which is the visible half of what authenticated
 * encryption guarantees — the ciphertext leaks nothing but a length. The status line says it in
 * numbers: bytes stored, and how much of it is readable by us.
 *
 * The claim in the copy is literally true of this page: the value stays in component state, there
 * is no network client in the bundle, and the landing package is linted against `fetch` and
 * `XMLHttpRequest` altogether (`eslint.config.js`, the landing block).
 */
export const E2ee = () => {
  const { copy } = useLocale();
  const reduced = useReducedMotion();
  const [secret, setSecret] = useState('');

  // Derived state, not an effect: the ciphertext is a pure function of the field.
  const cipher = useMemo(() => cipherNoise(secret), [secret]);

  return (
    <PageSection labelledBy="e2ee-heading">
      <div className={classes['layout']}>
        <div className={classes['window']}>
          <WindowChrome title={copy.e2ee.windowTitle} />

          <div className={classes['pane']}>
            <label className={classes['label']} htmlFor={SECRET_FIELD_ID}>
              <span className={classes['labelDot']} aria-hidden="true" />
              {copy.e2ee.inputLabel}
            </label>

            <span className={classes['field']}>
              <svg
                className={classes['fieldIcon']}
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12 1a5 5 0 0 0-5 5v3H5.5A1.5 1.5 0 0 0 4 10.5v11A1.5 1.5 0 0 0 5.5 23h13a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 18.5 9H17V6a5 5 0 0 0-5-5zm0 2a3 3 0 0 1 3 3v3H9V6a3 3 0 0 1 3-3z" />
              </svg>
              <input
                id={SECRET_FIELD_ID}
                className={classes['input']}
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={MAX_SECRET_LENGTH}
                placeholder={copy.e2ee.inputPlaceholder}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </span>

            <div className={classes['chips']}>
              {CHIPS.map((chip) => (
                <span key={chip} className={classes['chip']}>
                  {chip}
                </span>
              ))}
            </div>

            <div className={classes['output']}>
              <span className={classes['label']}>
                <span
                  className={clsx(classes['labelDot'], classes['serverDot'])}
                  aria-hidden="true"
                />
                {copy.e2ee.serverLabel}
              </span>

              {/* Polite, not assertive: the reader is typing, and an assertive region would interrupt
                them on every keystroke. The text itself is the ciphertext, which is unreadable
                aloud — so the region announces the empty state and nothing else. */}
              <p
                className={clsx(classes['cipher'], cipher === '' && classes['empty'])}
                aria-live="polite"
              >
                {cipher === ''
                  ? copy.e2ee.emptyState
                  : [...cipher].map((character, index) =>
                      reduced ? (
                        character
                      ) : (
                        <motion.span
                          key={`${index}-${character}`}
                          initial={{ opacity: 0.25 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.25 }}
                        >
                          {character}
                        </motion.span>
                      ),
                    )}
              </p>

              <span className={classes['status']}>
                <span>
                  {cipher.length} {copy.e2ee.bytesLabel}
                </span>
                <span>0 {copy.e2ee.readableLabel}</span>
              </span>
            </div>
          </div>
        </div>

        <div className={classes['text']}>
          <SectionHeading title={copy.e2ee.title} subtitle={copy.e2ee.subtitle} id="e2ee-heading" />
          <p className={classes['note']}>{copy.e2ee.note}</p>
        </div>
      </div>
    </PageSection>
  );
};
