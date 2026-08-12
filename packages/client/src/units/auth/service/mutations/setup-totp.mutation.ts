import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { setupTotp, type TotpEnrolmentDraft } from '@units/auth/api';

/**
 * Drafts a secret — the one operation in the client whose **answer is a credential**.
 *
 * A mutation rather than a query, and not because it is a `POST`: a query is a cache entry by
 * definition, and the base32 secret must not become one (CLAUDE.md, «Чувствительность данных»).
 * The same reasoning the auth unit already applies to session refresh.
 *
 * `gcTime: 0` bounds how long the secret survives after the screen stops using it. TanStack keeps a
 * settled mutation for five minutes by default so that a remounting component can read its result;
 * here that default would mean the secret sitting in the mutation cache for five minutes after the
 * person navigated away. Zero means it goes with the last observer — and `abandon()` on the hook
 * drops it before that, on purpose rather than on timing.
 *
 * No local `onError`: a refusal here (`409 mfa_already_enabled`, `429`) is «the button did nothing»
 * and belongs in the one global toast, because there is no field on screen for it to sit beside
 * (`rules/errors-and-toasts.mdc` §3). The two operations that *do* override the toast — confirm and
 * regenerate — do so because their failures have to be read together with the fields they are about.
 */
export const useSetupTotp = (): UseMutationResult<TotpEnrolmentDraft, Error, void> =>
  useMutation({
    mutationFn: () => setupTotp(),
    gcTime: 0,
  });
