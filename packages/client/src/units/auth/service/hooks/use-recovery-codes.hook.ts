import { errorMessageKey } from '@shared/api';
import { type RegenerateRecoveryCodesFormValues } from '@units/auth/model';
import { useRegenerateRecoveryCodes } from '@units/auth/service/mutations/regenerate-recovery-codes.mutation.js';
import { useRecoveryCodeStatusQuery } from '@units/auth/service/queries/recovery-code-status.query.js';

/** At or below this many unused codes the screen warns, permanently, until the set is replaced. */
export const RECOVERY_CODES_LOW_THRESHOLD = 3;

export interface RecoveryCodes {
  /** Of the counter query — the screen owes a skeleton and a retry, like every other read. */
  readonly status: 'pending' | 'error' | 'success';
  /** Whether this account has 2FA at all. See the query for why the counter is what answers it. */
  readonly isEnrolled: boolean;
  readonly total: number;
  readonly remaining: number;
  readonly isLow: boolean;
  readonly retry: () => void;
  /** A freshly issued set, for as long as the person is looking at it. */
  readonly issuedCodes: readonly string[] | undefined;
  readonly isRegenerating: boolean;
  /** i18n key of a refused reissue, chosen from the problem `code`. */
  readonly failureKey: string | undefined;
  readonly regenerate: (values: RegenerateRecoveryCodesFormValues) => void;
  readonly dismissCodes: () => void;
}

/**
 * The recovery-code half of the security screen: the counter, the warning threshold and the reissue
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * `total` and `remaining` fall back to zero while the answer is on its way, and the screen is
 * expected to render `status` through `DataState` rather than to read the zeroes — «no codes» and
 * «not asked yet» are different sentences and only one of them belongs on screen.
 *
 * `isLow` is computed here rather than in the component because it is a product rule with a number
 * in it (STORY-013-02, acceptance 6), and a number in a component is a number that gets a second
 * value in the next component. Zero is «low» too: the banner at zero says something stronger, but
 * whether to warn at all is one decision.
 */
export const useRecoveryCodes = (): RecoveryCodes => {
  const status = useRecoveryCodeStatusQuery();
  const reissue = useRegenerateRecoveryCodes();

  const total = status.data?.total ?? 0;
  const remaining = status.data?.remaining ?? 0;

  return {
    status: status.status,
    isEnrolled: total > 0,
    total,
    remaining,
    isLow: total > 0 && remaining <= RECOVERY_CODES_LOW_THRESHOLD,
    retry: () => {
      void status.refetch();
    },
    issuedCodes: reissue.data?.codes,
    isRegenerating: reissue.isPending,
    failureKey: reissue.error === null ? undefined : errorMessageKey(reissue.error),
    regenerate: (values: RegenerateRecoveryCodesFormValues) => {
      reissue.mutate(values);
    },
    dismissCodes: () => {
      reissue.reset();
    },
  };
};
