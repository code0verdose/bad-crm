import clsx from 'clsx';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { LOCALES } from '@/app/i18n/locale.types.js';

import classes from './switches.module.css';

/**
 * The two languages, both always visible.
 *
 * A single toggle labelled with the *other* language is smaller and is the usual choice; it is also
 * the one that makes a reader guess whether the label is the current state or the action. Two
 * options with `aria-pressed` say both things at once.
 */
export const LanguageSwitch = () => {
  const { locale, setLocale, copy } = useLocale();

  return (
    <div className={classes['group']} role="group" aria-label={copy.meta.switchLanguage}>
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === locale}
          className={clsx(classes['option'], option === locale && classes['selected'])}
          onClick={() => setLocale(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
};
