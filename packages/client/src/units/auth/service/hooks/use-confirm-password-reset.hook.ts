import { type ResetPasswordFormValues } from '@units/auth/model';
import { useConfirmPasswordResetMutation } from '@units/auth/service/mutations';

export interface PasswordResetOptions {
  /** The single-use token, as the route path carried it. It leaves in a body and nowhere else. */
  readonly token: string;
  /**
   * What to do once the password is set. The unit does not navigate — a unit that imported a router
   * would point up the layers (`rules/frontend-fsd.mdc` rule 1) — so the page passes the way out.
   */
  readonly onDone: () => void;
}

export interface PasswordResetController {
  /** True while the request is in flight — the submit button carries it, nothing else does. */
  readonly isPending: boolean;
  readonly submit: (values: ResetPasswordFormValues) => void;
}

/**
 * The unit's public surface for the reset screen (`rules/frontend-fsd.mdc` rule 6).
 *
 * It is where the token and the password are put together, and where `confirmPassword` stops
 * existing: the contract has two fields, and a confirmation sent to the server would be a second
 * copy of a credential on the wire for no gain.
 *
 * `onDone` is passed to `mutate` per call rather than declared as the mutation's own `onSuccess`,
 * because it belongs to this screen rather than to the operation — the mutation announces the
 * success to everybody, the page decides where the person goes next. It also leaves the mutation's
 * `onError` undefined, which is what keeps the single red toast with the global handler
 * (`rules/errors-and-toasts.mdc` §3).
 */
export const useConfirmPasswordReset = ({
  token,
  onDone,
}: PasswordResetOptions): PasswordResetController => {
  const mutation = useConfirmPasswordResetMutation();

  return {
    isPending: mutation.isPending,

    submit: ({ newPassword }) => {
      mutation.mutate({ token, newPassword }, { onSuccess: onDone });
    },
  };
};
