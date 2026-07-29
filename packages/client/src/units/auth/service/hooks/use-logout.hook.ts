import { useLogoutMutation } from '@units/auth/service/mutations';

export interface LogoutController {
  /** True while the request is in flight — the control that started it carries the wait. */
  readonly isPending: boolean;
  readonly signOut: () => void;
}

/**
 * The unit's public surface for whichever control offers to sign out (`rules/frontend-fsd.mdc`
 * rule 6). The widget calls this; it does not know that a request is involved, and it does not
 * navigate — the bus event does that, one layer up.
 */
export const useLogout = (): LogoutController => {
  const mutation = useLogoutMutation();

  return {
    isPending: mutation.isPending,

    signOut: () => {
      mutation.mutate();
    },
  };
};
