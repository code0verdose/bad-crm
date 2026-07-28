import { createRootRouteWithContext } from '@tanstack/react-router';

import { type AppRouterContext } from '@app/router-context.types.js';
import { RootLayout } from '@app/ui';

/**
 * The root of the tree, and the place the router context is typed.
 *
 * `createRootRouteWithContext` is what makes `context.auth` and `context.queryClient` typed inside
 * every `beforeLoad` and every `loader` below — a guard that reads a field nobody provides is a
 * compile error here rather than `undefined` at runtime.
 *
 * It renders the outlet and the route announcer, and nothing else: the shell belongs to the
 * authenticated branch, and the public pages must not be wrapped in it. The pending, error and
 * not-found boundaries are declared once in `router.tsx` and inherited by every route.
 */
export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: RootLayout,
});
