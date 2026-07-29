import { redirect } from '@tanstack/react-router';

import { POST_LOGIN_PATH } from '@units/auth/model';

import { type GuardArgs } from './guard-args.types.js';

/**
 * The mirror of `requireSession`, for the public pages: a signed-in user has no business on a login
 * form, and showing one invites them to authenticate a second time.
 *
 * `unknown` stays on the page for the same reason it passes the other guard — the answer has not
 * arrived, and guessing in either direction produces a visible wrong screen.
 *
 * **This is also the return leg of a sign-in.** Signing in writes the session and asks the router to
 * re-check its guards (`router.invalidate()`, from the bus subscriber in `app/auth-events.util.ts`);
 * this guard then runs on `/login` with a session in hand and sends the user to `search.redirect` —
 * the page they were going to when `requireSession` intercepted them. Deciding it here rather than
 * in the form is what keeps «where a session lands» one decision: a form that navigated by itself
 * would race this guard, and whichever won would pick the destination.
 *
 * `search.redirect` is whatever `loginSearchSchema` let through, which is a path on this origin and
 * nothing else — an absolute URL, a protocol-relative one or a scheme has already become
 * `undefined`, and the fallback is `POST_LOGIN_PATH`. It travels as `href` rather than as `to`
 * because it is a value rather than a literal from the route tree; the router parses it into an
 * internal navigation and refuses a dangerous protocol on top of the schema.
 */
export const redirectIfAuthed = ({ context, search }: GuardArgs): void => {
  if (context.auth.status !== 'authenticated') return;

  // See `require-session.guard.ts`: a thrown `redirect()` is the router's navigation signal, not an
  // error, and the ban exists to catch thrown strings.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect({ href: search?.redirect ?? POST_LOGIN_PATH });
};
