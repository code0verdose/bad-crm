import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AuthTypes } from '@units/auth';

/**
 * The session as the router reads it — a live view over the store, not a snapshot of it.
 *
 * Both properties are getters, and the reason is written out in `app/router-auth.util.ts`: the
 * router context is built once and closed over by every `beforeLoad`, so a plain object would freeze
 * the answer at the moment it was made and every guard would keep deciding on the session the tab
 * had at startup. What is asserted here is exactly that — the same object, read twice, across a
 * change of session.
 *
 * `mfaEnrollment` has a second property worth pinning: it is **absent** rather than `false` for a
 * session the organization's policy says nothing about, and absent for a tab with no session at
 * all, because `requireFullSession` branches on presence.
 */
/** Branded ids, cast the way `auth-session.store.test.ts` casts them: the brand is the schema's. */
const IDENTITY = {
  userId: 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
  organizationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
} as AuthTypes.SessionIdentity;

const SCOPED = { ...IDENTITY, mfaEnrollment: true } as AuthTypes.SessionIdentity;

/** A store and a view of this case's own, rather than whatever the previous one signed in as. */
const freshView = async () => {
  vi.resetModules();

  const [{ routerAuth }, { AuthService }] = await Promise.all([
    import('@app/router-auth.util.js'),
    import('@units/auth'),
  ]);

  return { routerAuth, session: AuthService.authSession };
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the session the router reads', () => {
  it('reports no enrolment scope while there is no session to read one from', async () => {
    const { routerAuth } = await freshView();

    expect(routerAuth.status).toBe('unknown');
    expect(routerAuth.mfaEnrollment).toBeUndefined();
  });

  it('carries the enrolment scope of the session the tab currently holds', async () => {
    const { routerAuth, session } = await freshView();

    session.start(SCOPED);

    expect(routerAuth.status).toBe('authenticated');
    expect(routerAuth.mfaEnrollment).toBe(true);
  });

  /**
   * The live half. An ordinary session says nothing about enrolment, and the same object has to say
   * so *afterwards* — a value captured when the context was built would still be reporting the
   * scoped session above.
   */
  it('follows the session rather than the moment it was built', async () => {
    const { routerAuth, session } = await freshView();

    session.start(SCOPED);
    session.start(IDENTITY);

    expect(routerAuth.mfaEnrollment).toBeUndefined();

    session.end();

    expect(routerAuth.status).toBe('anonymous');
    expect(routerAuth.mfaEnrollment).toBeUndefined();
  });
});
