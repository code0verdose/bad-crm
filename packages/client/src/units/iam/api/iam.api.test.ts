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

const USER_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';

const userPermissions = {
  userId: USER_ID,
  isOwner: false,
  version: 7,
  roles: [],
  permissions: [],
};

const respondUserPermissionsSlowly = (request: Request): Promise<Response> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(new Response(JSON.stringify(userPermissions), { status: 200 }));
    }, 50);

    request.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });

describe('reading one other person’s permissions', () => {
  it('passes the abort signal through, so navigating to another card cancels the stale request', async () => {
    vi.stubGlobal('fetch', (input: Request) => respondUserPermissionsSlowly(input));

    const { fetchUserPermissions } = await import('./iam.api.js');
    const controller = new AbortController();
    const pending = fetchUserPermissions(USER_ID, controller.signal);

    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
  });
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

/**
 * The three calls the invitations screen makes, and the two properties that are not about the
 * happy path: the list is cancellable, and closing an invitation survives a body-less answer.
 */

const INVITATION_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b01';

const invitation = {
  id: INVITATION_ID,
  email: 'ivan@example.test',
  roleId: null,
  teamIds: [],
  locale: 'en',
  invitedById: USER_ID,
  expiresAt: '2026-08-20T10:00:00.000Z',
  createdAt: '2026-08-13T10:00:00.000Z',
};

const respondInvitationsSlowly = (request: Request): Promise<Response> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(new Response(JSON.stringify({ items: [invitation] }), { status: 200 }));
    }, 50);

    request.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });

/** What the caller saw, so a case can name the method and the path rather than trust the type. */
const record = (): { calls: { method: string; path: string }[] } => {
  const calls: { method: string; path: string }[] = [];

  vi.stubGlobal('fetch', (input: Request) => {
    calls.push({ method: input.method, path: new URL(input.url).pathname });

    if (input.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
    if (input.method === 'POST') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: INVITATION_ID,
            email: invitation.email,
            inviteUrl: 'https://crm.example.test/invite/opaque',
            expiresAt: '2026-08-27T10:00:00.000Z',
            mailDispatched: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }

    return Promise.resolve(
      new Response(JSON.stringify({ items: [invitation] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  return { calls };
};

describe('listing the open invitations', () => {
  it('passes the abort signal through, so leaving the screen cancels the request', async () => {
    vi.stubGlobal('fetch', (input: Request) => respondInvitationsSlowly(input));

    const { fetchInvitations } = await import('./iam.api.js');
    const controller = new AbortController();
    const pending = fetchInvitations(controller.signal);

    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
  });

  it('unwraps the envelope to the rows themselves', async () => {
    const { calls } = record();

    const { fetchInvitations } = await import('./iam.api.js');

    await expect(fetchInvitations(new AbortController().signal)).resolves.toEqual([invitation]);
    expect(calls).toEqual([{ method: 'GET', path: '/api/v1/invitations' }]);
  });
});

describe('re-issuing an invitation', () => {
  it('posts to the invitation’s own resend path and answers with the new link', async () => {
    const { calls } = record();

    const { resendInvitation } = await import('./iam.api.js');

    await expect(resendInvitation(INVITATION_ID)).resolves.toMatchObject({
      inviteUrl: 'https://crm.example.test/invite/opaque',
    });
    expect(calls).toEqual([
      { method: 'POST', path: `/api/v1/invitations/${INVITATION_ID}/resend` },
    ]);
  });
});

describe('closing an invitation', () => {
  /**
   * `204` carries no body, and `unwrapApiResult` reads the status rather than the presence of
   * `data` — a call that treated «no document» as a failure would put a red toast on an operation
   * that worked.
   */
  it('deletes the invitation and settles on an answer with no body', async () => {
    const { calls } = record();

    const { revokeInvitation } = await import('./iam.api.js');

    await expect(revokeInvitation(INVITATION_ID)).resolves.toBeUndefined();
    expect(calls).toEqual([{ method: 'DELETE', path: `/api/v1/invitations/${INVITATION_ID}` }]);
  });

  it('rejects when the invitation is no longer there, carrying the code the screen shows', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'https://bad-crm.dev/problems/invitation_not_found',
            title: 'invitation_not_found',
            status: 404,
            code: 'invitation_not_found',
            requestId: 'req-1',
          }),
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const { revokeInvitation } = await import('./iam.api.js');

    await expect(revokeInvitation(INVITATION_ID)).rejects.toMatchObject({
      code: 'invitation_not_found',
    });
  });
});
