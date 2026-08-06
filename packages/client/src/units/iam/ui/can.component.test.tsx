import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedApi, SharedLib } from '@shared';

import { type Can as CanComponent } from './can.component.js';

/**
 * Hiding a control the caller cannot use — a kindness, not a gate.
 *
 * The request behind the control is authorised on the server every time, so what this component owes
 * is the two things a person notices: it does not flash a button that then disappears, and it does
 * not explain what they are not allowed to do. A screen listing refused actions is a map of the
 * organization's structure handed to whoever is looking.
 */

/**
 * Fixture text, held in constants rather than written inline: the i18n rule forbids literal strings
 * in JSX — it cannot tell a test double from a label, and it should not have to.
 */
const CHILD = 'guarded-control';
const FALLBACK = 'fallback-control';

const answer = (body: unknown): typeof fetch =>
  (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as unknown as typeof fetch;

const wrapper = () => {
  const queryClient = SharedApi.createAppQueryClient({
    notify: SharedLib.silentNotifications,
    logError: vi.fn(),
  });

  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
};

/** Imported after the transport is stubbed: the typed client captures `fetch` when it is evaluated. */
const freshCan = async (): Promise<typeof CanComponent> => {
  vi.resetModules();

  const { AuthLib } = await import('@units/auth');
  const { Can } = await import('./can.component.js');

  AuthLib.setAccessToken('access-token-for-the-hint-request');

  return Can;
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a control shown only to those who may use it', () => {
  it('renders its children once the permission is known', async () => {
    vi.stubGlobal(
      'fetch',
      answer({ permissions: ['role:read'], denied: [], roles: [], isOwner: false, version: 1 }),
    );
    const Can = await freshCan();

    render(<Can permission="role:read">{CHILD}</Can>, { wrapper: wrapper() });

    await waitFor(() => {
      expect(screen.getByText(CHILD)).toBeInTheDocument();
    });
  });

  it('renders nothing at all while the answer is unknown', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));
    const Can = await freshCan();

    render(<Can permission="role:read">{CHILD}</Can>, { wrapper: wrapper() });

    // Not a spinner and not a disabled button: a control that appears and then vanishes is worse
    // than one that appears late.
    expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
  });

  it('renders nothing when the permission is missing, and no explanation', async () => {
    vi.stubGlobal(
      'fetch',
      answer({ permissions: ['task:read'], denied: [], roles: [], isOwner: false, version: 1 }),
    );
    const Can = await freshCan();

    render(<Can permission="role:delete">{CHILD}</Can>, { wrapper: wrapper() });

    await waitFor(() => {
      expect(screen.queryByText(CHILD)).not.toBeInTheDocument();
    });
  });

  it('shows the fallback when the caller asked for one', async () => {
    vi.stubGlobal(
      'fetch',
      answer({ permissions: [], denied: [], roles: [], isOwner: false, version: 1 }),
    );
    const Can = await freshCan();

    render(
      <Can permission="role:delete" fallback={<span>{FALLBACK}</span>}>
        {CHILD}
      </Can>,
      { wrapper: wrapper() },
    );

    await waitFor(() => {
      expect(screen.getByText(FALLBACK)).toBeInTheDocument();
    });
  });
});
