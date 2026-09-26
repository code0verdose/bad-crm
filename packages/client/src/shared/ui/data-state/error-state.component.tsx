import { Alert, Button, Stack } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { focusSectionHeading } from '@shared/ui';

import classes from './error-state.module.css';

export interface ErrorStateProps {
  /** i18n key of the sentence shown to the user. Never a message from the server. */
  readonly messageKey: string;
  /** Absent when there is nothing sensible to retry — then the state explains and stops. */
  readonly onRetry?: () => void;
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
 * **Where focus goes after «Retry».** A successful retry unmounts this whole alert, the pressed
 * button with it, and focus would fall to `<body>`. Inside a `Section` the press moves focus to the
 * section's heading first — the one element that survives both outcomes and says where the reader
 * is. It happens in the handler, at the reader's action (`rules/frontend-fsd.mdc` rule 11), rather
 * than in an effect waiting for success: a query in `error` keeps that status while it refetches,
 * so there is no «loading» render to wait through, and the heading is already on screen. If the
 * retry fails again the alert stays, and the button is the next Tab stop. Outside a section — the
 * route's error boundary — nothing moves here; the route announcer returns focus to the page
 * heading once the route settles.
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
        {onRetry !== undefined && (
          <Button
            color="danger"
            onClick={(event) => {
              focusSectionHeading(event.currentTarget);
              onRetry();
            }}
            size="xs"
            variant="outline"
          >
            {t(retryLabelKey)}
          </Button>
        )}
      </Stack>
    </Alert>
  );
}
