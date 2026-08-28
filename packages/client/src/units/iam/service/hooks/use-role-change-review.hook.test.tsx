import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, type SharedLib } from '@shared';

/**
 * Reviewing a role draft and then saving it, as the object the matrix can render.
 *
 * `RoleMatrix` used to call the preview and the save itself and derive «is any of this dangerous»
 * itself, then pass that derivation back into the request — the middle link of
 * `rules/frontend-fsd.mdc` rule 4 skipped, and the rule that decides when the confirmation header
 * goes on the wire living in a widget.
 *
 * The header is what these cases are really about: `confirmDangerous` must appear when the preview
 * said something dangerous arrives and must **not** appear otherwise, because it is the client's
 * repeat of a request the server refused with 428.
 */

const CHANGES = { changes: [{ roleId: 'role-1', permissions: ['team:read'] }] } as never;

const outcome = (dangerous: readonly string[]) => ({
  roleId: 'role-1',
  roleName: 'Developer',
  holders: 3,
  added: [...dangerous],
  removed: [],
  dangerous: [...dangerous],
});

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

interface Harness {
  readonly queryClient: QueryClient;
  readonly globalNotify: SharedLib.NotificationPort;
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

const harness = (): Harness => {
  const globalNotify = { error: vi.fn(), success: vi.fn() };
  const queryClient = SharedApi.createAppQueryClient({ notify: globalNotify, logError: vi.fn() });

  return {
    queryClient,
    globalNotify,
    wrapper: function Wrapper({ children }: { readonly children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    },
  };
};

const freshUnit = async () => {
  vi.resetModules();

  return await import('@units/iam');
};

/** Answers the preview with the given outcomes, and records every later request. */
const stubApi = (outcomes: readonly unknown[], recorded: Request[]) => {
  vi.stubGlobal('fetch', (input: Request) => {
    recorded.push(input.clone());

    return Promise.resolve(
      new URL(String(input.url)).pathname.endsWith('/preview-changes')
        ? json({ items: outcomes })
        : new Response(null, { status: 204 }),
    );
  });
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reviewing and applying role changes', () => {
  it('CONTROL: hands the preview outcomes back and calls back only once they arrived', async () => {
    const calls: Request[] = [];
    stubApi([outcome([])], calls);

    const { IamService } = await freshUnit();
    const { wrapper } = harness();
    const ready = vi.fn();

    const { result } = renderHook(() => IamService.IamHooks.useRoleChangeReview(), { wrapper });

    expect(result.current.outcomes).toEqual([]);

    act(() => {
      result.current.review(CHANGES, ready);
    });

    expect(ready).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(ready).toHaveBeenCalledTimes(1);
    });
    expect(result.current.outcomes).toHaveLength(1);
  });

  it('sends `confirmDangerous` when the preview said something dangerous arrives', async () => {
    const calls: Request[] = [];
    stubApi([outcome(['permission:override'])], calls);

    const { IamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => IamService.IamHooks.useRoleChangeReview(), { wrapper });

    act(() => {
      result.current.review(CHANGES);
    });
    await waitFor(() => {
      expect(result.current.outcomes).toHaveLength(1);
    });

    act(() => {
      result.current.apply(CHANGES);
    });

    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]?.headers.get('X-Confirm-Dangerous')).toBe('1');
  });

  it('omits it when nothing dangerous arrives — the header is not a formality', async () => {
    const calls: Request[] = [];
    stubApi([outcome([])], calls);

    const { IamService } = await freshUnit();
    const { wrapper } = harness();

    const { result } = renderHook(() => IamService.IamHooks.useRoleChangeReview(), { wrapper });

    act(() => {
      result.current.review(CHANGES);
    });
    await waitFor(() => {
      expect(result.current.outcomes).toHaveLength(1);
    });

    act(() => {
      result.current.apply(CHANGES);
    });

    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]?.headers.get('X-Confirm-Dangerous')).toBeNull();
  });

  it('runs the done callback only once the save has been accepted', async () => {
    const calls: Request[] = [];
    stubApi([outcome([])], calls);

    const { IamService } = await freshUnit();
    const { wrapper } = harness();
    const done = vi.fn();

    const { result } = renderHook(() => IamService.IamHooks.useRoleChangeReview(), { wrapper });

    act(() => {
      result.current.apply(CHANGES, done);
    });

    expect(done).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(done).toHaveBeenCalledTimes(1);
    });
  });
});
