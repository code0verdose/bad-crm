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
 * The destination is `POST_LOGIN_PATH`, the same constant the sign-in flow falls back to when the
 * URL carried nothing safe to return to: «where a session lands» is one decision, not two.
 */
export const redirectIfAuthed = ({ context }: GuardArgs): void => {
  if (context.auth.status !== 'authenticated') return;

  // See `require-session.guard.ts`: a thrown `redirect()` is the router's navigation signal, not an
  // error, and the ban exists to catch thrown strings.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect({ to: POST_LOGIN_PATH });
};
