import { useCallback } from 'react';

import { toTeamDraft } from '@units/team/lib';
import { type TeamForm } from '@units/team/model';
import { useCreateTeam } from '@units/team/service/mutations';
import { errorMessage, type ErrorMessage } from '@shared/api';

export interface TeamCreation {
  /**
   * The refusal as a sentence — key and values — chosen from the `code` and never from `detail`
   * (`rules/errors-and-toasts.mdc` §10). Absent while nothing has been refused.
   *
   * A message rather than the `Error`: the dialog renders what it is given and translates nothing.
   */
  readonly failure: ErrorMessage | undefined;
  readonly isPending: boolean;
  /**
   * Creates it from the form's own values — the mapping to the request body lives here, not in the
   * dialog (`to-team-draft.util.ts` explains why an empty description has to become `null`).
   *
   * `onCreated` fires only on success, which is how the dialog closes on the outcome that has
   * nothing left to show and stays open on the one that has. A per-call callback rather than an
   * `isSuccess` flag the caller watches: a flag would have to be cleared before the next open, and
   * «close when the flag turns true» is the effect `rules/frontend-fsd.mdc` rule 11 exists to
   * prevent.
   */
  readonly create: (values: TeamForm, onCreated?: () => void) => void;
  /** The dialog is done with: forgets the refusal so the next open starts clean. */
  readonly dismiss: () => void;
}

/**
 * Creating a team, as the object a dialog can render — the unit's public API for `ui`
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the dialog reached past it.** `TeamCreateDialog` called
 * `TeamMutations.useCreateTeam()` directly, mapped the form to the draft itself and turned the
 * `Error` into a key itself: the middle link of the call chain skipped (rule 4), and two pieces of
 * domain knowledge — how a form becomes a body, how a failure becomes a sentence — sitting in a
 * widget.
 *
 * The success toast and the invalidation stay in `create-team.mutation.ts`, where they were: they
 * are properties of the write, not of the screen that started it.
 */
export const useTeamCreation = (): TeamCreation => {
  const { error, isPending, mutate, reset } = useCreateTeam();

  const create = useCallback(
    (values: TeamForm, onCreated?: () => void) => {
      mutate(toTeamDraft(values), onCreated === undefined ? undefined : { onSuccess: onCreated });
    },
    [mutate],
  );

  const dismiss = useCallback(() => {
    reset();
  }, [reset]);

  return {
    failure: error === null ? undefined : errorMessage(error),
    isPending,
    create,
    dismiss,
  };
};
