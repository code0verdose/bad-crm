import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib } from '@shared';

import { type useUserPermissions as UseUserPermissionsHook } from './use-user-permissions.hook.js';

/**
 * The controller behind the permissions tab, exercised without a DOM.
 *
 * `test/widgets/user-permissions.test.tsx` already proves the screen re-reads after a write; what it
 * cannot isolate is the **shape of the pending state itself** — `write.isPending || remove.isPending`
 * — because the full render never observes an intermediate frame between «clicked» and «re-read».
 * This file holds one write open on purpose to catch it there.
 */

const USER_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PERMISSIONS = {
  userId: USER_ID,
  isOwner: false,
  version: 3,
  roles: [],
  permissions: [{ key: 'task:read', allowed: true, source: 'ROLE', roleIds: [], override: null }],
};

/**
 * The unit is imported **after** the transport is stubbed, and after the auth token is set — the
 * same reason `use-can.hook.test.tsx` re-imports its unit: the typed client captures `fetch` when
 * its module is first evaluated.
 */
const freshHook = async (): Promise<typeof UseUserPermissionsHook> => {
  vi.resetModules();

  const { AuthLib } = await import('@units/auth');
  const { useUserPermissions } = await import('./use-user-permissions.hook.js');

  AuthLib.setAccessToken('access-token-for-the-permissions-tab');

  return useUserPermissions;
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

describe('the pending state of a write', () => {
  it('marks the row saving while the write is in flight, and clears it once it settles', async () => {
    let releaseWrite: () => void = () => undefined;
    const writeGate = new Promise<Response>((resolve) => {
      releaseWrite = () => {
        resolve(new Response(null, { status: 204 }));
      };
    });

    vi.stubGlobal('fetch', (input: Request) => {
      const url = new URL(input.url).pathname;

      if (url.includes('/permission-overrides/')) return writeGate;
      if (url.endsWith(`/users/${USER_ID}/permissions`)) return Promise.resolve(json(PERMISSIONS));
      if (url.endsWith('/me/permissions')) {
        return Promise.resolve(
          json({
            permissions: ['permission:override'],
            denied: [],
            roles: [],
            isOwner: false,
            version: 1,
          }),
        );
      }

      return Promise.resolve(json({ status: 'ok' }));
    });

    const useUserPermissions = await freshHook();
    const { result } = renderHook(
      () => useUserPermissions({ userId: USER_ID, search: '', exceptionsOnly: false }),
      { wrapper: wrapper() },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(result.current.isSaving).toBe(false);

    act(() => {
      result.current.confirm(
        {
          permission: 'task:read',
          effect: 'DENY',
          initialValues: { reason: '', neverExpires: true, expiresOn: '' },
        },
        { reason: 'because it must stop for now', neverExpires: true, expiresOn: '' },
      );
    });

    // The second click a missing guard would let through — a control that does not know it is
    // already saving offers exactly this.
    await waitFor(() => {
      expect(result.current.isSaving).toBe(true);
    });

    releaseWrite();

    await waitFor(() => {
      expect(result.current.isSaving).toBe(false);
    });
  });

  it('marks the row saving while a removal is in flight, and clears it once it settles', async () => {
    let releaseRemove: () => void = () => undefined;
    const removeGate = new Promise<Response>((resolve) => {
      releaseRemove = () => {
        resolve(new Response(null, { status: 204 }));
      };
    });

    vi.stubGlobal('fetch', (input: Request) => {
      const url = new URL(input.url).pathname;

      if (url.includes('/permission-overrides/')) return removeGate;
      if (url.endsWith(`/users/${USER_ID}/permissions`)) return Promise.resolve(json(PERMISSIONS));
      if (url.endsWith('/me/permissions')) {
        return Promise.resolve(
          json({
            permissions: ['permission:override'],
            denied: [],
            roles: [],
            isOwner: false,
            version: 1,
          }),
        );
      }

      return Promise.resolve(json({ status: 'ok' }));
    });

    const useUserPermissions = await freshHook();
    const { result } = renderHook(
      () => useUserPermissions({ userId: USER_ID, search: '', exceptionsOnly: false }),
      { wrapper: wrapper() },
    );

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    act(() => {
      result.current.choose('task:read', 'INHERITED');
    });

    await waitFor(() => {
      expect(result.current.isSaving).toBe(true);
    });

    releaseRemove();

    await waitFor(() => {
      expect(result.current.isSaving).toBe(false);
    });
  });
});
