import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { confirmTotp, type RecoveryCodesIssued, type TotpConfirmation } from '@units/auth/api';
import { QueryKeys } from '@shared/lib';

/**
 * Turns 2FA on and receives the ten recovery codes — once, ever.
 *
 * **Pessimistic, and there is nothing to be optimistic about**: the answer *is* the payload. An
 * optimistic patch would have to invent ten codes that do not exist (`rules/tanstack-query.mdc` §7).
 *
 * `invalidateQueries` on success is not bookkeeping. The screen decides what to show from
 * `GET /auth/2fa/recovery-codes`, and that answer said «no enrolment» a moment ago; without the
 * invalidation the person finishes enrolling and keeps looking at the enrolment form, with a
 * «Enable» button that now answers `409`. The assertion for it is a **second request** to that
 * endpoint, not a spy on this callback.
 *
 * `gcTime: 0` for the same reason as the draft above, and here it matters more: this result is ten
 * plaintext codes whose only other copy is an argon2id hash. They live as long as the screen is
 * showing them and no longer — `dismissCodes()` on the hook resets this mutation the moment the
 * person confirms they have saved them.
 *
 * The local `onError` exists to make the global toast stand aside (`rules/tanstack-query.mdc` §10).
 * It has to: a refusal here is not just «that failed» but a fork in the road — a wrong code, an
 * already-spent code, a wrong password, or an enrolment that already completed on a request whose
 * answer was lost. The screen says which and where to go next, beside the field the person is
 * looking at; a toast in the corner would be a second signal for one action and the wrong one to
 * read.
 */
export const useConfirmTotp = (): UseMutationResult<
  RecoveryCodesIssued,
  Error,
  TotpConfirmation
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (confirmation: TotpConfirmation) => confirmTotp(confirmation),
    gcTime: 0,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.RecoveryCodes.all });
    },
    onError: () => undefined,
  });
};
