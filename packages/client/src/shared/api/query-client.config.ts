import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { type NotificationPort } from '@shared/lib';

import { isAbortError } from './abort.util.js';
import { errorMessage } from './error-message-key.util.js';
import { isApiError } from './problem.errors.js';

/** `rules/tanstack-query.mdc` §1. A per-query deviation carries a comment; there is no other. */
export const QUERY_RETRY_COUNT = 1;
export const QUERY_STALE_TIME_MS = 30_000;

/** One id for the whole class of mutation failures, suffixed by the code — see below. */
const MUTATION_ERROR_NOTIFICATION_ID = 'mutation-error';

const HTTP_UNAUTHORIZED = 401;

/**
 * 401 and a cancellation are not transient.
 *
 * A 401 that reaches here has already been through `auth-middleware.util.ts`: the refresh ran and
 * failed, or there was no session to refresh. Retrying doubles every request of a signed-out tab.
 * A cancellation is the user changing a filter, and retrying it re-issues the request they just
 * abandoned.
 */
const isRetryable = (error: unknown): boolean => {
  if (isAbortError(error)) return false;

  return !isApiError(error) || error.status !== HTTP_UNAUTHORIZED;
};

export interface AppQueryClientDeps {
  /** Where a user-visible failure goes. `SharedLib.silentNotifications` until EPIC-007. */
  readonly notify: NotificationPort;
  /** Where a failure goes that the user is not shown — every one of them. */
  readonly logError: (error: unknown) => void;
}

/**
 * The single `QueryClient` of the application, built by `app/providers.tsx`.
 *
 * A factory rather than a module singleton because both of its dependencies belong to layers above
 * this one: the toaster is a component, and the log sink is decided by the shell. A singleton here
 * would have to reach upwards for them, which is the FSD direction inverted, and would leave every
 * test sharing one cache.
 *
 * What it centralises is the two things a hook must not decide for itself: how long data stays
 * fresh, and who reports a failure.
 */
export const createAppQueryClient = ({ notify, logError }: AppQueryClientDeps): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => failureCount < QUERY_RETRY_COUNT && isRetryable(error),
        staleTime: QUERY_STALE_TIME_MS,
      },
    },

    /**
     * A failed query renders an inline error state with a retry, not a toast: background refetches
     * would otherwise shout at a user who did nothing (`rules/errors-and-toasts.mdc` §5). What the
     * failure does owe is a log line.
     */
    queryCache: new QueryCache({
      onError: (error) => {
        if (isAbortError(error)) return;

        logError(error);
      },
    }),

    /**
     * One logical action, at most one signal (`rules/errors-and-toasts.mdc` §2-§3).
     *
     * TanStack calls both this handler and the mutation's own `onError`, so a hook that handles its
     * failure locally would produce two toasts for one refusal. Stepping aside when the mutation
     * declares `onError` is what makes the local handler an override rather than an addition — the
     * exact wording of the rule, and the reason it is enforced here instead of by review.
     */
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (isAbortError(error)) return;

        logError(error);

        if (mutation.options.onError !== undefined) return;

        const { key: messageKey, values } = errorMessage(error);

        // The id carries the key, so repeats of the same failure update one toast while two
        // different failures stay visible side by side (`rules/errors-and-toasts.mdc` §6). The key
        // rather than the whole message: two rate limits a minute apart differ only in the seconds
        // left, and giving each its own id would stack the same sentence twice.
        notify.error({
          id: `${MUTATION_ERROR_NOTIFICATION_ID}:${messageKey}`,
          messageKey,
          ...(values === undefined ? {} : { values }),
        });
      },
    }),
  });
