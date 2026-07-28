import { AuthLib } from '@units/auth';

/**
 * The half of the sign-out path the data layer deliberately does not own.
 *
 * `units/auth` knows when the session is gone — the refresh was refused, the middleware gave up —
 * and says so on an event bus rather than navigating, because a transport module that imports a
 * router is a transport module that cannot be tested without one. This is the subscriber: it turns
 * `logged-out` into the one navigation that makes sense, carrying the current URL so that signing
 * in again returns the user to the page they were thrown out of.
 *
 * `replace: true`: the page they can no longer see does not belong in the history behind the login
 * screen, where Back would take them straight to another 401.
 *
 * `refresh-failed` is not handled here. It is the earlier, quieter moment — the rotation was
 * refused but the tab may still have a valid access token — and `units/auth` follows it with
 * `logged-out` when the session is really over. Navigating on both would race the second event
 * against the first navigation.
 */
export interface AuthRedirectTarget {
  readonly state: { readonly location: { readonly href: string } };
  readonly navigate: (options: {
    to: '/login';
    search: { redirect: string };
    replace: true;
  }) => unknown;
}

export const subscribeAuthRedirect = (router: AuthRedirectTarget): (() => void) =>
  AuthLib.onAuthEvent((event) => {
    if (event !== 'logged-out') return;

    router.navigate({
      to: '/login',
      search: { redirect: router.state.location.href },
      replace: true,
    });
  });
