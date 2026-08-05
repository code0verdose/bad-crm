import { SharedPermissions } from '@bad-crm/shared';

import {
  type RoleRepositoryPort,
  type RoleSummary,
  type SystemRoleDraft,
} from '../../src/application/iam/ports/role-repository.port.js';

/**
 * A role repository that remembers what it was asked to provision.
 *
 * Records the drafts rather than counting calls: the property under test is «the organization got
 * the seven roles the matrix describes», and a counter would pass on a call that provisioned one
 * role, or seven wrong ones.
 *
 * `failing` exists for the same reason `FakeAuditLogger` has one: a use-case that must not commit
 * without its roles can only be shown to fail closed by a repository that refuses.
 */
export class FakeRoleRepository implements RoleRepositoryPort {
  readonly provisioned: SystemRoleDraft[][] = [];

  constructor(private readonly failing = false) {}

  provisionSystemRoles(drafts: readonly SystemRoleDraft[]): Promise<readonly RoleSummary[]> {
    if (this.failing) return Promise.reject(new Error('role repository is unavailable'));

    this.provisioned.push([...drafts]);

    return Promise.resolve(this.summaries());
  }

  listRoles(): Promise<readonly RoleSummary[]> {
    return Promise.resolve(this.summaries());
  }

  /** The keys of the last provisioning, in the order they were asked for. */
  get lastKeys(): readonly string[] {
    return (this.provisioned.at(-1) ?? []).map((draft) => draft.key);
  }

  private summaries(): readonly RoleSummary[] {
    return (this.provisioned.at(-1) ?? []).map((draft, index) => ({
      id: `role-${String(index)}`,
      key: draft.key,
      isSystem: true,
      isDefault: draft.isDefault,
      permissionCount: draft.permissions.length,
    }));
  }
}

export const SYSTEM_ROLE_COUNT = SharedPermissions.SYSTEM_ROLE_KEYS.length;
