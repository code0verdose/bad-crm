import { SharedUi } from '@shared';

/**
 * What a route shows while its data is on the way, once it has been slow enough to be worth saying
 * so (`defaultPendingMs` in `router.tsx`).
 *
 * A skeleton rather than a spinner, and never nothing: «no bare loading screens» is the whole point
 * of declaring it at the router level, because a route that forgets its `pendingComponent` renders
 * a blank page and looks broken (`rules/errors-and-toasts.mdc` §13).
 */
export function RoutePending() {
  return <SharedUi.TextSkeleton lines={5} />;
}
