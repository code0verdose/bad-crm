/**
 * The system roles every organization starts with.
 *
 * A separate port from `UserRepositoryPort` because it is a separate decision: *which* roles exist
 * and which permissions each carries is the subject of [EPIC-011], and the bootstrap must not have
 * an opinion about it beyond "the owner ends up holding the owner role". The four keys below are
 * the ones `docs/security/permission-model.md` names; the permissions behind them are filled in by
 * that epic, which also writes this port's adapter.
 */

export const SYSTEM_ROLE_KEYS = ['owner', 'admin', 'member', 'viewer'] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export interface RoleSeederPort {
  /**
   * Creates the system roles of the organization in the current scope and assigns `owner` to the
   * given user. One call, because the two halves must not be separable: an organization whose owner
   * role exists but is assigned to nobody is an installation nobody can administer.
   */
  seedSystemRoles(ownerUserId: string): Promise<void>;
}
