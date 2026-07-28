import classes from './skip-link.module.css';

/** The id `AppShell.Main` carries; the two have to agree or the link goes nowhere. */
export const MAIN_CONTENT_ID = 'main';

/**
 * The first focusable element on the page (`rules/a11y.mdc` §19).
 *
 * Without it, every keyboard user tabs through the whole navigation before reaching the content —
 * on every page, forever. It is invisible until focused, which is why it is easy to forget and easy
 * to break: `.visually-hidden` that stays hidden *while focused* is the same as not having it.
 *
 * A plain `<a href="#main">` and not a router `Link`: this is movement inside the current document,
 * and routing it would be a navigation that lands in the same place having lost the focus target.
 */
export function SkipLink() {
  return (
    <a className={classes['link']} href={`#${MAIN_CONTENT_ID}`}>
      common.a11y.skipToContent
    </a>
  );
}
