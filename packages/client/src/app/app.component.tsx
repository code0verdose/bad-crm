import { RouterProvider } from '@tanstack/react-router';
import { type i18n as I18n } from 'i18next';
import { useEffect } from 'react';

import { AppLoading } from '@app/ui';
import { AuthService } from '@units/auth';

import { AppErrorBoundary } from './ui/app-error-boundary.component.js';
import { appQueryClient } from './app-query-client.constant.js';
import { installGlobalErrorListeners } from './global-error-listeners.util.js';
import { reportClientError } from './report-client-error.util.js';
import { Providers } from './providers.js';
import { router } from './router.js';

/**
 * The composition root as a component: providers outside, and either the router or the wait.
 *
 * **The router is not mounted until the session is known**, and that is a requirement rather than a
 * preference. `useBootstrapSession` starts the one `POST /auth/refresh` of this tab and reports
 * `unknown` until it answers; render the route tree during that window and the guards — which let
 * `unknown` through on purpose — put a signed-in user on `/login` for a frame before the answer
 * arrives and bounces them back (STORY-006-05: «`/login` не рендерится ни на один кадр»). One
 * neutral screen instead, and no frame of the wrong one.
 *
 * No `context` prop on `RouterProvider`. What the guards read is `app/router-auth.util.ts`, a live
 * view over the session store, so `beforeLoad` sees the session at the moment it runs rather than
 * as it was at the last commit — and re-checking the guards stays a deliberate act
 * (`router.invalidate()` from `app/auth-events.util.ts`) instead of a side effect of rendering.
 *
 * The router instance is a module constant — creating it here would rebuild the whole route tree on
 * every render. Keeping all of this out of `main.tsx` is what lets a test render the whole
 * application without a DOM entry point.
 */
export interface AppProps {
  /**
   * The translation instance, passed through to `Providers`. Optional and normally absent — the
   * composition root builds one. The seam exists for the suite, which runs i18next in `cimode` so a
   * test asserts *which* key a screen asks for rather than what it currently says.
   */
  readonly i18n?: I18n;
}

export function App({ i18n }: AppProps = {}) {
  const session = AuthService.useBootstrapSession();

  // A rejected promise nobody awaited never reaches a boundary — React does not see it — so the
  // listener is installed for the life of the tree. A legitimate effect: a subscription to
  // something outside React, with its own teardown (`rules/frontend-fsd.mdc`, anti-`useEffect`).
  useEffect(() => installGlobalErrorListeners({ report: reportClientError }), []);

  return (
    <Providers queryClient={appQueryClient} {...(i18n === undefined ? {} : { i18n })}>
      <AppErrorBoundary report={reportClientError}>
        {session.status === 'unknown' ? <AppLoading /> : <RouterProvider router={router} />}
      </AppErrorBoundary>
    </Providers>
  );
}
