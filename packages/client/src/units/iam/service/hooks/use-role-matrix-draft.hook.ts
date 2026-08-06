import { useCallback, useMemo, useState } from 'react';

import { type RoleChanges, type RoleListEntry } from '@units/iam/api';

export interface RoleMatrixDraft {
  /** Does this role grant this permission **as the draft leaves it**. */
  readonly grants: (roleId: string, permission: string) => boolean;
  /** Flips one cell. A system role is ignored: its composition is code, not data. */
  readonly toggle: (roleId: string, permission: string) => void;
  /** Roles whose composition actually differs from what the server holds. */
  readonly changes: RoleChanges['changes'];
  /** How many **roles** the draft would change — the number the bar shows. */
  readonly changeCount: number;
  readonly reset: () => void;
}

/**
 * The unsaved state of the administration matrix.
 *
 * Everything here exists so that a click writes nothing. Twelve cells across three roles are one
 * request, made when the person says so, and until then the only thing that changed is a `Set` in
 * this component's state.
 *
 * Two properties are worth stating because both are easy to get subtly wrong:
 *
 * - **a cell toggled back is not a change.** The draft compares against what the server holds, not
 *   against the last click, so a role whose composition ended up where it started is absent from
 *   the request — and nobody holding it is invalidated for a change that did not happen;
 * - **the draft reads through to fresh data.** A role the person never touched shows what the last
 *   fetch says, including one that appeared while they were editing, and their edits survive that
 *   refetch untouched.
 */
export const useRoleMatrixDraft = (roles: readonly RoleListEntry[]): RoleMatrixDraft => {
  const [edited, setEdited] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());

  const stored = useMemo(
    () => new Map(roles.map((role) => [role.id, new Set(role.permissions)])),
    [roles],
  );
  const systemRoles = useMemo(
    () => new Set(roles.filter((role) => role.isSystem).map((role) => role.id)),
    [roles],
  );

  const grants = useCallback(
    (roleId: string, permission: string) =>
      (edited.get(roleId) ?? stored.get(roleId))?.has(permission) === true,
    [edited, stored],
  );

  const toggle = useCallback(
    (roleId: string, permission: string) => {
      if (systemRoles.has(roleId)) return;

      setEdited((current) => {
        const before = current.get(roleId) ?? stored.get(roleId);

        // A role the last fetch does not have: it was deleted by somebody else while this draft was
        // open. Ignoring the click is the honest answer — the column is about to disappear, and
        // inventing an empty composition for it would send the server a change to a role that is
        // gone.
        if (before === undefined) return current;

        const composition = new Set(before);

        if (composition.has(permission)) composition.delete(permission);
        else composition.add(permission);

        return new Map(current).set(roleId, composition);
      });
    },
    [stored, systemRoles],
  );

  const changes = useMemo(
    () =>
      [...edited]
        .filter(([roleId, composition]) => differs(composition, stored.get(roleId)))
        .map(([roleId, composition]) => ({ roleId, permissions: [...composition] })),
    [edited, stored],
  );

  return {
    grants,
    toggle,
    changes,
    changeCount: changes.length,
    reset: useCallback(() => {
      setEdited(new Map());
    }, []),
  };
};

/** Same members, in any order — the composition is a set, and the wire order is not a change. */
const differs = (drafted: ReadonlySet<string>, stored: ReadonlySet<string> | undefined): boolean =>
  stored === undefined ||
  drafted.size !== stored.size ||
  [...drafted].some((permission) => !stored.has(permission));
