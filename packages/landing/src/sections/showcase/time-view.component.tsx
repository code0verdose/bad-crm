import { useLocale } from '@/app/i18n/use-locale.hook.js';

import classes from './app-frame.module.css';

/**
 * The timesheet view. The hours are the same hours the board's cards carry — that is the point of
 * showing it in the same window.
 */
export const TimeView = () => {
  const { copy } = useLocale();
  const time = copy.showcase.frame.views.time;

  return (
    <div className={classes['sheet']}>
      <span className={classes['sheetTitle']}>{time.title}</span>

      <div className={classes['sheetHead']}>
        {time.columns.map((column) => (
          <span key={column}>{column}</span>
        ))}
      </div>

      {time.rows.map((row) => (
        <div key={row.task} className={classes['sheetRow']}>
          <span className={classes['sheetTask']}>{row.task}</span>
          <span className={classes['who']}>{row.who}</span>
          <span className={classes['sheetHours']}>{row.hours}</span>
        </div>
      ))}

      <div className={classes['sheetTotal']}>
        <span>{time.totalLabel}</span>
        <span className={classes['sheetHours']}>{time.totalValue}</span>
      </div>
    </div>
  );
};
