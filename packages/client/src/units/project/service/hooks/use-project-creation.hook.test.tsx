import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi } from '@shared';

/**
 * `useProjectCreation.failure` keeps its identity between renders of one refusal.
 *
 * Not a nicety: the form moves focus to the refused field whenever this object changes identity
 * (`useRefusalFocus`), so a record rebuilt on every render would pull the caret back to that field
 * on every render — while the reader is typing somewhere else.
 */

const wrapperOf = (queryClient: QueryClient) =>
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

const freshClient = () =>
  SharedApi.createAppQueryClient({
    notify: { error: vi.fn(), success: vi.fn() },
    logError: vi.fn(),
  });

const taken = (): Response =>
  new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'x',
      status: 409,
      code: 'project_already_exists',
      requestId: 'r',
    }),
    { status: 409, headers: { 'content-type': 'application/problem+json' } },
  );

const DRAFT = {
  key: 'BAD',
  name: 'Bad CRM',
  description: '',
  visibility: 'PUBLIC_ORG',
  leadId: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b10',
  color: 'brand',
  startedAt: '',
  dueAt: '',
} as const;

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

describe('useProjectCreation', () => {
  it('CONTROL: nothing refused before a submit, the refusal under its field after one', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(taken()));

    const { ProjectService } = await freshUnit();
    const { result } = renderHook(() => ProjectService.ProjectHooks.useProjectCreation(), {
      wrapper: wrapperOf(freshClient()),
    });

    expect(result.current.failure.fields).toEqual({});

    act(() => {
      result.current.create({ ...DRAFT }, vi.fn());
    });

    await waitFor(() => {
      expect(result.current.failure.fields).toEqual({ key: { key: 'projects.field.keyTaken' } });
    });
  });

  it('keeps one refusal the same object across renders', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(taken()));

    const { ProjectService } = await freshUnit();
    const { result, rerender } = renderHook(
      () => ProjectService.ProjectHooks.useProjectCreation(),
      { wrapper: wrapperOf(freshClient()) },
    );

    act(() => {
      result.current.create({ ...DRAFT }, vi.fn());
    });
    await waitFor(() => {
      expect(result.current.failure.fields.key).toBeDefined();
    });

    const first = result.current.failure;

    rerender();

    expect(result.current.failure).toBe(first);
  });
});
