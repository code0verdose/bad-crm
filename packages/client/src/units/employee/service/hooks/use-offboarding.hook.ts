import { useCallback } from 'react';

import { type OffboardingReport } from '@units/employee/api';
import { useDeactivateUser } from '@units/employee/service/mutations';
import { errorMessageKey } from '@shared/api';

export interface OffboardingController {
  /** What the server actually revoked, or `undefined` while nothing has been run yet. */
  readonly report: OffboardingReport | undefined;
  /**
   * The refusal as a sentence key, chosen from the `code` and never from `detail`
   * (`rules/errors-and-toasts.mdc` §10). Absent while nothing has been refused.
   *
   * A key rather than the `Error`, and that is the point of this hook: the dialog renders what it
   * is given and translates nothing. `error → messageKey` is a rule about how failures are read,
   * and it lives on one layer of this client — `service/hooks` — for every confirmation.
   */
  readonly failureKey: string | undefined;
  readonly isPending: boolean;
  /** Runs it. The reason is trimmed here, because the request body is the unit's business. */
  readonly deactivate: (reason: string) => void;
  /** The dialog is done with: clears the answer so the next open starts from the confirmation. */
  readonly dismiss: () => void;
}

/**
 * Switching a colleague off, as the object a dialog can render — the unit's public API for `ui`
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the dialog reached past it.** `OffboardingDialog` called
 * `EmployeeMutations.useDeactivateUser()` directly and turned the `Error` into a key itself, which
 * skips the middle link of the call chain (rule 4) and puts another copy of `error → messageKey` in
 * a widget — the fourth arrangement of one job, next to three confirmations that had already been
 * moved into their units. `useReactivation` beside it says as much in as many words: «the
 * offboarding half still lives in `widgets/offboarding`». This is that half.
 *
 * **Nothing is invalidated here**, and that is the mutation's decision rather than an omission:
 * `deactivate-user.mutation.ts` invalidates `QueryKeys.Employees.all` in its own `onSuccess`, so the
 * directory and the card refresh as soon as the server has answered. Unlike a reactivation, the
 * refresh does not take the dialog off the screen — the report is what the dialog switches to — so
 * there is nothing for `dismiss` to hold back and it only forgets.
 */
export const useOffboarding = (userId: string): OffboardingController => {
  const { data, error, isPending, mutate, reset } = useDeactivateUser();

  const deactivate = useCallback(
    (reason: string) => {
      mutate({ userId, reason: reason.trim() });
    },
    [mutate, userId],
  );

  const dismiss = useCallback(() => {
    reset();
  }, [reset]);

  return {
    report: data,
    failureKey: error === null ? undefined : errorMessageKey(error),
    isPending,
    deactivate,
    dismiss,
  };
};
