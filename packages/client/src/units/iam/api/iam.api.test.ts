import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one call of the unit, and the one thing about it worth a test of its own: **the abort signal
 * is passed on**.
 *
 * This is a query, so it is re-issued whenever its key changes, and the request left behind has to
 * be cancelled — otherwise a stale answer can land after a fresh one and overwrite it
 * (`rules/tanstack-query.mdc` §4). The signal is optional in the signature, so there are two shapes
 * to prove: with one, and without.
 *
 * The typed client captures `fetch` when the module is evaluated, so the stub has to be in place
 * **before** the import — hence `resetModules` and the dynamic import in each case. And the
 * assertion is on **behaviour**, not on the argument: the client folds the options into a `Request`,
 * which always carries a signal of its own, so «was the caller's signal used» is only answerable by
 * aborting it and watching what happens.
 */

const permissions = {
  permissions: ['task:read'],
  denied: [],
  roles: ['manager'],
  isOwner: false,
  version: 3,
};

const respond = (): Promise<Response> =>
  Promise.resolve(
    new Response(JSON.stringify(permissions), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

/** Answers only once the caller stops waiting, which is what an abort has to interrupt. */
const respondSlowly = (request: Request): Promise<Response> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(new Response(JSON.stringify(permissions), { status: 200 }));
    }, 50);

    request.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading one’s own permissions', () => {
  it('passes the abort signal through, so a superseded request is cancelled', async () => {
    vi.stubGlobal('fetch', (input: Request) => respondSlowly(input));

    const { fetchMyPermissions } = await import('./iam.api.js');
    const controller = new AbortController();
    const pending = fetchMyPermissions(controller.signal);

    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
  });

  it('answers normally when there is none to pass', async () => {
    vi.stubGlobal('fetch', () => respond());

    const { fetchMyPermissions } = await import('./iam.api.js');

    await expect(fetchMyPermissions()).resolves.toMatchObject({ version: 3 });
  });
});
