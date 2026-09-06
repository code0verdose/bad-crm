import { redirect } from '@tanstack/react-router';

import { MFA_ENROLMENT_PATH } from '@units/auth/model';

import { type GuardArgs } from './guard-args.types.js';
import { requireSession } from './require-session.guard.js';

/**
 * The gate on the `_authenticated` branch: a session, and a session that may do more than enrol
 * (STORY-013-05, acceptance 3; STORY-013-04, acceptance 8).
 *
 * **Why it replaces `requireSession` on the branch rather than being listed per route.** The server
 * scopes such a session to three routes — draft a secret, confirm it, sign out — and answers every
 * other one with 403 `mfa_enrollment_required`
 * (`packages/server/src/presentation/http/route-registry.types.ts`, `requiresFullSession`). A screen
 * this guard had not been remembered on would therefore not be a screen missing a check; it would
 * be a screen where every control fails with a code nobody put on screen. Mounted on the pathless
 * branch, a screen added next month is covered by existing rather than by remembering — the same
 * argument `_authenticated.tsx` already makes about the session itself.
 *
 * **The session question is answered first.** A scoped session that has since been signed out has
 * to meet `/login` with its destination remembered; sending it to a wizard whose two endpoints
 * would answer 401 would lose both the explanation and the way back.
 *
 * `unknown` is let through by `requireSession` and is not asked the second question either. In the
 * shipped application it never reaches a guard at all — `app/app.component.tsx` holds the router
 * unmounted until the bootstrap has answered — but the ordering is stated here rather than assumed,
 * because a guard is a pure function and the next caller may not be that component.
 */
export const requireFullSession = (args: GuardArgs): void => {
  requireSession(args);

  // Presence, not truth: the field is absent on an ordinary session rather than `false`, and the
  // schema keeps it that way (`model/validation/session-identity.schema.ts`).
  if (args.context.auth.mfaEnrollment !== true) return;

  // See `require-session.guard.ts`: a thrown `redirect()` is the router's navigation signal, not an
  // error, and the ban exists to catch thrown strings.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect({ to: MFA_ENROLMENT_PATH });
};
