import { isNotFound } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

import { QueryKeys } from '@shared/lib';

/**
 * STORY-014-05, acceptance 2: somebody without access to a project is sent to the not-found screen
 * **before** the layout renders — and that screen is word for word the one for an address that
 * never existed, because the server answers every outsider `404` (invariant 2).
 */

const PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b21';

const problem = (status: number, code: string): Response =>
  new Response(JSON.stringify({ type: 'about:blank', title: 'x', status, code, requestId: 'r' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

const project = (): Response =>
  new Response(
    JSON.stringify({
      id: PROJECT_ID,
      key: 'BAD',
      name: 'Bad CRM',
      description: null,
      status: 'ACTIVE',
      visibility: 'PRIVATE',
      leadId: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11',
      color: 'brand',
      memberCount: 1,
      startedAt: null,
      dueAt: null,
      taskCounter: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const freshClient = () =>
  SharedApi.createAppQueryClient({
    notify: { error: vi.fn(), success: vi.fn() },
    logError: vi.fn(),
  });

/**
 * The guard is imported **after** `fetch` is stubbed: `openapi-fetch` binds the transport when the
 * client module is evaluated, so a static import would keep the platform `fetch`.
 */
const run = async (queryClient = freshClient()): Promise<unknown> => {
  vi.resetModules();
  const { requireProjectAccess } = await import('./require-project-access.guard.js');

  try {
    await requireProjectAccess({ context: { queryClient }, params: { projectId: PROJECT_ID } });

    return undefined;
  } catch (error) {
    return error;
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requireProjectAccess', () => {
  it('CONTROL: lets a readable project through and leaves it in the cache for the screen', async () => {
    const calls = vi.fn(() => Promise.resolve(project()));
    vi.stubGlobal('fetch', calls);
    const queryClient = freshClient();

    expect(await run(queryClient)).toBeUndefined();
    expect(queryClient.getQueryData(QueryKeys.Projects.detail(PROJECT_ID))).toMatchObject({
      key: 'BAD',
    });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 404, code: 'project_not_found' },
    { status: 403, code: 'user_forbidden' },
  ])(
    'turns $status into the not-found screen, asked once and not retried',
    async ({ status, code }) => {
      const calls = vi.fn(() => Promise.resolve(problem(status, code)));
      vi.stubGlobal('fetch', calls);

      expect(isNotFound(await run())).toBe(true);
      // An answer is not a failure: retrying a 404 only delays the screen by the retry delay.
      expect(calls).toHaveBeenCalledTimes(1);
    },
  );

  it('lets any other failure through to the error boundary, which offers a retry', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem(500, 'internal_error')));

    const error = await run();

    expect(isNotFound(error)).toBe(false);
    // Read structurally: the error class belongs to the freshly evaluated modules, not this file's.
    expect(error).toMatchObject({ name: 'ApiError', status: 500, code: 'internal_error' });
  });
});

/**
 * STORY-014-06, acceptance 6: a project that answers «not found» to somebody who was working in it
 * may mean their rights changed under them — taken off the project, or a role that no longer reads
 * projects. The server keeps no cache of rights (`build-actor.query.ts`); the client does, in the
 * query cache, so the guard marks the reader's own rights stale and the shell asks
 * `GET /me/permissions` again — its `ETag` carries `permissionsVersion`.
 */
describe('requireProjectAccess and the reader’s own rights', () => {
  const OTHER_USER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b13';

  const seeded = () => {
    const queryClient = freshClient();

    queryClient.setQueryData(QueryKeys.Permissions.mine(), { permissions: ['project:read'] });
    // Somebody else's rights on the administration screen: a project refusal says nothing of them.
    queryClient.setQueryData(QueryKeys.Permissions.ofUser(OTHER_USER), { permissions: [] });

    return queryClient;
  };

  const stale = (queryClient: ReturnType<typeof freshClient>, key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated;

  it.each([
    { status: 404, code: 'project_not_found' },
    { status: 403, code: 'user_forbidden' },
  ])(
    'marks the reader’s own rights stale on $status, and only theirs',
    async ({ status, code }) => {
      vi.stubGlobal('fetch', () => Promise.resolve(problem(status, code)));
      const queryClient = seeded();

      expect(isNotFound(await run(queryClient))).toBe(true);
      expect(stale(queryClient, QueryKeys.Permissions.mine())).toBe(true);
      expect(stale(queryClient, QueryKeys.Permissions.ofUser(OTHER_USER))).toBe(false);
    },
  );

  it('CONTROL: leaves the rights alone when the project opens', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(project()));
    const queryClient = seeded();

    expect(await run(queryClient)).toBeUndefined();
    expect(stale(queryClient, QueryKeys.Permissions.mine())).toBe(false);
  });

  it('leaves the rights alone on a failure that is not an answer about the project', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem(500, 'internal_error')));
    const queryClient = seeded();

    expect(isNotFound(await run(queryClient))).toBe(false);
    expect(stale(queryClient, QueryKeys.Permissions.mine())).toBe(false);
  });
});
