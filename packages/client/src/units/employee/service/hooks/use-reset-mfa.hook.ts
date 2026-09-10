import { useCallback } from 'react';

import { type ResetMfaResult } from '@units/employee/api';
import { useResetUserMfa } from '@units/employee/service/mutations';
import { errorMessage, type ErrorMessage } from '@shared/api';

export interface ResetMfaController {
  /** What the server answered, or `undefined` while nothing has been run yet. */
  readonly result: ResetMfaResult | undefined;
  /**
   * The refusal as a sentence — key and values — chosen from the `code` and never from `detail`
   * (`rules/errors-and-toasts.mdc` §10). Absent while nothing has been refused.
   *
   * A message rather than the `Error`, and that is the point of this hook: the dialog renders what
   * it is given and translates nothing. `error → messageKey` is a rule about how failures are read,
   * and it lives on one layer of this client — `service/hooks` — for all three confirmations.
   */
  readonly failure: ErrorMessage | undefined;
  readonly isPending: boolean;
  readonly resetMfa: () => void;
  /** The dialog is done with: clears the answer so the next open starts from the confirmation. */
  readonly dismiss: () => void;
}

/**
 * Taking somebody else's second factor off, as the object a dialog can render — the unit's public
 * API for `ui` (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the dialog reached past it.** `ResetMfaDialog` called
 * `EmployeeMutations.useResetUserMfa()` directly and turned the `Error` into a key itself, which
 * skips the middle link of the call chain (rule 4) and puts a second copy of `error → messageKey`
 * in a widget. The invitation confirmation beside it had the first copy, inside its unit hook; the
 * reactivation dialog had a third arrangement again. Three shapes for one job is three places for
 * the next rule about failures to be applied twice and forgotten once.
 *
 * **Nothing is invalidated on the way out**, unlike `useReactivation`. That is not an omission but
 * the mutation's own finding restated where somebody would look for it: a reset moves the subject's
 * TOTP columns, their recovery codes and their live sessions, and the client holds a query for none
 * of the three (see `reset-user-mfa.mutation.ts`). There is nothing to refetch, so `dismiss` only
 * forgets.
 */
export const useResetMfa = (userId: string): ResetMfaController => {
  const { data, error, isPending, mutate, reset } = useResetUserMfa();

  const resetMfa = useCallback(() => {
    mutate(userId);
  }, [mutate, userId]);

  const dismiss = useCallback(() => {
    reset();
  }, [reset]);

  return {
    result: data,
    failure: error === null ? undefined : errorMessage(error),
    isPending,
    resetMfa,
    dismiss,
  };
};
