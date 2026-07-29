import { type ForgotPasswordFormValues } from '@units/auth/model';
import { useRequestPasswordResetMutation } from '@units/auth/service/mutations';

export interface PasswordResetRequestController {
  /** True while the request is in flight — the submit button carries it, nothing else does. */
  readonly isPending: boolean;
  /**
   * Whether the request has been accepted. It says nothing about whether a mail was sent, because
   * the answer says nothing about it either: 202 is constant by construction.
   */
  readonly isSent: boolean;
  readonly submit: (values: ForgotPasswordFormValues) => void;
}

/**
 * The unit's public surface for the recovery screen (`rules/frontend-fsd.mdc` rule 6): what the form
 * needs, and nothing about the network.
 *
 * `isSent` is read from the mutation at render rather than copied into state by an effect
 * (`rules/frontend-fsd.mdc` rule 11) — it is the mutation's own status under a name the screen can
 * use without knowing what a mutation is.
 *
 * `submit` returns nothing and never rejects: `mutate`, not `mutateAsync`. A promise handed to a
 * form's submit handler is a promise nobody awaits, and an unhandled rejection is what a refused
 * request would produce. The refusal is reported once, by the global `MutationCache.onError`.
 */
export const useRequestPasswordReset = (): PasswordResetRequestController => {
  const mutation = useRequestPasswordResetMutation();

  return {
    isPending: mutation.isPending,
    isSent: mutation.isSuccess,

    submit: ({ email }) => {
      mutation.mutate({ email });
    },
  };
};
