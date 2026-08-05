import { SharedPermissions } from '@bad-crm/shared';

import {
  type RoleRepositoryPort,
  type RoleSummary,
  type SystemRoleDraft,
} from '@/application/iam/ports/role-repository.port.js';

/**
 * Gives an organization the seven roles it starts with.
 *
 * Called from two places, and the second is the reason it is a use-case rather than a line in the
 * bootstrap: when an organization is created, and again on upgrade. The composition of a system role
 * is **code** (`SYSTEM_ROLE_PERMISSIONS`), so a key added to the matrix has to reach installations
 * that already exist — and the alternative, a migration per matrix change, is a migration nobody
 * writes and everybody forgets.
 *
 * Ordering is not decoration: `priority` is what the interface sorts by, and a list that showed
 * `guest` above `owner` would be read as a hierarchy that does not exist. The order here is the
 * order of `SYSTEM_ROLE_KEYS`, which is the order of the document.
 *
 * The name is the key for now. Human-readable names are translated (`rules/i18n.mdc`) and the
 * interface renders them from `role.<key>` — storing an English sentence in the database would make
 * the label of a role depend on the release that created the organization.
 */
export class ProvisionSystemRolesUseCase {
  constructor(private readonly roles: RoleRepositoryPort) {}

  async execute(): Promise<readonly RoleSummary[]> {
    return this.roles.provisionSystemRoles(SYSTEM_ROLE_DRAFTS);
  }
}

/** The seven drafts, built once from the matrix rather than per call. */
export const SYSTEM_ROLE_DRAFTS: readonly SystemRoleDraft[] = SharedPermissions.SYSTEM_ROLE_KEYS.map(
  (key, index) => ({
    key,
    name: key,
    isDefault: key === SharedPermissions.DEFAULT_SYSTEM_ROLE,
    // Descending: `owner` first in the document is `owner` highest in the interface.
    priority: SharedPermissions.SYSTEM_ROLE_KEYS.length - index,
    permissions: SharedPermissions.SYSTEM_ROLE_PERMISSIONS[key],
  }),
);
