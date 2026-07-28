import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';

import { QueryDevtools } from './query-devtools.component.js';
import { appTheme } from './theme/app-theme.config.js';
import { styleNonce } from './style-nonce.util.js';

/** Failures and confirmations belong where the eye already is: near the primary action. */
const NOTIFICATIONS_POSITION = 'top-right';

/**
 * How many signals may share the screen before the rest wait in the queue.
 *
 * A number, because a stack of toasts is a wall: past three the newest ones push the older ones out
 * of the corner of the eye and nothing is read at all. `notify` already collapses repeats of one
 * failure into one toast, so reaching this limit means three genuinely different things went wrong.
 */
const NOTIFICATIONS_LIMIT = 3;

export interface ProvidersProps {
  /** Built by the composition root, so a test can pass a cache of its own. */
  readonly queryClient: QueryClient;
  readonly children: ReactNode;
}

/**
 * The provider tree: theme, notifications, query cache. Nothing else belongs here.
 *
 * `defaultColorScheme="auto"` is the product default (`rules/design-system.mdc` §4): a first visit
 * follows `prefers-color-scheme`, and an explicit choice is remembered by Mantine in
 * `localStorage` and applied in a layout effect — before paint, so there is no flash of the wrong
 * theme.
 *
 * `getStyleNonce` is what lets the provider's `<style>` element survive the CSP of ADR-0023. It is
 * a function rather than a value because the nonce is per document, not per build.
 *
 * `<Notifications />` is mounted exactly once, here. Two of them means every toast appears twice
 * (`rules/errors-and-toasts.mdc` §1), and it is a mistake that renders perfectly.
 *
 * The query devtools are mounted here too, inside the cache they inspect. `QueryDevtools` is `null`
 * in anything but a dev-server build — see that module for why the check has to be on a constant
 * rather than on a flag.
 */
export function Providers({ queryClient, children }: ProvidersProps) {
  // Read once per mount, and only passed when there is something to pass: `getStyleNonce` must
  // return a string, and returning `''` would write `nonce=""` — an attribute that matches no
  // policy and blocks the element it was meant to allow.
  const nonce = useMemo(() => styleNonce(), []);

  return (
    <MantineProvider
      defaultColorScheme="auto"
      theme={appTheme}
      {...(nonce === undefined ? {} : { getStyleNonce: () => nonce })}
    >
      <Notifications limit={NOTIFICATIONS_LIMIT} position={NOTIFICATIONS_POSITION} />
      <QueryClientProvider client={queryClient}>
        {children}
        {QueryDevtools === null ? null : <QueryDevtools />}
      </QueryClientProvider>
    </MantineProvider>
  );
}
