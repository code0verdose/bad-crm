import { Alert, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

export interface SuspendedAccountNoticeProps {
  /**
   * The leaving date on the personnel record, or `null` when there is none — either because nobody
   * entered one or because this caller was not shown the employment half of the document.
   */
  readonly terminatedAt: string | null;
}

/**
 * «This account is switched off», on the personnel card.
 *
 * **Whether to draw it is decided by `status`, upstream, and never by the date below.**
 * `terminatedAt` is an editable HR field under `employee:update`; the two agree today by convention
 * rather than by construction, and the first administrator to enter a notice period in advance would
 * otherwise be shown a working account as disabled — with a button offering to bring back somebody
 * who has not left. That is decision D4 of STORY-012-09, and the reason this component takes the
 * date as decoration rather than as the fact.
 *
 * **The date is optional for a second reason.** A caller who may see the account state need not hold
 * `employee:view_personal_data`, so the plate has to be able to say «off» without saying «since
 * when» — an `Alert` with a missing sentence is better than one that invents a date.
 *
 * **Rendered in `UTC`.** `terminatedAt` is a calendar day (`format: date`), not an instant: a day has
 * no time zone, and pushing it through the reader's would move it backwards for everybody west of
 * Greenwich. The same reasoning `units/iam/lib/utils/override-expiry.util.ts` writes out at length
 * for the other calendar day in this product.
 */
export function SuspendedAccountNotice({ terminatedAt }: SuspendedAccountNoticeProps) {
  const { t, i18n } = useTranslation();

  return (
    <Alert color="warning" title={t('employee.suspended.title')} variant="light">
      <Text size="sm">{t('employee.suspended.description')}</Text>
      {terminatedAt !== null && (
        <Text size="sm">
          {t('employee.suspended.since', {
            date: SharedLib.formatDate(terminatedAt, i18n.language, 'UTC'),
          })}
        </Text>
      )}
    </Alert>
  );
}
