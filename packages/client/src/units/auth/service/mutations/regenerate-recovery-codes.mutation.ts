import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import {
  regenerateRecoveryCodes,
  type RecoveryCodesIssued,
  type RecoveryCodesReissue,
} from '@units/auth/api';
import { QueryKeys } from '@shared/lib';

/**
 * Replaces the recovery-code set, behind the password and a live code.
 *
 * Same shape as `useConfirmTotp` and for the same three reasons: pessimistic because the answer is
 * the payload, `gcTime: 0` because the payload is ten credentials, and `invalidateQueries` because
 * the counter on screen — «2 of 10 left», the reason the person pressed this button — is now wrong
 * by ten. That last one is asserted as a second `GET /auth/2fa/recovery-codes`, not as a call to
 * this callback: a spy on the callback would pass with the wrong key in it.
 *
 * The local `onError` makes the toast stand aside so the refusal can be rendered next to the two
 * fields it is about. `403 reauthentication_required` answers a wrong password, a wrong code and
 * «no TOTP on this account» alike — the server evaluates both proofs whatever the first says — so
 * the message has to sit where both fields are, not in a corner naming neither.
 */
export const useRegenerateRecoveryCodes = (): UseMutationResult<
  RecoveryCodesIssued,
  Error,
  RecoveryCodesReissue
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (reissue: RecoveryCodesReissue) => regenerateRecoveryCodes(reissue),
    gcTime: 0,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.RecoveryCodes.all });
    },
    onError: () => undefined,
  });
};
