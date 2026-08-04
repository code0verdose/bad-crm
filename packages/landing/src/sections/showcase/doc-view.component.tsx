import { useLocale } from '@/app/i18n/use-locale.hook.js';

import classes from './app-frame.module.css';

/**
 * The document view: the same window, a different domain.
 *
 * It exists so the sidebar means something. A mock-up that only ever shows a board is an argument
 * for a board; the section's claim is that the board, the document and the timesheet are one
 * installation, and the only way to show that is to switch between them.
 */
export const DocView = () => {
  const { copy } = useLocale();
  const doc = copy.showcase.frame.views.doc;

  return (
    <div className={classes['doc']}>
      <h4 className={classes['docHeading']}>{doc.title}</h4>

      {doc.lines.map((line) => (
        <p key={line} className={classes['docParagraph']}>
          {line}
        </p>
      ))}

      <span className={classes['docCallout']}>{doc.callout}</span>
    </div>
  );
};
