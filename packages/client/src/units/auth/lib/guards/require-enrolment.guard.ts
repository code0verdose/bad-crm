import { redirect } from '@tanstack/react-router';

import { POST_LOGIN_PATH } from '@units/auth/model';

import { type GuardArgs } from './guard-args.types.js';
import { requireSession } from './require-session.guard.js';

/**
 * The mirror of `requireFullSession`, on the enrolment screen itself — and the half that makes that
 * screen a room rather than a trap.
 *
 * It does two jobs that look like one. It keeps somebody who is *not* under the policy off a wizard
 * that would tell them their organization demands a second factor when it does not; and it is the
 * **way out** once the enrolment is finished. Confirming a secret rotates the session, the new
 * access token carries no enrolment scope, the router is asked to re-check its guards, and this one
 * finds a session with no business here and carries it into the application. That is why the
 * completion is not a `navigate()` in the page: where a session lands is decided by a guard, once,
 * the same way `redirectIfAuthed` decides it for a sign-in.
 *
 * `unknown` waits, and here the wrong guess is the expensive one: read as «not scoped», it would
 * bounce somebody who *is* scoped into a shell where every control answers 403.
 */
export const requireEnrolment = (args: GuardArgs): void => {
  requireSession(args);

  const { auth } = args.context;

  if (auth.status !== 'authenticated' || auth.mfaEnrollment === true) return;

  // `href` rather than `to`, like `redirectIfAuthed`: the destination is a value from this unit's
  // model rather than a literal the route tree can check.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect({ href: POST_LOGIN_PATH });
};
