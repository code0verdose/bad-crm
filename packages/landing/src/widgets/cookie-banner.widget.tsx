import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { type Consent, readConsent, writeConsent } from '@/shared/lib/consent.util.js';
import { navigate, ROUTES } from '@/shared/lib/use-route.hook.js';

import classes from './cookie-banner.module.css';

/**
 * The cookie banner.
 *
 * It is shown once, until answered, and it asks a real question with two equally weighted answers.
 * The rules it keeps — nothing optional before consent, refusing as easy as accepting, the answer
 * stored and withdrawable — live in `consent.util.ts`, next to the storage they govern.
 *
 * The stored answer is read once, in the state initialiser. There is no server rendering here, so
 * reading `localStorage` on the first render is safe — and it is the version that cannot flash the
 * banner at somebody who answered months ago, which an effect-then-setState would.
 */
export const CookieBanner = () => {
  const { copy } = useLocale();
  const [answered, setAnswered] = useState<Consent | null>(() => readConsent());

  const answer = (consent: Consent) => {
    writeConsent(consent);
    setAnswered(consent);
  };

  return (
    <AnimatePresence>
      {answered === null ? (
        <motion.aside
          className={classes['banner']}
          /* Not `role="dialog"`: nothing here is modal, focus is neither moved into the banner nor
             trapped in it, and claiming a dialog tells a screen-reader user the page is blocked
             when it is not. A labelled region is what it actually is. */
          role="region"
          aria-label={copy.cookies.title}
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 24 }}
          transition={{ duration: 0.35 }}
        >
          <div className={classes['text']}>
            <span className={classes['title']}>{copy.cookies.title}</span>
            <span className={classes['body']}>
              {copy.cookies.body}{' '}
              <a
                className={classes['more']}
                href={ROUTES.cookies}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(ROUTES.cookies);
                }}
              >
                {copy.cookies.more}
              </a>
            </span>
          </div>

          <div className={classes['actions']}>
            <button type="button" className={classes['choice']} onClick={() => answer('necessary')}>
              {copy.cookies.reject}
            </button>
            <button type="button" className={classes['choice']} onClick={() => answer('all')}>
              {copy.cookies.accept}
            </button>
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
};
