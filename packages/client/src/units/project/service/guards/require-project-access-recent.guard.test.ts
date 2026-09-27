import { isNotFound } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/**
 * STORY-014-06, acceptances 3 and 5, at the one door every way into a project passes: the layout's
 * guard remembers a project the server let through and forgets one it answered «not found» — and
 * leaves the recent list alone when the failure says nothing about the project.
 */

const PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b21';
const OTHER_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b22';

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

/** A recent list of its own that starts with a neighbour in it — the control that must survive. */
const recentList = () => {
  const ids = [OTHER_ID];

  return {
    ids,
    remember: (projectId: string) => {
      ids.unshift(projectId);
    },
    forget: (projectId: string) => {
      ids.splice(ids.indexOf(projectId), 1);
    },
  };
};

const run = async (recent: ReturnType<typeof recentList>): Promise<unknown> => {
  vi.resetModules();
  const { requireProjectAccess } = await import('./require-project-access.guard.js');
  const queryClient = SharedApi.createAppQueryClient({
    notify: { error: vi.fn(), success: vi.fn() },
    logError: vi.fn(),
  });

  try {
    await requireProjectAccess(
      { context: { queryClient }, params: { projectId: PROJECT_ID } },
      recent,
    );

    return undefined;
  } catch (error) {
    return error;
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requireProjectAccess and the recent projects', () => {
  it('CONTROL: remembers a project the server let through, in front of the others', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(project()));
    const recent = recentList();

    expect(await run(recent)).toBeUndefined();
    expect(recent.ids).toEqual([PROJECT_ID, OTHER_ID]);
  });

  it.each([
    { status: 404, code: 'project_not_found' },
    { status: 403, code: 'user_forbidden' },
  ])('forgets a project answered $status, and only that one', async ({ status, code }) => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem(status, code)));
    const recent = recentList();

    recent.remember(PROJECT_ID);

    expect(isNotFound(await run(recent))).toBe(true);
    expect(recent.ids).toEqual([OTHER_ID]);
  });

  it('neither remembers nor forgets on a failure that is not an answer about the project', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(problem(500, 'internal_error')));
    const recent = recentList();

    recent.remember(PROJECT_ID);

    expect(isNotFound(await run(recent))).toBe(false);
    expect(recent.ids).toEqual([PROJECT_ID, OTHER_ID]);
  });
});
