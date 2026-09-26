import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/** The roster of the overview: three states for `DataState`, and a retry that asks again. */

const PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b21';

const wrapperOf = (queryClient: QueryClient) =>
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

const freshClient = () =>
  SharedApi.createAppQueryClient({
    notify: { error: vi.fn(), success: vi.fn() },
    logError: vi.fn(),
  });

const roster = (): Response =>
  new Response(
    JSON.stringify({
      items: [
        {
          userId: 'u-1',
          projectRole: 'LEAD',
          allocationPct: 50,
          joinedAt: '2026-09-01T00:00:00.000Z',
          leftAt: null,
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** Imported after `fetch` is stubbed: `openapi-fetch` binds the transport at module evaluation. */
const freshUnit = async () => {
  vi.resetModules();

  return await import('@units/project');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useProjectMembers', () => {
  it('CONTROL: pending with no rows, then success with the roster of this project', async () => {
    const urls: string[] = [];

    vi.stubGlobal('fetch', (input: Request) => {
      urls.push(new URL(input.url).pathname);

      return Promise.resolve(roster());
    });

    const { ProjectService } = await freshUnit();
    const { result } = renderHook(() => ProjectService.ProjectHooks.useProjectMembers(PROJECT_ID), {
      wrapper: wrapperOf(freshClient()),
    });

    expect(result.current.status).toBe('pending');
    expect(result.current.members).toEqual([]);

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.members.map((member) => member.userId)).toEqual(['u-1']);
    expect(urls).toEqual([`/api/v1/projects/${PROJECT_ID}/members`]);
  });

  it('reports a failed load as an error with no rows, and asks again on retry', async () => {
    let calls = 0;

    vi.stubGlobal('fetch', () => {
      calls += 1;

      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'x',
            status: 404,
            code: 'project_not_found',
          }),
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      );
    });

    const { ProjectService } = await freshUnit();
    const { result } = renderHook(() => ProjectService.ProjectHooks.useProjectMembers(PROJECT_ID), {
      wrapper: wrapperOf(freshClient()),
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.members).toEqual([]);

    const before = calls;

    result.current.refetch();

    await waitFor(() => {
      expect(calls).toBeGreaterThan(before);
    });
  });
});
