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

  it('carries the tenant and user fields EPIC-006 fills in, as null from day one', () => {
    const contexts = new AsyncRequestContextAdapter();

    const seen = contexts.run(contextOf('request-1'), () => contexts.current());

    expect(seen).toEqual({ requestId: 'request-1', organizationId: null, userId: null });
  });
});
