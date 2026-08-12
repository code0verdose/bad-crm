/**
 * The page is imported from **its own module**, not from the `@pages` barrel — the barrel pulls
 * every screen into one shared chunk and defeats the route-level code splitting (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { SettingsSecurityPage } from '@pages/settings-security';

/**
 * `/settings/security` — wiring only (`rules/frontend-fsd.mdc` rule 10).
 *
 * **No permission guard, and none is possible.** Every operation behind this screen is
 * self-service: the route registry marks all four `selfService: true`, and the reason is written
 * there — nobody could be denied the right to protect their own sign-in. The session guard on
 * `_authenticated` is the whole gate.
 *
 * **No loader either**, so the route inherits the router's pending and error boundaries rather than
 * declaring its own. The screen reads one counter and it reads it from the component, because the
 * two operations that matter here are mutations: prefetching in a loader would buy a skeleton that
 * is already handled by `DataState` and would put the request on the navigation's critical path.
 */
export const Route = createFileRoute('/_authenticated/settings/security')({
  component: SettingsSecurityPage,
  staticData: { crumbKey: 'security.title' },
});
