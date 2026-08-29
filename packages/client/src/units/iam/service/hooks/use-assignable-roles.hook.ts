import { useMemo } from 'react';

import { type RoleListEntry } from '@units/iam/api';
import { useRolesMatrixQuery } from '@units/iam/service/queries';

import { useCan } from './use-can.hook.js';

/** One role as a `<select>` sees it. */
export interface RoleOption {
  readonly value: string;
  readonly label: string;
}

export interface AssignableRoles {
  /** The roles themselves, for callers joining an identifier back to a name. */
  readonly entries: readonly RoleListEntry[];
  /** The same roles as select options, for callers offering a choice. */
  readonly options: readonly RoleOption[];
}

/** One frozen array, so «not asked» and «not answered yet» are the same reference every time. */
const NO_ROLES: readonly RoleListEntry[] = [];

/**
 * The roles a screen may name — the unit's public API for the two screens that need names rather
 * than the matrix (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because two screens reached past it.** `widgets/invite-member` and
 * `widgets/invitation-list` each called `IamQueries.useRolesMatrixQuery({ enabled: can('role:read')
 * })` themselves — the middle link of the chain skipped (rule 4) — and the first then mapped the
 * answer into `<select>` options in the component body, which rule 5 keeps out of markup.
 *
 * **The right is decided here because it is the same one both times.** Reading roles is
 * `role:read`, and neither screen is *about* roles: one is reached with `invitation:create`, the
 * other with `invitation:read`, and a person may hold either without the right to be told what the
 * roles are called. Asking anyway would put a 403 on a screen that is working correctly, so a
 * reader who may not be told simply gets an empty list — and sends the invitation with no role,
 * which is what the empty select then offers.
 */
export const useAssignableRoles = (): AssignableRoles => {
  const { can } = useCan();
  const query = useRolesMatrixQuery({ enabled: can('role:read') });
  const entries = query.data ?? NO_ROLES;
  // Memoised against the answer rather than against `entries`: the frozen fallback keeps the
  // reference stable while nothing has arrived, so a screen that re-renders on every keystroke does
  // not rebuild the option list to say the same nothing.
  const options = useMemo(
    () => entries.map((role) => ({ value: role.id, label: role.name })),
    [entries],
  );

  return { entries, options };
};
