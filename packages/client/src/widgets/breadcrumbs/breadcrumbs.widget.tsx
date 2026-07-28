import { useMatches } from '@tanstack/react-router';

import { routeCrumbs } from './lib/route-crumbs.util.js';
import { BreadcrumbTrail } from './breadcrumb-trail.component.js';

/**
 * Where you are, built from the route tree rather than from a per-page list
 * (`ux-architecture.md` → «Каркас приложения»).
 *
 * Derived, because a hand-written trail is a second description of the hierarchy and drifts from
 * the first one the moment a route moves. The widget does one thing — read the matches — and hands
 * the result to the presentational trail.
 */
export function Breadcrumbs() {
  return <BreadcrumbTrail crumbs={routeCrumbs(useMatches())} />;
}
