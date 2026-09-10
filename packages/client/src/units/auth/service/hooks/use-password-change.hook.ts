import { useCallback } from 'react';

import { passwordChangeFailure, type PasswordChangeFailure } from '@units/auth/lib';
import { type ChangePasswordFormValues } from '@units/auth/model';
import { useChangePassword } from '@units/auth/service/mutations/change-password.mutation.js';

export interface PasswordChange {
  readonly isPending: boolean;
  /**
   * Where the last refusal belongs — under a field, or above all of them. Both halves are empty
   * while nothing has been refused, so the form needs no null check of its own.
   */
  readonly failure: PasswordChangeFailure;
  /**
   * Sends the two passwords the contract names. `onChanged` fires only on success, so the form can
   * clear itself — three password fields left full after a successful change are three copies of a
   * live credential sitting in the DOM.
   *
   * Required rather than optional: emptying the form is not a courtesy the caller may decline, and
   * an optional parameter nothing omits is a branch nothing covers.
   */
  readonly change: (values: ChangePasswordFormValues, onChanged: () => void) => void;
}

/** Nothing refused yet — a stable object, so it is not a new value on every render. */
const NOTHING_REFUSED: PasswordChangeFailure = { fieldErrors: {}, alert: undefined };

/**
 * Changing one's own password, as the object a form can render — the unit's public API for `ui`
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * **The mapping from a refusal to a place on screen lives here, not in the component.** It is the
 * middle link of the call chain (rule 4) and it is the link that would otherwise be copied: the
 * dialog next door had exactly that defect — a widget turning an `Error` into a key by itself — and
 * `useTotpDisposal` exists because of it.
 *
 * **`confirmPassword` is dropped here rather than in the component.** The form owns three values and
 * the contract owns two; deciding which two travel is a statement about the operation, and the
 * operation is what this hook is.
 */
export const usePasswordChange = (): PasswordChange => {
  const { error, isPending, mutate } = useChangePassword();

  const change = useCallback(
    (values: ChangePasswordFormValues, onChanged: () => void) => {
      mutate(
        { currentPassword: values.currentPassword, newPassword: values.newPassword },
        { onSuccess: onChanged },
      );
    },
    [mutate],
  );

  return {
    isPending,
    failure: error === null ? NOTHING_REFUSED : passwordChangeFailure(error),
    change,
  };
};
