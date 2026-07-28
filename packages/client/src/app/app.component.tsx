import { RouterProvider } from '@tanstack/react-router';
import { useMemo } from 'react';

import { SessionService } from '@units/session';

import { appQueryClient } from './app-query-client.constant.js';
import { Providers } from './providers.js';
import { router } from './router.js';

/**
 * The composition root as a component: providers outside, router inside.
 *
 * The router instance is a module constant — creating it here would rebuild the whole route tree on
 * every render — but its **context** is passed on each render, which is what keeps the guards
 * honest: `beforeLoad` reads the session as it is now, and a sign-out re-runs every guard in the
 * tree without anything having to remember to invalidate.
 *
 * `useMemo` on the auth object is not a micro-optimisation. `RouterProvider` treats a new context
 * object as a change and re-runs the matched routes' `beforeLoad`; an object literal rebuilt on
 * every render would do that on every render.
 *
 * Keeping it separate from `main.tsx` is what lets a test render the whole application without a
 * DOM entry point.
 */
export function App() {
  const session = SessionService.useSessionStatus();
  const auth = useMemo(() => ({ status: session.status }), [session.status]);

  return (
    <Providers queryClient={appQueryClient}>
      <RouterProvider context={{ auth }} router={router} />
    </Providers>
  );
}
