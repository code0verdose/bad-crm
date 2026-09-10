import { SharedHooks } from '@shared';

import { ERROR_MESSAGE_KEY, errorMessage, type ErrorMessage, isApiError } from '@shared/api';
import { loginAttempt } from '@units/auth/lib';
import {
  ORGANIZATION_SELECTION_NOTICE_KEY,
  type LoginFormValues,
  type TwoFactorFormValues,
} from '@units/auth/model';
import { useLoginMutation, useVerifySecondFactorMutation } from '@units/auth/service/mutations';

/** Which half of the sign-in the screen is on. Derived from the answers, never stored. */
export type LoginStep = 'password' | 'second-factor';

export interface SecondFactorController {
  /** Carried by the submit button of the step, never by a page-wide spinner. */
  readonly isPending: boolean;
  /** The sentence for a refused code, chosen from the problem `code`; `undefined` when nothing failed. */
  readonly failure: ErrorMessage | undefined;
  /** Whole seconds the intermediate token has left, counted down to zero. */
  readonly secondsLeft: number;
  readonly submit: (values: TwoFactorFormValues) => void;
}

export interface LoginController {
  readonly step: LoginStep;
  /** True while the password is in flight — the submit button carries it, nothing else does. */
  readonly isPending: boolean;
  /**
   * Something the form has to say that is not a field error and not a failure: that this address
   * belongs to more than one organization, or that the second step ran out of time. `undefined` the
   * rest of the time.
   */
  readonly notice: ErrorMessage | undefined;
  readonly submit: (credentials: LoginFormValues) => void;
  readonly secondFactor: SecondFactorController;
}

/**
 * The refusal that ends the step rather than describing it.
 *
 * `mfa_token_expired` says the intermediate token is gone — expired, spent, or voided by five wrong
 * codes. Retrying is impossible by construction, so it is not shown beside the field like the other
 * three refusals; the screen goes back to the password, which is the only thing that mints a new
 * token (STORY-013-03, acceptance 4).
 */
const isChallengeGone = (error: unknown): boolean =>
  isApiError(error) && error.code === 'mfa_token_expired';

/**
 * The unit's public surface for the sign-in screen (`rules/frontend-fsd.mdc` rule 6): both steps,
 * everything the two forms need, and nothing about the network.
 *
 * **The step is derived, not stored.** It is a function of the answer already in the mutations —
 * a deadline is present, and neither the clock nor the server has ended it — so there is no second
 * copy of «where are we» to disagree with the first (rule 11). The disagreement a `useState` here
 * would eventually produce is a screen asking for a code against a token nobody can spend.
 *
 * **The intermediate token is nowhere in this file.** The password mutation puts it in memory and
 * the verify mutation takes it back out; what travels through here is a number. That is the whole
 * point of the arrangement — see `login.mutation.ts` and `lib/mfa-token-storage.util.ts` — and it
 * is why nothing on this screen can put the token in a URL or in Web Storage even by accident.
 *
 * `submit` returns nothing and never rejects, on both steps. `mutate`, not `mutateAsync`: a promise
 * handed to a form's submit handler is a promise nobody awaits, and an unhandled rejection is what a
 * refused password would produce. Where a session lands is not decided here either — signing in
 * records the session and asks the router to re-check its guards, and `redirectIfAuthed` carries the
 * user to `search.redirect`.
 *
 * The two refusals are reported differently on purpose. A refused **password** is one toast, raised
 * by the global `MutationCache.onError`, because `invalid_credentials` is a verdict on two fields at
 * once that deliberately refuses to say which. A refused **code** is `failure`, rendered beside
 * the one field on the step, because that is where a server's verdict about a field belongs
 * (`rules/errors-and-toasts.mdc` §3–§4); `verify-second-factor.mutation.ts` is what stops a toast
 * being raised on top of it.
 */
export const useLogin = (): LoginController => {
  const password = useLoginMutation();
  const secondFactor = useVerifySecondFactorMutation();

  const expiresAt = password.data?.secondFactorExpiresAt ?? null;
  const secondsLeft = SharedHooks.useSecondsRemaining(expiresAt) ?? 0;

  // Over by the clock or over by the server — the screen does the same thing either way, so the two
  // are one value rather than two branches repeated three times below.
  const isChallengeOver =
    expiresAt !== null && (secondsLeft === 0 || isChallengeGone(secondFactor.error));

  return {
    step: expiresAt !== null && !isChallengeOver ? 'second-factor' : 'password',

    isPending: password.isPending,

    notice:
      password.data?.status === 'organization_selection_required'
        ? { key: ORGANIZATION_SELECTION_NOTICE_KEY }
        : isChallengeOver
          ? // The sentence the server would have sent for the same event, borrowed rather than
            // written twice: a countdown that reached zero and a token the server has forgotten are
            // the same fact to the person reading it, and two sentences would drift apart.
            { key: ERROR_MESSAGE_KEY.mfa_token_expired }
          : undefined,

    submit: (credentials) => {
      // A refusal belongs to the step it happened in. Left standing, `mfa_invalid_code` would greet
      // the next step before anything was typed into it, and `mfa_token_expired` would end that step
      // before it was drawn.
      secondFactor.reset();
      // The password becomes a one-shot rather than a mutation variable: `state.variables` is as
      // readable from the published router as `state.data`, and the code step keeps this mutation
      // observed for as long as somebody is typing (`units/auth/lib/login-attempt.util.ts`).
      password.mutate(loginAttempt(credentials.email, credentials.password));
    },

    secondFactor: {
      isPending: secondFactor.isPending,
      secondsLeft,
      failure:
        secondFactor.error === null || isChallengeGone(secondFactor.error)
          ? undefined
          : errorMessage(secondFactor.error),
      submit: (values) => {
        secondFactor.mutate(values);
      },
    },
  };
};
