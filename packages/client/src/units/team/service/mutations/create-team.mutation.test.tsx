import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib } from '@shared';

/**
 * What creating a team leaves in the query cache.
 *
 * Coverage of this file was already 100 % without a single assertion on the cache: every existing
 * case (`team-list.test.tsx`) reads the dialog closing and the request body, never the group the
 * mutation is supposed to invalidate. `onSuccess` calling `queryClient.invalidateQueries` and
 * `onSuccess` calling nothing at all execute exactly the same branches and satisfy exactly the same
 * lines — the two are indistinguishable to a coverage report and identical in effect to every test
 * that came before this one. Removing the call is the regression this file exists to catch: without
 * it, a team created from the dialog never appears in the list until somebody reloads the page.
 */
const CREATED = {
  id: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41',
  name: 'Backend',
  slug: 'backend',
  description: null,
};

const json = (body: unknown, status = 201): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Harness {
  readonly queryClient: QueryClient;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

const harness = (): Harness => {
  const queryClient = SharedApi.createAppQueryClient({
    notify: SharedLib.silentNotifications,
    logError: vi.fn(),
  });

  return {
    queryClient,
    wrapper: function Wrapper({ children }: { readonly children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    },
  };
};

const freshUnit = async () => {
  vi.resetModules();

  return import('@units/team');
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('creating a team', () => {
  it('invalidates the team group so the list picks up the new row', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json(CREATED)));
    const { TeamService } = await freshUnit();
    const { queryClient, wrapper } = harness();

    // Seeded as data a screen already holds — the property under test is that a *live* cache entry
    // stops being trusted, not that an absent one is created.
    queryClient.setQueryData(['teams', 'list'], [{ ...CREATED, memberCount: 0 }]);

    const { result } = renderHook(() => TeamService.TeamMutations.useCreateTeam(), { wrapper });

    result.current.mutate({ name: 'Backend', slug: 'backend', description: null });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(queryClient.getQueryState(['teams', 'list'])?.isInvalidated).toBe(true);
  });
});
