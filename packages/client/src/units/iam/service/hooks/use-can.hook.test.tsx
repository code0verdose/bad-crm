import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib } from '@shared';

import { type useCan as UseCanHook } from './use-can.hook.js';

/**
 * The client half of the permission model, which is allowed to be wrong in exactly one direction.
 *
 * Everything here is a **hint**: the request behind an offered button is authorised again on the
 * server. So the property worth testing is not «does it agree with the server» — it cannot fail to,
 * it calls the same `can()` — but that it fails **closed** while it does not know, and that it does
 * not invent a second opinion about what a permission means.
 */

const answer = (body: unknown, status = 200): typeof fetch =>
  (() =>
    Promise.resolve(
      new Response(status === 200 ? JSON.stringify(body) : null, {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )) as unknown as typeof fetch;

/**
 * The unit is imported **after** the transport is stubbed, and that is not ceremony: the typed client
 * captures `fetch` when its module is first evaluated, so a stub installed later reaches nothing.
 * The same reason `use-logout.hook.test.tsx` re-imports its unit.
 */
const freshHook = async (): Promise<typeof UseCanHook> => {
  vi.resetModules();

  const { AuthLib } = await import('@units/auth');
  const { useCan } = await import('./use-can.hook.js');

  AuthLib.setAccessToken('access-token-for-the-hint-request');

  return useCan;
};

const wrapper = () => {
  const queryClient = SharedApi.createAppQueryClient({
    notify: SharedLib.silentNotifications,
    logError: vi.fn(),
  });

  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('asking what the interface may offer', () => {
  it('says no while it does not know yet', async () => {
    // Fail-closed in the direction that matters: a button appearing late is an annoyance, a button
    // that appears and then vanishes is a person clicking something that moves.
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));

    const useCan = await freshHook();
    const { result } = renderHook(() => useCan(), { wrapper: wrapper() });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.can('role:read')).toBe(false);
  });

  it('offers what the roles grant once the answer arrives', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        permissions: ['role:read', 'task:read'],
        denied: [],
        roles: ['manager'],
        isOwner: false,
        version: 3,
      }),
    );

    const useCan = await freshHook();
    const { result } = renderHook(() => useCan(), { wrapper: wrapper() });

    await waitFor(() => {
      expect(result.current.can('role:read')).toBe(true);
    });
    expect(result.current.can('role:delete')).toBe(false);
  });

  it('honours a DENY exception, which beats the grant', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        permissions: ['task:read'],
        denied: ['task:read'],
        roles: [],
        isOwner: false,
        version: 1,
      }),
    );

    const useCan = await freshHook();
    const { result } = renderHook(() => useCan(), { wrapper: wrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.can('task:read')).toBe(false);
  });

  it('gives the owner everything, the way the server does', async () => {
    vi.stubGlobal(
      'fetch',
      answer({ permissions: [], denied: [], roles: ['owner'], isOwner: true, version: 1 }),
    );

    const useCan = await freshHook();
    const { result } = renderHook(() => useCan(), { wrapper: wrapper() });

    await waitFor(() => {
      // An organization-scoped key: `organization:delete` needs MANAGER on the object, and ownership
      // clears the *level* server-side (`resolveAcl → MANAGER`) rather than in this hook — which sees
      // only what the endpoint returned.
      expect(result.current.can('organization:view_usage')).toBe(true);
    });
    expect(result.current.can('role:read')).toBe(true);
  });

  it('requires the level for a permission scoped to an object', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        permissions: ['project:update'],
        denied: [],
        roles: [],
        isOwner: false,
        version: 1,
      }),
    );

    const useCan = await freshHook();
    const { result } = renderHook(() => useCan(), { wrapper: wrapper() });

    await waitFor(() => {
      expect(result.current.can('project:update', 'EDITOR')).toBe(true);
    });
    // The conjunction, on the client as on the server: the capability alone is not the answer.
    expect(result.current.can('project:update')).toBe(false);
    expect(result.current.can('project:update', 'VIEWER')).toBe(false);
  });

  it('says no to a key the catalogue does not contain', async () => {
    // A typo must not open anything. `can()` fails closed on an unknown key, and this is the client
    // side of that same guarantee.
    vi.stubGlobal(
      'fetch',
      answer({
        permissions: ['task:teleport'],
        denied: [],
        roles: [],
        isOwner: false,
        version: 1,
      }),
    );

    const useCan = await freshHook();
    const { result } = renderHook(() => useCan(), { wrapper: wrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.can('task:teleport')).toBe(false);
  });

  it('says no when the request failed, rather than guessing', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));

    const useCan = await freshHook();
    const { result } = renderHook(() => useCan(), { wrapper: wrapper() });

    // The client retries once before giving up, so settling takes longer than a render — and the
    // answer must be «no» throughout, not only at the end.
    expect(result.current.can('role:read')).toBe(false);
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    }, { timeout: 5_000 });
    expect(result.current.can('role:read')).toBe(false);
  });
});
