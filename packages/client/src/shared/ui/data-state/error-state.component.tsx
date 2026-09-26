import { Alert, Stack } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import classes from './error-state.module.css';
import { RetryButton } from './retry-button.component.js';

export interface ErrorStateProps {
  /** i18n key of the sentence shown to the user. Never a message from the server. */
  readonly messageKey: string;
  /**
   * Absent when there is nothing sensible to retry — then the state explains and stops. Return the
   * reload's promise (`refetch()`, `router.invalidate()`) and «Retry» stays busy until it settles.
   */
  readonly onRetry?: () => Promise<unknown>;
  readonly retryLabelKey?: string;
}

/**
 * The one way a screen says «this did not load».
 *
 * Inline, with a retry, and not a toast: a toast for a failed query would shout at a user who did
 * nothing, and it disappears before it can be acted on (`rules/errors-and-toasts.mdc` §5). The
 * same component is what a route's `errorComponent` renders, so a broken route and a broken list
 * look and behave alike.
 *
 * The text comes from a **key**, chosen by the caller from the error `code`
 * (`rules/errors-and-toasts.mdc` §10): `detail` from `problem+json` is for the log, not for the
 * person. Both keys are resolved here — the message and the retry label.
 *
 * **The label was rendered raw until 2026-08-13**, so every failed screen offered a button reading
 * `common.retry`. Nothing caught it: the suite's default i18next runs in `cimode`, where `t(key)`
 * returns the key, so a forgotten `t()` renders identically to a present one and
 * `data-state.test.tsx` asserting `{ name: 'common.retry' }` passed either way. Only the pseudo
 * locale can tell them apart, and it was pointed at two happy-path routes where no error state
 * appears — `test/i18n/pseudo-locale.test.tsx` now covers this component directly.
 *
 * **Where focus goes after «Retry»** — `useRetry` (`use-retry.hook.ts`) owns it. Focus stays on the
 * button, busy, until the reload answers: a failure again leaves this alert unchanged, and an
 * unchanged live region is silent, so the button is the only thing that can tell the reader. A
 * success unmounts the alert with the button, and focus goes to the heading of the enclosing
 * `Section` rather than falling to `<body>`. Outside a section — the route's error boundary —
 * nothing moves here; the route announcer returns focus to the page heading once the route settles.
 */
export function ErrorState({
  messageKey,
  onRetry,
  retryLabelKey = 'common.retry',
}: ErrorStateProps) {
  const { t } = useTranslation();

  return (
    <Alert
      className={classes['root']}
      color="danger"
      role="alert"
      title={t(messageKey)}
      variant="light"
      data-testid="error-state"
    >
      <Stack align="flex-start" gap="sm">
        {onRetry !== undefined && <RetryButton labelKey={retryLabelKey} onRetry={onRetry} />}
      </Stack>
    </Alert>
  );
}
