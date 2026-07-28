import { redirect } from '@tanstack/react-router';

import { type GuardArgs } from './guard-args.types.js';

/**
 * The guard on the `_authenticated` branch: one check for every screen behind it
 * (`ux-architecture.md` → «Гарды в `beforeLoad`»).
 *
 * `beforeLoad` runs before the loaders and before the render, so an anonymous visitor never starts
 * a request for data they cannot have, and never sees a frame of the shell.
 *
 * **`unknown` is allowed through, and that is the point.** Between the first paint and the answer
 * of the session endpoint the client does not know who this is; treating that as «anonymous» would
 * bounce a signed-in user to the login screen on every reload — the flash `GUARD_SESSION_STATUSES`
 * documents. The authority is the server, which answers 401 to a request without a session
 * (invariant 2 in CLAUDE.md); this guard is UI, and its job is to not lie during the gap.
 *
 * The destination is carried in `search.redirect` so that signing in returns the user to the link
 * they followed. `loginSearchSchema` decides what is safe to return to.
 */
export const requireSession = ({ context, location }: GuardArgs): void => {
  if (context.auth.status !== 'anonymous') return;

  // `redirect()` returns a `Response`, not an `Error`, and throwing it is how the router is told to
  // navigate before this route renders — the same control flow `eslint.config.js` already allows in
  // `app/**` by naming `Redirect` explicitly. Taken inline rather than by widening that allowance to
  // a whole directory, so the exception stays visible in the file that needs it.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect({ to: '/login', search: { redirect: location.href } });
};
