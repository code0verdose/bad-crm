import { useCallback } from 'react';

import { type RoleChangeOutcome, type RoleChanges } from '@units/iam/api';
import { useApplyRoleChanges } from '@units/iam/service/mutations';
import { useRoleChangesPreview } from '@units/iam/service/queries';

export interface RoleChangeReview {
  /** What the server said the draft would do — empty until a review has come back. */
  readonly outcomes: readonly RoleChangeOutcome[];
  readonly isReviewing: boolean;
  readonly isApplying: boolean;
  /** Asks what would happen. `onReady` fires only once the answer is here. */
  readonly review: (changes: RoleChanges, onReady?: () => void) => void;
  /**
   * Saves it. Whether the confirmation of dangerous keys goes on the wire is decided **here**, from
   * the outcomes this hook already holds — the caller does not compute it and cannot forget it.
   */
  readonly apply: (changes: RoleChanges, onDone?: () => void) => void;
}

/**
 * The two halves of saving a role draft — «what would this do» and «do it» — as one object
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the widget reached past it.** `RoleMatrix` called the preview and the save
 * directly and derived «does anything dangerous arrive» itself, then fed that back into the request:
 * the middle link of the call chain skipped (rule 4), and the rule that decides when
 * `confirmDangerous` may be sent living in a widget.
 *
 * That derivation is the reason the two belong together rather than in two hooks. `confirmDangerous`
 * is the client's repeat of a request the server refused with `428`, and it is honest **only**
 * because the person has just seen the outcomes that justify it. Splitting the preview from the save
 * would let a caller send the confirmation without having read anything — which is precisely the
 * check the header exists to record.
 *
 * Neither half toasts: the global mutation handler is the single signal for both
 * (`rules/errors-and-toasts.mdc` §2), and the success toast for the save stays in
 * `apply-role-changes.mutation.ts`, where it is a property of the write.
 */
export const useRoleChangeReview = (): RoleChangeReview => {
  const preview = useRoleChangesPreview();
  const applyChanges = useApplyRoleChanges();

  const outcomes = preview.data ?? EMPTY_OUTCOMES;

  const review = useCallback(
    (changes: RoleChanges, onReady?: () => void) => {
      preview.mutate(changes, onReady === undefined ? undefined : { onSuccess: onReady });
    },
    [preview],
  );

  const apply = useCallback(
    (changes: RoleChanges, onDone?: () => void) => {
      const dangerous = outcomes.some((outcome) => outcome.dangerous.length > 0);

      applyChanges.mutate(
        { changes, ...(dangerous ? { confirmDangerous: true } : {}) },
        onDone === undefined ? undefined : { onSuccess: onDone },
      );
    },
    [applyChanges, outcomes],
  );

  return {
    outcomes,
    isReviewing: preview.isPending,
    isApplying: applyChanges.isPending,
    review,
    apply,
  };
};

/** One frozen array, so «nothing reviewed yet» is the same reference every render. */
const EMPTY_OUTCOMES: readonly RoleChangeOutcome[] = [];
