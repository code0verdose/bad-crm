import { SharedPermissions } from '@bad-crm/shared';

import { ConflictError } from '../../src/domain/shared/errors/app.errors.js';

import {
  type CapabilityFacts,
  type EffectivePermissionsReaderPort,
} from '../../src/application/iam/ports/effective-permissions-reader.port.js';
import {
  type RoleRepositoryPort,
  type RoleSummary,
  type SystemRoleDraft,
} from '../../src/application/iam/ports/role-repository.port.js';
import {
  type CustomRoleRepositoryPort,
  type RoleComposition,
  type RoleDraft,
  type RoleListEntry,
} from '../../src/application/iam/ports/role-repository.port.js';
import {
  type OverrideDraftRow,
  type OverrideRow,
  type PermissionOverrideRepositoryPort,
} from '../../src/application/iam/ports/permission-override-repository.port.js';
import {
  type AssignmentDraft,
  type AssignmentResult,
  type RoleFacts,
  type UserRoleRepositoryPort,
} from '../../src/application/iam/ports/user-role-repository.port.js';

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

/**
 * Assignments in memory, with the two reads the policies depend on.
 *
 * The state is a set of `userId:roleId` pairs plus one role definition, which is everything the
 * commands ask about. Deliberately not a fake database: the queries themselves are proved against a
 * real PostgreSQL (`test/unit/persistence/user-role-repository.test.ts` for the arguments, the
 * integration suite for the policies), and what an HTTP test needs is the *decision path* — guard,
 * use-case, status.
 */
export class FakeUserRoleRepository implements UserRoleRepositoryPort {
  readonly assignments = new Set<string>();
  readonly versionBumps: string[] = [];

  constructor(
    private readonly options: {
      readonly role?: RoleFacts | null;
      readonly knownUsers?: readonly string[];
      readonly ownersAfter?: number;
    } = {},
  ) {}

  roleFacts(roleId: string): Promise<RoleFacts | null> {
    if (this.options.role === null) return Promise.resolve(null);

    return Promise.resolve(
      this.options.role ?? { roleId, key: 'manager', permissions: ['task:read'] },
    );
  }

  roleIdsOf(userId: string): Promise<readonly string[]> {
    return Promise.resolve(
      [...this.assignments]
        .filter((pair) => pair.startsWith(`${userId}:`))
        .map((pair) => pair.split(':')[1] ?? ''),
    );
  }

  userExists(userId: string): Promise<boolean> {
    return Promise.resolve((this.options.knownUsers ?? [userId]).includes(userId));
  }

  countHoldersOfKey(): Promise<number> {
    return Promise.resolve(this.options.ownersAfter ?? 2);
  }

  assign(draft: AssignmentDraft): Promise<AssignmentResult> {
    const pair = `${draft.userId}:${draft.roleId}`;
    const created = !this.assignments.has(pair);

    this.assignments.add(pair);

    return Promise.resolve({ created });
  }

  revoke(userId: string, roleId: string): Promise<boolean> {
    return Promise.resolve(this.assignments.delete(`${userId}:${roleId}`));
  }

  bumpPermissionsVersion(userId: string): Promise<void> {
    this.versionBumps.push(userId);

    return Promise.resolve();
  }
}

/**
 * What the guard reads to build an actor, and what a use-case reads about the person it is acting
 * on.
 *
 * Two answers rather than one, because the two are different questions and the override rules turn
 * on the second: the caller's capabilities decide whether they may write an exception, while the
 * *subject's* ownership decides whether a DENY is allowed at all. `subject` absent means «the same
 * as the caller», which is what the assignment suites need.
 */
export class FakeEffectivePermissionsReader implements EffectivePermissionsReaderPort {
  constructor(
    private readonly facts: CapabilityFacts | null,
    /**
     * Answers for specific people, by id. Keyed rather than ordered: a request reads this port
     * twice — the guard builds the actor, the use-case asks about the subject — and a fake that
     * counted calls would answer the wrong person on the second request of the same test.
     */
    private readonly byUser: Readonly<Record<string, CapabilityFacts | null>> = {},
  ) {}

  capabilitiesOf(userId: string): Promise<CapabilityFacts | null> {
    return Promise.resolve(userId in this.byUser ? (this.byUser[userId] ?? null) : this.facts);
  }
}

/** Exceptions in memory, keyed the way the unique index keys them. */
export class FakePermissionOverrideRepository implements PermissionOverrideRepositoryPort {
  readonly rows = new Map<string, OverrideRow>();

  listFor(userId: string): Promise<readonly OverrideRow[]> {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(([key]) => key.startsWith(`${userId}:`))
        .map(([, row]) => row),
    );
  }

  find(userId: string, permissionKey: string): Promise<OverrideRow | null> {
    return Promise.resolve(this.rows.get(`${userId}:${permissionKey}`) ?? null);
  }

  upsert(draft: OverrideDraftRow): Promise<void> {
    this.rows.set(`${draft.userId}:${draft.permissionKey}`, {
      permissionKey: draft.permissionKey,
      effect: draft.effect,
      reason: draft.reason,
      expiresAt: draft.expiresAt,
    });

    return Promise.resolve();
  }

  remove(userId: string, permissionKey: string): Promise<boolean> {
    return Promise.resolve(this.rows.delete(`${userId}:${permissionKey}`));
  }
}

