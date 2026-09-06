import { useState } from 'react';

import { emitAuthEvent, refreshSession } from '@units/auth/lib';
import { authSession } from '@units/auth/service/stores';

import { useTotpEnrolment, type TotpEnrolment } from './use-totp-enrolment.hook.js';

export interface MfaEnrolmentController {
  /** The wizard itself, exactly as `/settings/security` has it — one mastered flow, not two. */
  readonly enrolment: TotpEnrolment;
  /**
   * Whether this screen has completed an enrolment — what the wizard draws its «on» face from.
   *
   * Not derivable, and that is why it is state. The fact lives in the confirmation mutation, and
   * `finish` deliberately resets that mutation to destroy its copy of the ten codes; after that
   * nothing else on this screen remembers, and the counter that answers the same question on
   * `/settings/security` is a route the server refuses to a scoped session.
   */
  readonly isEnrolled: boolean;
  /**
   * Called once the person states they have saved the ten codes: takes the tab out of the enrolment
   * scope, which is what carries them into the application.
   */
  readonly finish: () => void;
}

/**
 * The forced enrolment as the screen sees it: the wizard, plus the way out of it
 * (STORY-013-05, acceptance 3).
 *
 * **`finish` rotates rather than navigates**, and that is the whole content of this hook. The
 * enrolment scope lives in the access token, and the client is never told it has ended — the server
 * re-decides it wherever a session is issued, so the only way to learn is to ask for a new token
 * (`route-registry.types.ts` → `requiresFullSession`: `POST /auth/refresh` is deliberately outside
 * the gate for exactly this). Recording the rotated identity in the store and announcing
 * `logged-in` is then enough: `app/auth-events.util.ts` turns that into `router.invalidate()`, and
 * `requireEnrolment` on this route finds a session with no business here and sends it on. A
 * `navigate()` here would race that guard, and whichever won would pick the destination — the
 * mistake `/login`, `/register` and `/invite/$token` each document not making.
 *
 * It is also the first caller to put a **rotated** identity into the store, which is worth naming
 * because the gap it closes is wider than this screen: until now the store was written only by the
 * bootstrap and by signing in, so a tab learned about its own session state only by being reloaded.
 *
 * **The codes are dropped first, synchronously, and that ordering is a fix rather than a
 * preference.** `RecoveryCodesDialog.close()` calls `onConfirmed` and then, in a microtask, moves
 * focus to the page heading — on the stated assumption that `onConfirmed` has already unmounted it.
 * An earlier draft of this hook dropped the codes in a `.finally()` after the rotation, which left
 * the dialog mounted, `aria-modal` and trapping Tab while focus was pulled out of it, for the length
 * of a real network request, on the one screen a person cannot leave. Honouring the dialog's
 * invariant here is cheaper and safer than weakening it for every caller.
 *
 * What that ordering costs is paid by `isEnrolled`: with both mutations reset, the wizard would fall
 * back to its «Turn on two-factor authentication» face and invite somebody to do again what they
 * have just done — on an account whose next `POST /auth/2fa/setup` answers 409. The flag keeps the
 * face truthful for the length of the rotation, and truthful is exactly what it is: the server has
 * enrolled them, whatever the rotation goes on to say.
 *
 * A rotation that is **refused** ends the session, and saying so is not a fallback: the tab has no
 * credentials left, and `logged-out` is what carries it to the sign-in screen with the address
 * remembered. A rotation that never reached the server changes nothing and leaves the person where
 * they are, with the enrolment already done on the server and one reload between them and the
 * application — the same answer `auth-session.store.ts` gives for the same reason.
 */
export const useMfaEnrolment = (): MfaEnrolmentController => {
  const enrolment = useTotpEnrolment();
  const [isEnrolled, setEnrolled] = useState(false);

  return {
    enrolment,
    isEnrolled,

    finish: () => {
      setEnrolled(true);
      enrolment.dismissCodes();

      void refreshSession().then((rotation) => {
        if (rotation.kind === 'refused') {
          emitAuthEvent('logged-out');

          return;
        }
        if (rotation.kind !== 'session') return;

        authSession.start(rotation.identity);
        emitAuthEvent('logged-in');
      });
    },
  };
};
