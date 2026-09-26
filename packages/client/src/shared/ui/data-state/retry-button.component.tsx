import { Button, Loader } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { useRetry } from './use-retry.hook.js';

export interface RetryButtonProps {
  /** Starts the reload. Return its promise and the button is busy until it settles. */
  readonly onRetry: () => Promise<unknown>;
  readonly labelKey: string;
}

/**
 * «Retry» of an error state, busy on itself while the reload runs (`rules/errors-and-toasts.mdc`
 * §7: an action started from a button shows its loading on that button).
 *
 * **Busy is `aria-disabled`, not Mantine's `loading`.** `loading` sets the native `disabled`
 * attribute, and a focused control that becomes disabled stops being focusable: under the HTML focus
 * fixup rule focus goes back to `<body>` — off the very control `useRetry` keeps it on until the
 * outcome. `aria-disabled` plus the disabled look (`data-disabled`) says «unavailable» to a screen
 * reader and to the eye while the button keeps focus, the pattern `rules/a11y.mdc` §23 names for a
 * control that must stay reachable. A second press is refused by the hook, not by the attribute.
 */
export function RetryButton({ onRetry, labelKey }: RetryButtonProps) {
  const { t } = useTranslation();
  const { retrying, retry, controlRef } = useRetry(onRetry);

  return (
    <Button
      ref={controlRef}
      aria-disabled={retrying || undefined}
      color="danger"
      data-disabled={retrying}
      leftSection={retrying && <Loader aria-hidden color="danger" size="xs" />}
      onClick={retry}
      size="xs"
      variant="outline"
    >
      {t(labelKey)}
    </Button>
  );
}
