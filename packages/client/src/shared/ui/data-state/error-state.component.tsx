import { Alert, Button, Stack } from '@mantine/core';

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
 * person. Until i18next lands (EPIC-008) the key is what is rendered — the substitution to
 * `t(messageKey)` is mechanical and happens here.
 */
export function ErrorState({
  messageKey,
  onRetry,
  retryLabelKey = 'common.retry',
}: ErrorStateProps) {
  return (
    <Alert
      className={classes['root']}
      color="red"
      role="alert"
      title={messageKey}
      variant="light"
      data-testid="error-state"
    >
      <Stack align="flex-start" gap="sm">
        {onRetry !== undefined && (
          <Button color="red" onClick={onRetry} size="xs" variant="outline">
            {retryLabelKey}
          </Button>
        )}
      </Stack>
    </Alert>
  );
}
