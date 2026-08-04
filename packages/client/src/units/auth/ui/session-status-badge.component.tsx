import { useTranslation } from 'react-i18next';

import { SESSION_STATUS_LABEL_KEY, type SessionStatus } from '@units/auth/model';

export interface SessionStatusBadgeProps {
  readonly status: SessionStatus;
}

/**
 * Shows the state of the session. Markup and one prop — the state itself is decided by
 * `useBootstrapSession`, one layer down.
 *
 * The label is a **key** in the model and a sentence only here: `data-session-status` is what a test
 * and a stylesheet key off, so neither depends on the wording. The key used to be rendered as-is,
 * «until the catalogue arrives» — it has arrived (EPIC-008), and the pseudo-locale check is what
 * noticed that this component had not been told.
 */
export function SessionStatusBadge({ status }: SessionStatusBadgeProps) {
  const { t } = useTranslation();

  return <span data-session-status={status}>{t(SESSION_STATUS_LABEL_KEY[status])}</span>;
}
