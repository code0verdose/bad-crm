import { MantineProvider } from '@mantine/core';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RouteError, RoutePending } from '@app/ui';
import { createAppRouter } from '@app/router.js';
import { SharedApi, SharedUi } from '@shared';

/**
 * The two boundaries a route falls back to, rendered on their own.
 *
 * They are declared once in `createAppRouter` and inherited by every route, which is what makes
 * «no bare loading or error screens» true by construction (`rules/errors-and-toasts.mdc` §13) —
 * and also why nothing in the application renders them directly. Asserting them here is what keeps
 * the inherited default from being an empty `<div>` nobody ever looked at.
 */

const Themed = ({ children }: { readonly children: ReactNode }) => (
  <MantineProvider env="test">{children}</MantineProvider>
);

describe('the pending boundary', () => {
  it('shows a skeleton rather than a blank page', () => {
    render(
      <Themed>
        <RoutePending />
      </Themed>,
    );

    expect(screen.getByTestId('text-skeleton')).toHaveAttribute('aria-busy', 'true');
  });
});

describe('the error boundary', () => {
  it('explains the failure and offers to run the loader again', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();

    render(
      <Themed>
        <RouteError
          error={new Error('loader exploded')}
          info={{ componentStack: '' }}
          reset={reset}
        />
      </Themed>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('errors.route.failed');

    await user.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(reset).toHaveBeenCalledOnce();
  });

  /**
   * The message is a key chosen by the application, never the thrown error's own text: a stack
   * trace or an ORM message on screen is both useless to the user and a disclosure
   * (`rules/errors-and-toasts.mdc` §10).
   */
  it('never puts the thrown message on screen', () => {
    render(
      <Themed>
        <RouteError
          error={new Error('PrismaClientKnownRequestError P2002')}
          info={{ componentStack: '' }}
          reset={vi.fn()}
        />
      </Themed>,
    );

    expect(screen.queryByText(/P2002/)).not.toBeInTheDocument();
  });
});

describe('the router configuration', () => {
  /**
   * `defaultPreloadStaleTime: 0` is the line that hands the freshness question to TanStack Query.
   * Left at the router's own default, a preload would be cached separately and could serve data the
   * query cache had already invalidated — a screen that is stale only when the user hovered a link
   * first, which is not a defect anybody reproduces on purpose.
   */
  it('preloads on intent and leaves freshness to the query cache', () => {
    const router = createAppRouter(
      {
        queryClient: SharedApi.createAppQueryClient({
          notify: SharedUi.notify,
          logError: vi.fn(),
        }),
        auth: { status: 'unknown' },
      },
      createMemoryHistory({ initialEntries: ['/dashboard'] }),
    );

    expect(router.options.defaultPreload).toBe('intent');
    expect(router.options.defaultPreloadStaleTime).toBe(0);
    expect(router.options.defaultPendingComponent).toBe(RoutePending);
    expect(router.options.defaultErrorComponent).toBe(RouteError);
  });

  it('mounts through RouterProvider without a browser history', async () => {
    const queryClient = SharedApi.createAppQueryClient({
      notify: SharedUi.notify,
      logError: vi.fn(),
    });
    const router = createAppRouter(
      { queryClient, auth: { status: 'authenticated' } },
      createMemoryHistory({ initialEntries: ['/login'] }),
    );

    render(
      <Themed>
        <RouterProvider router={router} />
      </Themed>,
    );

    // `redirectIfAuthed` sends this one straight on, which is the guard running inside a real mount.
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('nav.dashboard');
  });
});
