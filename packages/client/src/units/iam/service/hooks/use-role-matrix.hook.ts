import { useMemo } from 'react';

import { type RoleListEntry } from '@units/iam/api';
import { useRolesMatrixQuery } from '@units/iam/service/queries';

import { useRoleChangeReview, type RoleChangeReview } from './use-role-change-review.hook.js';
import { useRoleMatrixDraft, type RoleMatrixDraft } from './use-role-matrix-draft.hook.js';

/** One frozen array, so «no data yet» is the same reference every time. */
const NO_ROLES: readonly RoleListEntry[] = [];

export interface RoleMatrix {
  readonly status: 'pending' | 'error' | 'success';
  readonly roles: readonly RoleListEntry[];
  readonly refetch: () => Promise<unknown>;
  /** The unsaved cells, bound to the roles that arrived. */
  readonly draft: RoleMatrixDraft;
  /** The summary that precedes a save, and the save itself. */
  readonly review: RoleChangeReview;
}

/**
 * The administration matrix as one object — the unit's public API for the screen that renders it
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the widget reached past it.** `widgets/role-matrix` called
 * `IamQueries.useRolesMatrixQuery()` itself and then bound the draft to the answer and held the
 * review beside it: the middle link of the chain skipped (rule 4) on the one screen where the read
 * and the two writes are three views of the same thing, so binding them was left to the layer above.
 *
 * **The grouping is deliberately *not* here.** Which rows to show is a function of the search box
 * and the «only differences» switch — state that belongs to the screen and reaches this unit
 * nowhere else — so `groupPermissions` stays with the widget that owns those controls. What moved is
 * the part that is about the entity: the read, its three states, and what the draft is a draft *of*.
 *
 * The roles array is memoised for the reason the linter names precisely: `query.data ?? []` builds a
 * new array on every render while the read is pending, and that array is the identity the draft and
 * the grouping are keyed on — the whole catalogue would be walked again on every keystroke to
 * produce the same answer.
 */
export const useRoleMatrix = (): RoleMatrix => {
  const query = useRolesMatrixQuery();
  const roles = useMemo(() => query.data ?? NO_ROLES, [query.data]);
  const draft = useRoleMatrixDraft(roles);
  const review = useRoleChangeReview();

  return {
    status: query.status,
    roles,
    refetch: () => query.refetch(),
    draft,
    review,
  };
};
