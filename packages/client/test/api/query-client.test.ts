import type { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  apiErrorOf,
  createAppQueryClient,
  QUERY_RETRY_COUNT,
  QUERY_STALE_TIME_MS,
} from '@shared/api';
import { SharedLib } from '@shared';

const notify = { error: vi.fn(), success: vi.fn() };
const logError = vi.fn();

const makeClient = (): QueryClient => createAppQueryClient({ notify, logError });

const apiError = (status: number): ApiError =>
  new ApiError({
    code: status === 401 ? 'unauthenticated' : 'internal_error',
    status,
    requestId: 'req-1',
    issues: [],
  });

const abortError = (): Error => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal.reason as Error;
};

beforeEach(() => {
  notify.error.mockClear();
  notify.success.mockClear();
  logError.mockClear();
});

describe('cache defaults', () => {
  it('is the policy rules/tanstack-query.mdc §1 states, not a per-hook decision', () => {
    const defaults = makeClient().getDefaultOptions().queries;

    expect(QUERY_RETRY_COUNT).toBe(1);
    expect(QUERY_STALE_TIME_MS).toBe(30_000);
    expect(defaults?.staleTime).toBe(30_000);
  });

  it('retries a failed request exactly once', async () => {
    const client = makeClient();
    let attempts = 0;

    await expect(
      client.fetchQuery({
        queryKey: ['retry', '500'],
        queryFn: () => {
          attempts += 1;
          return Promise.reject(apiError(500));
        },
        retryDelay: 0,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(attempts).toBe(2);
  });

  /**
   * 401 is not a transient failure: the access token expired, and the answer is a refresh, which
   * `shared/api/auth-middleware.util.ts` has already performed and failed at by the time the error
   * reaches here. Retrying would double every request of a signed-out tab.
   */
  it('does not retry an unauthenticated response — the refresh already ran and failed', async () => {
    const client = makeClient();
    let attempts = 0;

    await expect(
      client.fetchQuery({
        queryKey: ['retry', '401'],
        queryFn: () => {
          attempts += 1;
          return Promise.reject(apiError(401));
        },
        retryDelay: 0,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(attempts).toBe(1);
  });

  it('does not retry a request the client itself cancelled', async () => {
    const client = makeClient();
    let attempts = 0;

    await expect(
      client.fetchQuery({
        queryKey: ['retry', 'abort'],
        queryFn: () => {
          attempts += 1;
          return Promise.reject(abortError());
        },
        retryDelay: 0,
      }),
    ).rejects.toBeTruthy();

    expect(attempts).toBe(1);
  });
});

/**
 * One logical action produces at most one signal (`rules/errors-and-toasts.mdc` §2-§3). The single
 * source of that signal is here, so that a hook cannot forget it and cannot duplicate it.
 */
describe('the single source of mutation errors', () => {
  const runMutation = async (
    client: QueryClient,
    options: { fail: unknown; onError?: () => void },
  ): Promise<void> => {
    const mutation = client.getMutationCache().build<void, Error, void, unknown>(client, {
      mutationFn: () => Promise.reject(options.fail),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      retry: false,
    });

    await mutation.execute().catch(() => undefined);
  };

  it('shows exactly one error notification, keyed by the stable code', async () => {
    await runMutation(makeClient(), { fail: apiError(409) });

    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error.mock.calls[0]?.[0]).toMatchObject({
      messageKey: 'errors.code.internal_error',
    });
  });

  it('gives the notification a stable id, so a repeated failure updates instead of stacking', async () => {
    const client = makeClient();

    await runMutation(client, { fail: apiError(409) });
    await runMutation(client, { fail: apiError(409) });

    const ids = notify.error.mock.calls.map((call) => (call[0] as { id: string }).id);

    expect(new Set(ids).size).toBe(1);
  });

  it('says nothing about a cancelled request — the user cancelled it', async () => {
    await runMutation(makeClient(), { fail: abortError() });

    expect(notify.error).not.toHaveBeenCalled();
  });

  /**
   * The failure this whole arrangement exists to prevent: a local `onError` that *adds* a second
   * toast for the same failure. A mutation that handles its own error owns the signal entirely.
   */
  it('steps aside when the mutation handles the error itself', async () => {
    const local = vi.fn();

    await runMutation(makeClient(), { fail: apiError(500), onError: local });

    expect(local).toHaveBeenCalledTimes(1);
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('still records the failure for the log even when the mutation handles it', async () => {
    await runMutation(makeClient(), { fail: apiError(500), onError: vi.fn() });

    expect(logError).toHaveBeenCalledTimes(1);
  });
});

/**
 * A query that fails renders an inline error state with a retry, not a toast
 * (`rules/errors-and-toasts.mdc` §5) — background refetches would otherwise shout at a user who did
 * nothing. What the failure does owe is a log line.
 */
describe('query failures', () => {
  it('are logged and not turned into a notification', async () => {
    const client = makeClient();

    await expect(
      client.fetchQuery({
        queryKey: ['query', 'error'],
        queryFn: () => Promise.reject(apiError(503)),
        retry: false,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(logError).toHaveBeenCalledTimes(1);
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('are silent when the query was cancelled', async () => {
    const client = makeClient();

    await expect(
      client.fetchQuery({
        queryKey: ['query', 'abort'],
        queryFn: () => Promise.reject(abortError()),
        retry: false,
      }),
    ).rejects.toBeTruthy();

    expect(logError).not.toHaveBeenCalled();
  });
});

describe('the placeholder notifier', () => {
  /**
   * The seam the design system fills. Until `shared/ui/toaster` exists (EPIC-007) the application
   * layer passes this one, and so does every non-interactive host — a test, a prerender. It is a
   * complete implementation of "do not notify", not an unfinished one.
   */
  it('accepts every notification a query client can produce, and shows none', () => {
    expect(() => {
      SharedLib.silentNotifications.error({ id: 'x', messageKey: 'errors.code.internal_error' });
      SharedLib.silentNotifications.success({ id: 'x', messageKey: 'ok' });
    }).not.toThrow();
  });
});

/**
 * A message that carries a value has to reach the toast with the value.
 *
 * The sink is the only place a mutation failure becomes a signal, so a `values` dropped here is
 * dropped everywhere — and the symptom is a sentence with a visible `{{seconds}}` in it, which no
 * other test in this suite would notice.
 */
describe('a failure that carries a value', () => {
  const rateLimited = () =>
    apiErrorOf(
      { code: 'rate_limited', requestId: 'r' },
      new Response(null, { status: 429, headers: { 'retry-after': '42' } }),
    );

  it('hands the interpolated value to the toaster', async () => {
    const client = makeClient();

    const mutation = client.getMutationCache().build<void, Error, void, unknown>(client, {
      mutationFn: () => Promise.reject(rateLimited()),
      retry: false,
    });
    await mutation.execute().catch(() => undefined);

    expect(notify.error).toHaveBeenCalledWith({
      // Keyed by the code and not by the finished sentence: two rate limits a minute apart differ
      // only in the seconds left, and an id carrying the number would stack them.
      id: 'mutation-error:errors.code.rate_limited',
      messageKey: 'errors.code.rate_limited',
      values: { seconds: 42 },
    });
  });
});
