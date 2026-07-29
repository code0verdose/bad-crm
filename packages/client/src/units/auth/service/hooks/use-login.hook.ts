import { ORGANIZATION_SELECTION_NOTICE_KEY, type LoginFormValues } from '@units/auth/model';
import { useLoginMutation } from '@units/auth/service/mutations';

export interface LoginController {
  /** True while the exchange is in flight — the submit button carries it, nothing else does. */
  readonly isPending: boolean;
  /**
   * i18n key of something the form has to say that is not a field error and not a failure:
   * today, only «this address belongs to more than one organization». `undefined` the rest of the
   * time.
   */
  readonly noticeKey: string | undefined;
  readonly submit: (credentials: LoginFormValues) => void;
}

/**
 * The unit's public surface for the sign-in screen (`rules/frontend-fsd.mdc` rule 6): everything
 * the form needs, and nothing about the network.
 *
 * `submit` returns nothing and never rejects. `mutate`, not `mutateAsync`: a promise handed to a
 * form's submit handler is a promise nobody awaits, and an unhandled rejection is what a refused
 * password would produce. The refusal is reported once, by the global `MutationCache.onError`; what
 * happens *after* a success is not this hook's business either — the store records the session, the
 * bus announces it, and the router re-checks its guards.
 *
 * `noticeKey` is derived at render from the answer that is already in the mutation, not copied into
 * state by an effect (`rules/frontend-fsd.mdc` rule 11).
 */
export const useLogin = (): LoginController => {
  const mutation = useLoginMutation();

  return {
    isPending: mutation.isPending,

    noticeKey:
      mutation.data?.status === 'organization_selection_required'
        ? ORGANIZATION_SELECTION_NOTICE_KEY
        : undefined,

    submit: (credentials) => {
      mutation.mutate(credentials);
    },
  };
};
