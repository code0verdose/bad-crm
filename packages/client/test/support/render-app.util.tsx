import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, type RenderResult } from '@testing-library/react';
import { StrictMode } from 'react';
import { vi } from 'vitest';

import i18next from 'i18next';

import { Providers } from '@app/providers.js';
import { createAppRouter } from '@app/router.js';
import { SharedApi, SharedUi } from '@shared';

import { type SessionStatusFixture } from './session-status.types.js';
import { setCimodeLanguage } from './test-language.util.js';

export interface RenderAppOptions {
  /** Where the browser is when the tree mounts. */
  readonly path?: string;
  /** What the session bootstrap has decided so far. */
  readonly status?: SessionStatusFixture;
}

export interface RenderedApp extends RenderResult {
  readonly router: ReturnType<typeof createAppRouter>;
}

/**
 * Mounts the real application — real providers, real route tree, real guards — at a chosen URL and
 * with a chosen session state.
 *
 * The alternative would be a second router built in the test file, which is how a suite ends up
 * proving that a configuration nobody ships works: preload behaviour, the pending delay and the
 * three boundaries all live in `createAppRouter`, and a test that re-declares them tests itself.
 * Only the history is swapped, because jsdom has one document and a test needs to start anywhere.
 *
 * `StrictMode` for the same reason, and it was not free: `main.tsx` mounts under it in every
 * environment, and a suite that renders without it is a suite that cannot see a double-invoked
 * effect or an impure updater — which is the entire point of turning it on.
 */
export const renderApp = ({
  path = '/',
  status = 'unknown',
}: RenderAppOptions = {}): RenderedApp => {
  setCimodeLanguage();

  const queryClient = SharedApi.createAppQueryClient({
    notify: SharedUi.notify,
    logError: vi.fn(),
  });
  const router = createAppRouter(
    { queryClient, auth: { status } },
    createMemoryHistory({ initialEntries: [path] }),
  );

  return {
    router,
    ...render(
      <StrictMode>
        {/* The suite's cimode instance, so assertions keep naming keys rather than copy. */}
        <Providers i18n={i18next} queryClient={queryClient}>
          <RouterProvider router={router} />
        </Providers>
      </StrictMode>,
    ),
  };
};
