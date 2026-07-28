import { createFileRoute } from '@tanstack/react-router';

import { RouteNotFound } from '@app/ui';

/**
 * Everything that matches nothing else, inside the shell.
 *
 * Without this the router falls back to the root route, and the not-found screen renders alone on a
 * blank page — no navigation, no header, nothing to leave by except the Back button. The story asks
 * for the opposite («внутри оболочки приложения, навигация сохраняется»), and so does the reasoning
 * in `ux-architecture.md` → «403 vs 404»: the screen is deliberately unable to say whether the
 * thing is missing or merely not yours, which is only humane if the way out is still on screen.
 *
 * A splat under `_authenticated` rather than at the root, so an unknown URL is still behind the
 * session guard: an anonymous visitor gets the login screen, not a 404 that confirms the
 * installation exists.
 */
export const Route = createFileRoute('/_authenticated/$')({
  component: RouteNotFound,
});
