import { describe, expect, it } from 'vitest';

import { AsyncRequestContextAdapter } from '../../../src/infrastructure/logging/async-request-context.adapter.js';
import type { RequestContext } from '../../../src/application/platform/ports/request-context.port.js';

const contextOf = (requestId: string): RequestContext => ({
  requestId,
  organizationId: null,
  userId: null,
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('request context', () => {
  it('is visible to code that never received it as an argument', () => {
    const contexts = new AsyncRequestContextAdapter();
    const deepInsideSomeUseCase = (): string | undefined => contexts.current()?.requestId;

    const seen = contexts.run(contextOf('request-1'), () => deepInsideSomeUseCase());

    expect(seen).toBe('request-1');
  });

  it('survives await boundaries, which is the whole reason it is not a module variable', async () => {
    const contexts = new AsyncRequestContextAdapter();

    const seen = await contexts.run(contextOf('request-1'), async () => {
      await delay(1);
      await delay(1);

      return contexts.current()?.requestId;
    });

    expect(seen).toBe('request-1');
  });

  /**
   * The failure this prevents is the worst kind of logging bug: request A's identifier attached to
   * request B's lines. With a module-level variable the two interleaved requests below would end up
   * sharing whichever context was set last, and nothing about the log would look wrong.
   */
  it('does not leak between requests running at the same time', async () => {
    const contexts = new AsyncRequestContextAdapter();

    const handle = async (requestId: string, pause: number): Promise<string | undefined> =>
      contexts.run(contextOf(requestId), async () => {
        await delay(pause);

        return contexts.current()?.requestId;
      });

    await expect(Promise.all([handle('request-1', 5), handle('request-2', 1)])).resolves.toEqual([
      'request-1',
      'request-2',
    ]);
  });

  it('reports no context outside a request, so a startup line is not attributed to one', () => {
    expect(new AsyncRequestContextAdapter().current()).toBeUndefined();
  });

  it('starts a request with the tenant and user fields empty, before any credential is read', () => {
    const contexts = new AsyncRequestContextAdapter();

    const seen = contexts.run(contextOf('request-1'), () => contexts.current());

    expect(seen).toEqual({ requestId: 'request-1', organizationId: null, userId: null });
  });
});

/**
 * The half EPIC-006 was supposed to deliver: who the request turned out to be from.
 *
 * The fields existed from day one and stayed `null` on every line of every authenticated request,
 * because nothing ever wrote them — the guard put the caller in `res.locals` instead. The cost is
 * paid during an incident: "who closed somebody else's sessions" becomes a manual join of log lines
 * by timestamp, and any line written before the completion line carries no subject at all.
 */
describe('identifying the caller mid-request', () => {
  const caller = { organizationId: 'org-1', userId: 'user-1' };

  it('fills in the tenant and the user for every line written afterwards', async () => {
    const contexts = new AsyncRequestContextAdapter();

    const seen = await contexts.run(contextOf('request-1'), async () => {
      contexts.identify(caller);
      // After an await, because the guard identifies the caller and the use-case logs several
      // awaits later: a context that only survived to the next statement would be useless.
      await delay(1);

      return contexts.current();
    });

    expect(seen).toEqual({ requestId: 'request-1', ...caller });
  });

  it('does not touch a request running beside it', async () => {
    const contexts = new AsyncRequestContextAdapter();

    const handle = async (
      requestId: string,
      identity: { organizationId: string; userId: string } | undefined,
      pause: number,
    ): Promise<RequestContext | undefined> =>
      contexts.run(contextOf(requestId), async () => {
        if (identity !== undefined) contexts.identify(identity);
        await delay(pause);

        return contexts.current();
      });

    await expect(
      Promise.all([handle('request-1', caller, 5), handle('request-2', undefined, 1)]),
    ).resolves.toEqual([
      { requestId: 'request-1', ...caller },
      { requestId: 'request-2', organizationId: null, userId: null },
    ]);
  });

  /**
   * Jobs and startup run outside `run()`. Writing an identity there would either throw or invent a
   * store that outlives every request — the ambient context has to stay empty instead.
   */
  it('is a no-op outside a request', () => {
    const contexts = new AsyncRequestContextAdapter();

    contexts.identify(caller);

    expect(contexts.current()).toBeUndefined();
  });
});
