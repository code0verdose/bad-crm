import { useMemo } from 'react';

import { useUserPermissionsQuery } from '@units/iam/service/queries';

export interface HeldRoleNames {
  /**
   * Three outcomes, never folded into two.
   *
   * This is a claim about somebody else's power, so «loading» rendered as «no roles» would be a
   * false all-clear on the one screen where a false all-clear matters — and so would a failed read.
   */
  readonly status: 'pending' | 'error' | 'success';
  /** The names, in the order the server holds them. Empty until the read succeeds. */
  readonly names: readonly string[];
}

/** One frozen array, so «not answered yet» is the same reference on every render. */
const NO_NAMES: readonly string[] = [];

/**
 * What one account's roles are called — the unit's public API for the screens that have to say them
 * out loud (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because a dialog reached past it.** `widgets/reactivation/ui/reactivation-roles`
 * called `IamQueries.useUserPermissionsQuery()` itself (rule 4) and mapped the answer down to names
 * in the component body (rule 5).
 *
 * **Names only, and only from this read.** `GET /users/{userId}/permissions` is the one address that
 * names the roles an account holds — the personnel document carries none — and the answer needs
 * `permission:override_read`, which the holder of `user:reactivate` need not have. The caller
 * therefore decides whether to mount this hook at all; a request certain to be refused is never
 * spent (`ux-architecture.md`, принцип 6).
 *
 * The names are handed over unjoined: turning a list into a sentence is `Intl.ListFormat` through
 * `SharedLib.formatList`, and which language it is in is a property of the reader rather than of the
 * account (`rules/i18n.mdc` §7).
 */
export const useHeldRoleNames = (userId: string): HeldRoleNames => {
  const query = useUserPermissionsQuery(userId);
  const roles = query.data?.roles;
  const names = useMemo(() => roles?.map((role) => role.name) ?? NO_NAMES, [roles]);

  return { status: query.status, names };
};
