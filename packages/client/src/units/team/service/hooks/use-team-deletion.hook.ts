import { useCallback } from 'react';

import { useDeleteTeam } from '@units/team/service/mutations';
import { errorMessageKey } from '@shared/api';

export interface TeamDeletion {
  /**
   * The refusal as a sentence key, chosen from the `code` and never from `detail`
   * (`rules/errors-and-toasts.mdc` §10). Absent while nothing has been refused.
   */
  readonly failureKey: string | undefined;
  readonly isPending: boolean;
  /**
   * Disbands it. `onDeleted` fires only on success — the screen the dialog sits on stops existing,
   * and leaving it before the server agreed would strand the operator on a list that still has the
   * team in it.
   */
  readonly disband: (onDeleted?: () => void) => void;
  /** The dialog is done with: forgets the refusal so the next open starts clean. */
  readonly dismiss: () => void;
}

/**
 * Disbanding a team, as the object a dialog can render — the unit's public API for `ui`
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the dialog reached past it.** `TeamDeleteDialog` called
 * `TeamMutations.useDeleteTeam()` directly and turned the `Error` into a key itself: the middle link
 * of the call chain skipped (rule 4), and the rule about reading a failure by its `code` applied a
 * second time, in a widget.
 *
 * The id is taken once, when the dialog is built, rather than passed to `disband`: the confirmation
 * is about one named team, and a run method that accepts an id is a run method that can be handed a
 * different one than the sentence above the button names.
 *
 * The success toast and the invalidation stay in `delete-team.mutation.ts`: they are properties of
 * the write, not of the screen that started it.
 */
export const useTeamDeletion = (teamId: string): TeamDeletion => {
  const { error, isPending, mutate, reset } = useDeleteTeam();

  const disband = useCallback(
    (onDeleted?: () => void) => {
      mutate(teamId, onDeleted === undefined ? undefined : { onSuccess: onDeleted });
    },
    [mutate, teamId],
  );

  const dismiss = useCallback(() => {
    reset();
  }, [reset]);

  return {
    failureKey: error === null ? undefined : errorMessageKey(error),
    isPending,
    disband,
    dismiss,
  };
};