/**
 * Custom roles in memory: one composition per id, plus who holds them.
 *
 * `holders` is settable because the two rules that matter — the self-lockout and the version bump —
 * are about the people who hold the role, and a fake that always answered «nobody» would make both
 * unreachable.
 */
export class FakeCustomRoleRepository implements CustomRoleRepositoryPort {
  readonly roles = new Map<string, RoleComposition>();
  readonly holders = new Map<string, string[]>();
  readonly versionBumps: string[] = [];
  /** Every draft the repository was asked to store — the trail a test reads instead of a database. */
  readonly updates: Omit<RoleDraft, 'key'>[] = [];
  private vanishing = false;
  private next = 1;

  constructor(
    private readonly options: {
      readonly elsewhere?: readonly string[];
      readonly duplicateKey?: boolean;
      /** The role is readable but gone by the time the update runs — the concurrent-delete window. */
      readonly vanishesBeforeUpdate?: boolean;
    } = {},
  ) {}

  list(): Promise<readonly RoleListEntry[]> {
    return Promise.resolve(
      [...this.roles.values()].map((role) => ({
        roleId: role.roleId,
        key: role.key,
        name: role.name,
        description: null,
        isSystem: role.isSystem,
        isDefault: false,
        holderCount: (this.holders.get(role.roleId) ?? []).length,
        permissions: role.permissions,
      })),
    );
  }

  composition(roleId: string): Promise<RoleComposition | null> {
    return Promise.resolve(this.roles.get(roleId) ?? null);
  }

  create(draft: RoleDraft): Promise<string> {
    if (this.options.duplicateKey === true) {
      return Promise.reject(new ConflictError('role_already_exists'));
    }

    const roleId = `role-${String(this.next++)}`;

    this.roles.set(roleId, {
      roleId,
      key: draft.key,
      name: draft.name,
      description: draft.description,
      isSystem: false,
      permissions: [...draft.permissions],
    });

    return Promise.resolve(roleId);
  }

  /** From here on the role is gone, as if somebody else deleted it mid-save. */
  vanishOnUpdate(): void {
    this.vanishing = true;
  }

  update(roleId: string, draft: Omit<RoleDraft, 'key'>): Promise<boolean> {
    if (this.vanishing || this.options.vanishesBeforeUpdate === true) return Promise.resolve(false);

    this.updates.push(draft);

    const existing = this.roles.get(roleId);

    if (existing === undefined) return Promise.resolve(false);

    this.roles.set(roleId, { ...existing, permissions: [...draft.permissions] });

    return Promise.resolve(true);
  }

  bumpHoldersOfMany(roleIds: readonly string[]): Promise<void> {
    for (const roleId of roleIds) this.versionBumps.push(...(this.holders.get(roleId) ?? []));

    return Promise.resolve();
  }

  bumpHoldersOf(roleId: string): Promise<void> {
    this.versionBumps.push(...(this.holders.get(roleId) ?? []));

    return Promise.resolve();
  }

  remove(roleId: string): Promise<void> {
    this.roles.delete(roleId);
    // The cascade, modelled: `ON DELETE CASCADE` takes the assignments with the role. Without this
    // line a use-case that invalidated the holders *after* removing the role would still look
    // correct here, and in production it would invalidate nobody.
    this.holders.delete(roleId);

    return Promise.resolve();
  }

  compositionsOf(roleIds: readonly string[]): Promise<readonly RoleComposition[]> {
    return Promise.resolve(
      roleIds
        .map((roleId) => this.roles.get(roleId))
        .filter((role): role is RoleComposition => role !== undefined),
    );
  }

  holdingsOf(userId: string): Promise<{
    readonly byRole: ReadonlyMap<string, readonly SharedPermissions.PermissionKey[]>;
    readonly fromOverrides: ReadonlySet<SharedPermissions.PermissionKey>;
  }> {
    const byRole = new Map<string, readonly SharedPermissions.PermissionKey[]>();

    for (const [roleId, holders] of this.holders) {
      if (!holders.includes(userId)) continue;

      byRole.set(roleId, this.roles.get(roleId)?.permissions ?? []);
    }

    return Promise.resolve({
      byRole,
      fromOverrides: new Set(
        (this.options.elsewhere ?? []) as readonly SharedPermissions.PermissionKey[],
      ),
    });
  }

  holderCounts(roleIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    // A role nobody holds is **absent** from the answer, exactly as `groupBy` leaves it out: a fake
    // that returned a zero would hide the fallback the real path depends on.
    return Promise.resolve(
      new Map(
        roleIds
          .filter((roleId) => (this.holders.get(roleId) ?? []).length > 0)
          .map((roleId) => [roleId, (this.holders.get(roleId) ?? []).length]),
      ),
    );
  }

  holdsRole(userId: string, roleId: string): Promise<boolean> {
    return Promise.resolve((this.holders.get(roleId) ?? []).includes(userId));
  }

  holderCount(roleId: string): Promise<number> {
    return Promise.resolve((this.holders.get(roleId) ?? []).length);
  }

  permissionsExcludingRole(): Promise<readonly SharedPermissions.PermissionKey[]> {
    return Promise.resolve(
      (this.options.elsewhere ?? []) as readonly SharedPermissions.PermissionKey[],
    );
  }
}
