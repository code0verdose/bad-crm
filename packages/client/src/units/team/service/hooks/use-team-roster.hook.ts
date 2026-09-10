import { useCallback } from 'react';

import { toTeamDraft } from '@units/team/lib';
import { type TeamForm, type TeamRole } from '@units/team/model';
import {
  useAddTeamMember,
  useRemoveTeamMember,
  useUpdateTeam,
} from '@units/team/service/mutations';

export interface TeamRoster {
  readonly isRenaming: boolean;
  /** Renames it from the form's own values; the mapping to the request body lives here. */
  readonly rename: (values: TeamForm) => void;
  readonly isAdding: boolean;
  readonly add: (userId: string, teamRole: TeamRole) => void;
  /**
   * Whose removal is in flight, or `undefined` while none is.
   *
   * Named rather than counted, because the wait belongs to the row whose control was pressed: a
   * shared boolean would spin every row of the roster at once. Read from the mutation's own
   * `variables` and never mirrored into state, so it cannot outlive the request it describes
   * (`rules/frontend-fsd.mdc` rule 11).
   */
  readonly removingUserId: string | undefined;
  readonly remove: (userId: string) => void;
}

/**
 * The three writes of a team screen, composed — the unit's public API for `ui`
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the screen reached past it.** `TeamDetail` called `useUpdateTeam`,
 * `useAddTeamMember` and `useRemoveTeamMember` itself and mapped the form to the draft itself: the
 * middle link of the call chain skipped (rule 4) in the same three-line way the four confirmation
 * dialogs skipped it, and only harder to notice because the calls sit in a composition point that
 * is allowed to know a great deal else.
 *
 * **No `failure`, and that is deliberate rather than missing.** These controls sit on the page
 * rather than in a modal, so the one global toast keyed by `code` is visible exactly where the
 * action was taken, and the three mutations therefore declare no local `onError`
 * (`add-team-member.mutation.ts` says why at length). Handing `ui` a key it would have nothing to
 * render would be the second signal `rules/errors-and-toasts.mdc` §2 forbids.
 *
 * The team id is taken once: every one of the three is about the team this screen is.
 */
export const useTeamRoster = (teamId: string): TeamRoster => {
  const save = useUpdateTeam();
  const addition = useAddTeamMember();
  const removal = useRemoveTeamMember();

  const rename = useCallback(
    (values: TeamForm) => {
      save.mutate({ teamId, draft: toTeamDraft(values) });
    },
    [save, teamId],
  );

  const add = useCallback(
    (userId: string, teamRole: TeamRole) => {
      addition.mutate({ teamId, userId, teamRole });
    },
    [addition, teamId],
  );

  const remove = useCallback(
    (userId: string) => {
      removal.mutate({ teamId, userId });
    },
    [removal, teamId],
  );

  return {
    isRenaming: save.isPending,
    rename,
    isAdding: addition.isPending,
    add,
    removingUserId: removal.isPending ? removal.variables.userId : undefined,
    remove,
  };
};
