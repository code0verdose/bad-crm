import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, type RenderResult } from '@testing-library/react';
import { StrictMode } from 'react';
import { vi } from 'vitest';

import i18next, { type i18n as I18n } from 'i18next';

import { Providers } from '@app/providers.js';
import { createAppRouter } from '@app/router.js';
import { SharedApi, SharedUi } from '@shared';

import { type SessionStatusFixture } from './session-status.types.js';
import { setTestLanguage } from './test-language.util.js';

export interface RenderAppOptions {
  /** Where the browser is when the tree mounts. */
  readonly path?: string;
  /** What the session bootstrap has decided so far. */
  readonly status?: SessionStatusFixture;
  /**
   * The i18next instance to mount with. Defaults to the suite's `cimode` one, which is what almost
   * every case wants; the pseudo-locale check is the exception, and it needs a real catalogue to
   * render rather than keys.
   */
  readonly i18n?: I18n;
  /**
   * What to seed the application's own language storage with. Stated rather than read from the
   * instance: `i18n.language` is whatever the *previous* case left behind, and a default derived
   * from it makes every file order-dependent — measured, after exactly that broke five cases in
   * `appearance.test.tsx` the moment a case before them clicked «Русский».
   */
  readonly language?: string;
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
  i18n = i18next,
  language = 'cimode',
}: RenderAppOptions = {}): RenderedApp => {
  setTestLanguage(language);

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
        <Providers i18n={i18n} queryClient={queryClient}>
          <RouterProvider router={router} />
        </Providers>
      </StrictMode>,
    ),
  };
};
