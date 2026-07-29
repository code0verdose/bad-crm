import { type QueryClient } from '@tanstack/react-query';

import { type AuthTypes } from '@units/auth';

/**
 * What every `beforeLoad` and every `loader` in the tree is handed.
 *
 * Two things and no more. `queryClient` lets a loader prefetch through the same cache the component
 * reads from, so `ensureQueryData` in the loader and `useSuspenseQuery` in the component are one
 * request rather than two. `auth` is what the guards read.
 *
 * It is a *type* declared here rather than in the router module so that a route file can name it
 * without pulling in the generated route tree.
 *
 * The guards do **not** name it. They live in `units/auth/lib/guards` and describe the fields they
 * read as a shape of their own (`AuthLib.GuardArgs`), because a unit may not import `app/`. What
 * checks the two against each other is the wiring: `beforeLoad: AuthLib.requireSession` in
 * `routes/_authenticated.tsx` compiles only while this context still satisfies that shape —
 * parameters are compared contravariantly, so a status added below and unhandled there is a
 * compile error at the route file rather than a guard silently deciding on a value it has never
 * seen.
 */
export interface RouterAuthState {
  /**
   * `unknown` until the session bootstrap answers; see the guards for why that matters.
   *
   * The application implements it as a getter over the session store
   * (`app/router-auth.util.ts`), so a guard reads the session at the moment it runs rather than at
   * the last render. A test may pass a plain value — the shape is what the guards are typed on.
   */
  readonly status: AuthTypes.SessionState['status'];
}

export interface AppRouterContext {
  readonly queryClient: QueryClient;
  readonly auth: RouterAuthState;
}
