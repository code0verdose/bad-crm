import { Code } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import classes from './recovery-codes-list.module.css';

export interface RecoveryCodesListProps {
  readonly codes: readonly string[];
}

/**
 * The ten codes, as a list — a real `ul`, not a grid of `div`s.
 *
 * A screen reader then says «list, ten items» and can walk them one at a time, which is the only
 * way somebody who cannot see the block is going to copy ten strings of ten characters onto paper.
 * The columns are a grid *layout* over the same list.
 *
 * The block is also the print target: `data-bc-print` marks it, and the one global print rule in
 * `app/global.css` hides everything that is not this when the dialog is on screen. A person who
 * presses Print should get ten codes on one page, not a screenshot of an application.
 */
export function RecoveryCodesList({ codes }: RecoveryCodesListProps) {
  const { t } = useTranslation();

  return (
    <ul aria-label={t('security.codes.list.aria')} className={classes['list']} data-bc-print>
      {codes.map((code) => (
        <li key={code}>
          <Code className={classes['code']}>{code}</Code>
        </li>
      ))}
    </ul>
  );
}
