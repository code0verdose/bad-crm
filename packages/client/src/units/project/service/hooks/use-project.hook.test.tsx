import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { Suspense, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

import { QueryKeys } from '@shared/lib';

import { useProject } from './use-project.hook.js';

/**
 * The card as the screen renders it, read from the cache the route has already primed
 * (STORY-014-05, acceptance 3) — which is why there is no network in this file at all, and why a
 * request would be a failure: `fetch` is a spy that must stay untouched.
 */

const PROJECT_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b21';

const card = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  key: 'BAD',
  name: 'Bad CRM',
  description: 'A CRM',
  status: 'ACTIVE',
  visibility: 'PUBLIC_ORG',
  leadId: 'u-lead',
  color: 'brand',
  memberCount: 2,
  startedAt: '2026-09-01T00:00:00.000Z',
  dueAt: '2026-09-11T00:00:00.000Z',
  taskCounter: 0,
  createdAt: '2026-08-30T00:00:00.000Z',
  ...overrides,
});

const primed = (overrides: Record<string, unknown> = {}): QueryClient => {
  const queryClient = SharedApi.createAppQueryClient({
    notify: { error: vi.fn(), success: vi.fn() },
    logError: vi.fn(),
  });

  queryClient.setQueryData(QueryKeys.Projects.detail(PROJECT_ID), card(overrides));

  return queryClient;
};

const wrapperOf = (queryClient: QueryClient) =>
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={null}>{children}</Suspense>
      </QueryClientProvider>
    );
  };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useProject', () => {
  it('reads the primed card without a second request', () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);

    const { result } = renderHook(() => useProject(PROJECT_ID), { wrapper: wrapperOf(primed()) });

    expect(result.current.project.key).toBe('BAD');
    expect(network).not.toHaveBeenCalled();
  });

  it('hands out keys for the status and the visibility, never text', () => {
    const { result } = renderHook(() => useProject(PROJECT_ID), {
      wrapper: wrapperOf(primed({ status: 'ON_HOLD', visibility: 'PRIVATE' })),
    });

    expect(result.current.statusLabelKey).toBe('projects.status.ON_HOLD');
    expect(result.current.visibilityLabelKey).toBe('projects.visibility.PRIVATE');
  });

  it.each([
    { status: 'ARCHIVED', isArchived: true },
    { status: 'ACTIVE', isArchived: false },
    { status: 'CLOSED', isArchived: false },
  ])('says the project is archived only when it is ($status)', ({ status, isArchived }) => {
    const { result } = renderHook(() => useProject(PROJECT_ID), {
      wrapper: wrapperOf(primed({ status })),
    });

    expect(result.current.isArchived).toBe(isArchived);
  });

  it('measures the dates against the clock of this render', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-06T00:00:00.000Z'));

    const { result } = renderHook(() => useProject(PROJECT_ID), { wrapper: wrapperOf(primed()) });

    expect(result.current.progress).toEqual({ percent: 50, isOverdue: false });
  });

  it('has no progress for a project without a deadline', () => {
    const { result } = renderHook(() => useProject(PROJECT_ID), {
      wrapper: wrapperOf(primed({ dueAt: null })),
    });

    expect(result.current.progress).toBeNull();
  });
});
