import { SharedPermissions } from '@bad-crm/shared';

import {
  type RoleRepositoryPort,
  type RoleSummary,
  type SystemRoleChange,
  type SystemRoleDraft,
} from '@/application/iam/ports/role-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';

export interface ProvisionSystemRolesInput {
  /**
   * The organization whose roles are being written — the scope the caller already opened.
   *
   * Passed rather than read from an ambient store because the application layer may not know there
   * is one; the writer refuses an event whose organization disagrees with the open scope, so the
   * two cannot drift apart silently.
   */
  readonly organizationId: string;
}

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
 *
 * ## Why the upgrade path writes to the trail (STORY-011-02, acceptance 7)
 *
 * `pnpm db:provision-roles` re-applies this to **every** organization of an installation, so an
 * upgrade can move who can do what without anybody asking for it. Read from the outside that is
 * «people gained rights over the weekend and the journal says nothing» — precisely the question the
 * trail exists to answer, so the run files its own record.
 *
 * Three decisions shape what it files, and each is a refusal of an easier version:
 *
 *   * **Inside the tenant, one entry per role that moved.** The audit table is tenant-scoped by
 *     construction, and the reader of «my organization's rights changed» is the owner of *that*
 *     organization, not the operator running the command. An installation-wide summary has nowhere
 *     to be filed and nobody to read it.
 *   * **Only when something actually changed.** The run is idempotent and is executed on every
 *     upgrade; a record per organization per run would make hundreds of «nothing happened» entries
 *     per release, and a trail nobody can read is a trail nobody reads.
 *   * **Nothing at all on a first provisioning.** A fresh organization is not an installation whose
 *     rights moved — it is being created, and what it was given is what the release ships.
 *     `organization.registered` already records that, and seven more entries beside it would be the
 *     same fact written eight times.
 *
 * The actor carries no `userId`, which is what makes the row `actorType = SYSTEM`: the writer
 * derives it (`audit-log.adapter.ts`) rather than taking it from a call site, so «the system did
 * this» cannot be claimed by a path that does have a person in it.
 *
 * **Fail-closed, in the transaction of the change.** `record` is awaited inside the caller's
 * `withTenant` scope: a rights change nobody could write down is rolled back rather than committed
 * unrecorded.
 */
export class ProvisionSystemRolesUseCase {
  constructor(
    private readonly roles: RoleRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: ProvisionSystemRolesInput): Promise<readonly RoleSummary[]> {
    const result = await this.roles.provisionSystemRoles(SYSTEM_ROLE_DRAFTS);

    if (result.preexistingCount > 0) {
      for (const change of result.changes) {
        await this.record(input.organizationId, change);
      }
    }

    return result.roles;
  }

  private async record(organizationId: string, change: SystemRoleChange): Promise<void> {
    // A role this run created into an organization that already had the others is a role the
    // release added — a creation, and the trail says so rather than describing it as an update
    // from a composition that never existed.
    const before = change.existedBefore
      ? { before: { key: change.key, permissionCount: change.countBefore } }
      : {};

    await this.audit.record({
      action: change.existedBefore ? 'role.updated' : 'role.created',
      actor: { userId: undefined, organizationId, ipAddress: undefined },
      target: { type: 'ROLE', id: change.roleId },
      ...before,
      // The delta, not the two compositions: both lists are `SYSTEM_ROLE_PERMISSIONS` of a release
      // and recomputable from it, while «which keys moved here, on this run» is written nowhere
      // else — and `owner` holds the whole catalogue, which would otherwise land in the trail twice
      // for every organization of the installation.
      after: {
        key: change.key,
        permissionCount: change.countAfter,
        granted: [...change.granted],
        revoked: [...change.revoked],
      },
      requestId: undefined,
    });
  }
}

/** The seven drafts, built once from the matrix rather than per call. */
export const SYSTEM_ROLE_DRAFTS: readonly SystemRoleDraft[] =
  SharedPermissions.SYSTEM_ROLE_KEYS.map((key, index) => ({
    key,
    name: key,
    isDefault: key === SharedPermissions.DEFAULT_SYSTEM_ROLE,
    // Descending: `owner` first in the document is `owner` highest in the interface.
    priority: SharedPermissions.SYSTEM_ROLE_KEYS.length - index,
    permissions: SharedPermissions.SYSTEM_ROLE_PERMISSIONS[key],
  }));
