import { AuthLib } from '@units/auth';

/**
 * The half of the session lifecycle the data layer deliberately does not own.
 *
 * `units/auth` knows *when* the session changes — the sign-in succeeded, the refresh was refused,
 * the middleware gave up — and says so on an event bus rather than navigating, because a transport
 * module that imports a router is a transport module that cannot be tested without one. This is the
 * subscriber, and it is the only place in the client that turns a session event into routing.
 *
 * **`logged-in` → `router.invalidate()`.** `RouterProvider` does not re-run `beforeLoad` when the
 * session changes underneath it; it re-renders. Guards run on navigation and on invalidation, and
 * nothing else — so without this line a user who has just signed in stays on the login form until
 * they click something. Invalidation re-runs `redirectIfAuthed` on `/login`, which is what carries
 * them to `search.redirect`, the page they were originally going to.
 *
 * **`logged-out` → forget who, then leave, then forget what.** All three, in that order, and none of
 * them is cosmetic.
 *
 * `session.end()` comes first because the guards read the session state, not the event. The sign-out
 * button is only one producer of `logged-out`; the other is the auth middleware, which raises it
 * when a rotation is refused — an expired or revoked refresh token, a password reset elsewhere that
 * revoked every family, an administrator closing the session. That producer clears the access token
 * and announces the loss, and nothing else moves the state. Left at `authenticated`, the state is
 * what `redirectIfAuthed` reads on `/login`: it throws the tab straight back into the shell it was
 * just ejected from, while `requireSession` waves it through. The cache is empty by then and every
 * request answers 401 — an application that claims the user is signed in, shows nothing, and offers
 * no way back in short of finding the sign-out control. Ending the session here rather than in each
 * producer is what makes «`logged-out` means anonymous» one statement instead of a promise every
 * future producer has to remember.
 *
 * `queryClient.clear()` comes last because it evicts every cached entry, and an observer still
 * mounted on a protected screen would immediately refetch — a burst of requests from a tab that has
 * just lost its session, every one of them a 401. Navigating first unmounts them, so `clear()` runs
 * over a screen that is no longer asking for anything. The current URL travels in `redirect`, so
 * signing in again returns the user to the page they were thrown out of, and `replace: true` keeps
 * it out of the history behind the login screen where Back would walk straight into another 401.
 *
 * `refresh-failed` is not handled here. It is the earlier, quieter moment — the rotation was refused
 * but the tab may still hold a valid access token — and `units/auth` follows it with `logged-out`
 * when the session is really over. Acting on both would race the second event against the first
 * navigation.
 */
export interface AuthEventTarget {
  readonly router: {
    readonly state: { readonly location: { readonly href: string } };
    readonly navigate: (options: {
      to: '/login';
      search: { redirect: string };
      replace: true;
    }) => Promise<void>;
    readonly invalidate: () => Promise<void>;
  };
  /** Only `clear` is used: nothing of one session's data may outlive it (`rules/tanstack-query.mdc` §13). */
  readonly queryClient: { readonly clear: () => void };
  /**
   * The session store of this tab — `AuthService.authSession`. Only `end` is used: this subscriber
   * observes the end of a session, it never starts one.
   */
  readonly session: { readonly end: () => void };
}

export const subscribeAuthEvents = ({
  router,
  queryClient,
  session,
}: AuthEventTarget): (() => void) => {
  const signOut = async (): Promise<void> => {
    await router.navigate({
      to: '/login',
      search: { redirect: router.state.location.href },
      replace: true,
    });

    queryClient.clear();
  };

  return AuthLib.onAuthEvent((event) => {
    if (event === 'logged-in') {
      void router.invalidate();

      return;
    }

    if (event !== 'logged-out') return;

    // Synchronous, and before the navigation: `beforeLoad` on `/login` runs during
    // `router.navigate`, and it decides on the session state as it is at that moment.
    session.end();
    void signOut();
  });
};
