import { createRouter, type RouterHistory } from '@tanstack/react-router';

import { appQueryClient } from './app-query-client.constant.js';
import { routeTree } from './route-tree.gen.js';
import { type AppRouterContext } from './router-context.types.js';
import { RouteError } from './ui/route-error.component.js';
import { RouteNotFound } from './ui/route-not-found.component.js';
import { RoutePending } from './ui/route-pending.component.js';

/**
 * How slow a navigation has to be before the pending state is worth showing.
 *
 * Below this, data that arrives quickly would produce a skeleton that flashes and vanishes, which
 * reads as a glitch rather than as feedback.
 */
const PENDING_AFTER_MS = 200;

/**
 * `history` is an override, not a feature: the browser supplies its own, and a test supplies a
 * memory history so that it can start at `/dashboard` — or at `/nope` — without touching the
 * document. Everything else stays identical to what ships, which is the point of building the test
 * router through this function instead of a second `createRouter` call that could drift from it.
 */
export const createAppRouter = (context: AppRouterContext, history?: RouterHistory) =>
  createRouter({
    routeTree,
    context,
    ...(history === undefined ? {} : { history }),

    /**
     * Prefetch on intent — hover, focus, touch-start — so the data is usually there by the time the
     * click lands. `defaultPreloadStaleTime: 0` hands the freshness question back to TanStack
     * Query: the router asks, the cache decides whether the answer it already holds is good enough
     * (`rules/tanstack-query.mdc`). Left at its own default, the router would cache preloads
     * separately and serve data the cache had already invalidated.
     */
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,

    /** No bare loading, error or 404 screens anywhere (`rules/errors-and-toasts.mdc` §13). */
    defaultPendingMs: PENDING_AFTER_MS,
    defaultPendingComponent: RoutePending,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,

    /** A route change starts at the top of the page; the browser's own guess is the old scroll. */
    scrollRestoration: true,
  });

export type AppRouter = ReturnType<typeof createAppRouter>;

/**
 * The application's router instance.
 *
 * The context here is the starting value — `auth` is replaced on every render by `RouterProvider`
 * in `app.component.tsx`, which is how a guard sees the session as it is now rather than as it was
 * when the module loaded.
 */
export const router = createAppRouter({
  queryClient: appQueryClient,
  auth: { status: 'unknown' },
});

/**
 * The registration that makes the whole tree typed.
 *
 * With it, `<Link to="/dashbord">` is a compile error, `Route.useSearch()` returns the shape the
 * schema produced, and a parameter renamed in a path breaks every call site instead of one screen
 * at runtime. `StaticDataRouteOption` is extended for the same reason: `crumbKey` is read by the
 * breadcrumbs and by the route announcer, so a typo in it must not be a silently missing crumb.
 */
declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }

  interface StaticDataRouteOption {
    /** i18n key of this route's breadcrumb and document title. */
    crumbKey?: string;
  }
}
