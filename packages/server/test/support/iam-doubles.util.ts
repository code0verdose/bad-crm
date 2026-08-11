import { randomUUID } from 'node:crypto';

import { SharedPermissions } from '@bad-crm/shared';

import { ConflictError } from '../../src/domain/shared/errors/app.errors.js';

import {
  type AttributedCapabilityFacts,
  type CapabilityFacts,
  type EffectivePermissionsReaderPort,
  type HeldRole,
  type OverrideFacts,
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
  type EmployeeProfilePatch,
  type EmployeeProfileRepositoryPort,
  type EmployeeProfileRow,
} from '../../src/application/iam/ports/employee-profile-repository.port.js';
import {
  type OwnershipRepositoryPort,
  type OwnershipTransfer,
  type TransferCandidate,
} from '../../src/application/iam/ports/ownership-repository.port.js';
import {
  type AddMemberResult,
  type DisbandedTeam,
  type TeamDetail,
  type TeamDraft,
  type TeamListEntry,
  type TeamRepositoryPort,
  type TeamSummary,
} from '../../src/application/iam/ports/team-repository.port.js';
import {
  type TeamScope,
  type TeamSubject,
} from '../../src/domain/iam/access/team-access.policy.js';
import {
  type LeftTeamMembership,
  type UserLifecycleRepositoryPort,
  type UserLifecycleRow,
} from '../../src/application/iam/ports/user-lifecycle-repository.port.js';
import {
  type DirectoryFacets,
  type EmployeeDirectoryFilter,
  type EmployeeDirectoryPage,
  type EmployeeDirectoryRepositoryPort,
  type EmployeeDirectoryRow,
  type OrgChartNode,
} from '../../src/application/iam/ports/employee-directory-repository.port.js';
import {
  type AcceptedInvitation,
  type InvitationDraftRow,
  type InvitationRepositoryPort,
  type InvitationRow,
  type InvitedAccountDraft,
} from '../../src/application/iam/ports/invitation-repository.port.js';
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
 * The origin of one subject's permissions, as a suite seeds it.
 *
 * Only the parts the folded facts throw away — the facts themselves come from `capabilitiesByUser`,
 * so the two halves of the port cannot be seeded into disagreement.
 */
export interface FakeAttribution {
  readonly roles?: readonly HeldRole[];
  readonly grantedByRole?: Readonly<Record<string, readonly string[]>>;
  readonly overrides?: Readonly<Record<string, OverrideFacts>>;
}

export class FakeEffectivePermissionsReader implements EffectivePermissionsReaderPort {
  constructor(
    private readonly facts: CapabilityFacts | null,
    /**
     * Answers for specific people, by id. Keyed rather than ordered: a request reads this port
     * twice — the guard builds the actor, the use-case asks about the subject — and a fake that
     * counted calls would answer the wrong person on the second request of the same test.
     */
    private readonly byUser: Readonly<Record<string, CapabilityFacts | null>> = {},
    /** Where each grant came from, for the one screen that has to explain rather than decide. */
    private readonly attribution: Readonly<Record<string, FakeAttribution>> = {},
  ) {}

  capabilitiesOf(userId: string): Promise<CapabilityFacts | null> {
    return Promise.resolve(this.factsFor(userId));
  }

  /**
   * The same facts, narrated with whatever attribution the suite seeded.
   *
   * `facts` is taken from the *same* lookup `capabilitiesOf` uses rather than seeded a second time,
   * for the reason the real adapter folds once: a double whose two answers could be seeded to
   * disagree would let a suite pass while asserting a decision the guard never makes.
   *
   * A subject with no attribution seeded is answered honestly — no roles, no exceptions — so every
   * grant reports `ROLE` with an empty `roleIds`. That is what a suite that only cares about
   * allow/deny is asking for, and it is not a claim about which role granted anything.
   */
  attributedCapabilitiesOf(userId: string): Promise<AttributedCapabilityFacts | null> {
    const facts = this.factsFor(userId);

    if (facts === null) return Promise.resolve(null);

    const seeded: FakeAttribution = this.attribution[userId] ?? {};

    return Promise.resolve({
      facts,
      roles: seeded.roles ?? [],
      grantedByRole: new Map(
        Object.entries(seeded.grantedByRole ?? {}) as [
          SharedPermissions.PermissionKey,
          readonly string[],
        ][],
      ),
      overrides: new Map(
        Object.entries(seeded.overrides ?? {}) as [
          SharedPermissions.PermissionKey,
          OverrideFacts,
        ][],
      ),
    });
  }

  private factsFor(userId: string): CapabilityFacts | null {
    return userId in this.byUser ? (this.byUser[userId] ?? null) : this.facts;
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

/**
 * Invitations in memory, with the one behaviour the database owns: a second **open** invitation for
 * an address is a conflict, not a second row.
 *
 * The partial unique index is what actually enforces that (`idx_invitations_org_email … WHERE
 * accepted_at IS NULL`); this reproduces the refusal so the HTTP suite can assert the answer it
 * produces. It is **not** a check that the index exists — that is the migration's business, and no
 * test asserts the index against a live database today.
 */
export class FakeInvitationRepository implements InvitationRepositoryPort {
  readonly rows = new Map<string, InvitationRow>();
  /** Digests, kept apart from the rows exactly as the repository keeps them out of `InvitationRow`. */
  readonly digests = new Map<string, Uint8Array>();
  /** Who accepted which invitation — the pair the CHECK constraint keeps together. */
  readonly accepted = new Map<string, string>();
  /** Accounts the acceptance created, by address. */
  readonly accounts = new Map<string, InvitedAccountDraft & { userId: string }>();
  readonly memberships: { userId: string; teamIds: string[] }[] = [];

  constructor(
    private readonly options: {
      /** What the role grants, for the subset rule. `null` — the role is not in this tenant. */
      readonly rolePermissions?: readonly SharedPermissions.PermissionKey[] | null;
      /** The address already belongs to an account. */
      readonly userExists?: boolean;
    } = {},
  ) {}

  create(draft: InvitationDraftRow): Promise<string> {
    const open = [...this.rows.values()].some(
      (row) => row.email === draft.email && row.acceptedAt === null,
    );

    if (open) return Promise.reject(new ConflictError('invitation_already_exists'));

    // A UUID, because the path parameter is one: a fake that minted `invitation-1` would make every
    // request addressing a created row fail validation instead of reaching the use-case.
    const id = randomUUID();

    this.rows.set(id, {
      id,
      email: draft.email,
      roleId: draft.roleId,
      teamIds: [...draft.teamIds],
      locale: draft.locale,
      invitedById: draft.invitedById,
      expiresAt: draft.expiresAt,
      acceptedAt: null,
      createdAt: new Date('2026-08-07T10:00:00.000Z'),
    });
    this.digests.set(id, draft.tokenHash);

    return Promise.resolve(id);
  }

  byId(invitationId: string): Promise<InvitationRow | null> {
    return Promise.resolve(this.rows.get(invitationId) ?? null);
  }

  reissue(invitationId: string, tokenHash: Uint8Array, expiresAt: Date): Promise<boolean> {
    const row = this.rows.get(invitationId);

    if (row === undefined || row.acceptedAt !== null) return Promise.resolve(false);

    this.rows.set(invitationId, { ...row, expiresAt });
    this.digests.set(invitationId, tokenHash);

    return Promise.resolve(true);
  }

  remove(invitationId: string): Promise<boolean> {
    const row = this.rows.get(invitationId);

    if (row === undefined || row.acceptedAt !== null) return Promise.resolve(false);

    this.rows.delete(invitationId);
    this.digests.delete(invitationId);

    return Promise.resolve(true);
  }

  listOpen(): Promise<readonly InvitationRow[]> {
    return Promise.resolve([...this.rows.values()].filter((row) => row.acceptedAt === null));
  }

  userExists(): Promise<boolean> {
    return Promise.resolve(this.options.userExists ?? false);
  }

  rolePermissions(): Promise<readonly SharedPermissions.PermissionKey[] | null> {
    // `??` would fold «this role is not in the tenant» into the default, and the 404 case would
    // quietly exercise the happy path instead.
    return Promise.resolve(
      'rolePermissions' in this.options ? (this.options.rolePermissions ?? null) : [],
    );
  }

  accept(
    invitationId: string,
    acceptedUserId: string,
    now: Date,
  ): Promise<AcceptedInvitation | null> {
    const row = this.rows.get(invitationId);

    // The conditional write, reproduced: accepted already or expired matches nothing, and the two
    // are one outcome here exactly as they are in SQL.
    if (row === undefined || row.acceptedAt !== null || row.expiresAt <= now) {
      return Promise.resolve(null);
    }

    this.rows.set(invitationId, { ...row, acceptedAt: now });
    this.accepted.set(invitationId, acceptedUserId);

    return Promise.resolve({ email: row.email, roleId: row.roleId, teamIds: row.teamIds });
  }

  createAccount(draft: InvitedAccountDraft): Promise<string> {
    // `uq_users_org_email`, reproduced: the second request for the same address loses, which is the
    // guard that stands beside the conditional write.
    if (this.accounts.has(draft.email)) {
      return Promise.reject(new ConflictError('user_already_exists'));
    }

    const userId = randomUUID();

    this.accounts.set(draft.email, { ...draft, userId });

    return Promise.resolve(userId);
  }

  joinTeams(userId: string, teamIds: readonly string[]): Promise<readonly string[]> {
    this.memberships.push({ userId, teamIds: [...teamIds] });

    return Promise.resolve([...teamIds]);
  }

  /**
   * Marks an invitation as taken up without going through `accept` — the state resend and revoke
   * refuse. Named apart from the port method on purpose: two members called `accept` is one member,
   * and the second declaration silently wins.
   */
  markAccepted(invitationId: string, at = new Date('2026-08-08T10:00:00.000Z')): void {
    const row = this.rows.get(invitationId);

    if (row !== undefined) this.rows.set(invitationId, { ...row, acceptedAt: at });
  }
}

/**
 * Employee profiles in memory, with the one behaviour the database owns: a profile cannot exist for
 * an account that is not in this organization.
 *
 * `accounts` is what stands in for that — the suite seeds it with the people the test invented, and
 * `upsert` answers `null` for anybody else, exactly as the composite foreign key would refuse.
 */
export class FakeEmployeeProfileRepository implements EmployeeProfileRepositoryPort {
  readonly rows = new Map<string, EmployeeProfileRow>();
  /** Accounts that exist here; anybody else is «another organization», i.e. 404. */
  readonly accounts = new Set<string>();

  byUserId(userId: string): Promise<EmployeeProfileRow | null> {
    const stored = this.rows.get(userId);

    if (stored !== undefined) return Promise.resolve(stored);

    // An account with no row yet is an **empty** profile, not «not found»: 404 on this endpoint
    // means «no such person here», which is what tenancy depends on.
    return Promise.resolve(this.accounts.has(userId) ? emptyProfile(userId) : null);
  }

  upsert(userId: string, patch: EmployeeProfilePatch): Promise<EmployeeProfileRow | null> {
    if (!this.accounts.has(userId)) return Promise.resolve(null);

    const existing = this.rows.get(userId) ?? emptyProfile(userId);
    const next = { ...existing, ...definedOnly(patch) } as EmployeeProfileRow;

    this.rows.set(userId, next);

    return Promise.resolve(next);
  }

  managerLinks(): Promise<ReadonlyMap<string, string>> {
    return Promise.resolve(
      new Map(
        [...this.rows.values()].flatMap((row) =>
          row.managerId === null ? [] : [[row.userId, row.managerId] as const],
        ),
      ),
    );
  }
}

const emptyProfile = (userId: string): EmployeeProfileRow => ({
  userId,
  email: `${userId}@example.test`,
  firstName: '',
  lastName: '',
  jobTitle: null,
  department: null,
  managerId: null,
  weeklyCapacityHours: 40,
  employmentType: 'FULL_TIME',
  hiredAt: null,
  terminatedAt: null,
  timezone: 'UTC',
  skills: [],
  emergencyContactEnc: null,
});

/** Prisma reads an explicit `undefined` as «leave it alone»; the fake has to do the same. */
const definedOnly = (patch: EmployeeProfilePatch): Record<string, unknown> =>
  Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));

/**
 * The directory, in memory, filtering and ordering for real.
 *
 * Real rather than a canned answer, because what the HTTP tests are checking is the behaviour
 * **around** the rows — the default statuses, the refused order, the level of each line — and a
 * double that returned everything regardless of the filter would let all three pass while broken.
 * What it deliberately does not model is SQL: that is the job of
 * `test/unit/persistence/employee-directory-repository.test.ts` and of the isolation suite.
 */
export class FakeEmployeeDirectoryRepository implements EmployeeDirectoryRepositoryPort {
  readonly rows: EmployeeDirectoryRow[] = [];
  /** Every call, so a test can assert what the query asked for — the order above all. */
  readonly asked: EmployeeDirectoryFilter[] = [];

  list(filter: EmployeeDirectoryFilter): Promise<EmployeeDirectoryPage> {
    this.asked.push(filter);

    const matched = this.rows
      .filter((row) => filter.statuses.includes(row.status))
      .filter((row) => matchesText(row, filter.query))
      .filter(
        (row) =>
          filter.roleIds.length === 0 || row.roles.some((role) => filter.roleIds.includes(role.id)),
      )
      .filter(
        (row) =>
          filter.teamIds.length === 0 || row.teams.some((team) => filter.teamIds.includes(team.id)),
      )
      .sort(comparatorFor(filter.sort));
    const from = (filter.page - 1) * filter.perPage;

    return Promise.resolve({
      items: matched.slice(from, from + filter.perPage),
      total: matched.length,
    });
  }

  facets(): Promise<DirectoryFacets> {
    return Promise.resolve({
      roles: dedupeById(this.rows.flatMap((row) => row.roles)),
      teams: dedupeById(this.rows.flatMap((row) => row.teams)),
    });
  }

  orgChart(): Promise<readonly OrgChartNode[]> {
    return Promise.resolve(
      this.rows.map((row) => ({
        userId: row.userId,
        firstName: row.firstName,
        lastName: row.lastName,
        jobTitle: row.jobTitle,
        managerId: row.managerId,
      })),
    );
  }
}

const matchesText = (row: EmployeeDirectoryRow, query: string): boolean => {
  if (query === '') return true;

  const needle = query.toLowerCase();

  return [row.email, row.firstName, row.lastName, row.jobTitle, row.department].some(
    (field) => field !== null && field.toLowerCase().includes(needle),
  );
};

const comparatorFor =
  (sort: string) =>
  (left: EmployeeDirectoryRow, right: EmployeeDirectoryRow): number => {
    if (sort === 'hiredAt' || sort === '-hiredAt') {
      const difference = (left.hiredAt?.getTime() ?? 0) - (right.hiredAt?.getTime() ?? 0);

      return sort === 'hiredAt' ? difference : -difference;
    }

    const difference = left.lastName.localeCompare(right.lastName);

    return sort === '-name' ? -difference : difference;
  };

const dedupeById = <T extends { readonly id: string }>(values: readonly T[]): T[] => [
  ...new Map(values.map((value) => [value.id, value])).values(),
];

/** A directory row with everything filled in, so a test states only what it is about. */
export const directoryRow = (
  overrides: Partial<EmployeeDirectoryRow> & { readonly userId: string },
): EmployeeDirectoryRow => ({
  email: `${overrides.userId}@example.test`,
  firstName: 'Ivan',
  lastName: 'Petrov',
  jobTitle: 'Backend engineer',
  department: 'Platform',
  status: 'ACTIVE',
  managerId: null,
  roles: [],
  teams: [],
  employmentType: 'FULL_TIME',
  hiredAt: new Date('2024-03-01T00:00:00.000Z'),
  terminatedAt: null,
  weeklyCapacityHours: 40,
  ...overrides,
});

/**
 * The account lifecycle in memory.
 *
 * It models the two facts the use-case decides on — the status and who owns the organization — and
 * hands back what a suspension removed. What it deliberately does **not** model is the transaction,
 * so nothing here can show that the writes land together. That is split across two suites, and it is
 * worth knowing which says what before trusting either: `test/integration/db/user-lifecycle-repository.test.ts`
 * asserts on a live Postgres that the status, the termination date and `permissions_version` move in
 * one operator; the sessions belong to a different port and are asserted over the wire, in
 * `test/integration/http/user-lifecycle.test.ts` — a live refresh cookie that works before the
 * offboarding and answers 401 after it.
 */
export class FakeUserLifecycleRepository implements UserLifecycleRepositoryPort {
  readonly rows = new Map<string, UserLifecycleRow>();
  /**
   * Team memberships per account, so a suspension has something real to remove.
   *
   * The memberships themselves rather than a count: what the operation has to hand back is `teamId`
   * and `teamRole`, because the rows do not survive it and nothing else records what they were.
   */
  readonly teams = new Map<string, LeftTeamMembership[]>();
  readonly suspended: { userId: string; at: Date }[] = [];
  readonly reactivated: string[] = [];

  byId(userId: string): Promise<UserLifecycleRow | null> {
    return Promise.resolve(this.rows.get(userId) ?? null);
  }

  suspend(userId: string, at: Date): Promise<readonly LeftTeamMembership[]> {
    this.suspended.push({ userId, at });

    const row = this.rows.get(userId);

    if (row !== undefined) this.rows.set(userId, { ...row, status: 'SUSPENDED' });

    const left = this.teams.get(userId) ?? [];

    this.teams.set(userId, []);

    return Promise.resolve(left);
  }

  reactivate(userId: string): Promise<void> {
    this.reactivated.push(userId);

    const row = this.rows.get(userId);

    if (row !== undefined) this.rows.set(userId, { ...row, status: 'ACTIVE' });

    return Promise.resolve();
  }
}

/** Ownership in memory: who holds it, who could, and what a transfer was asked to do. */
export class FakeOwnershipRepository implements OwnershipRepositoryPort {
  ownerId: string | null = null;
  readonly candidates = new Map<string, TransferCandidate>();
  readonly transfers: OwnershipTransfer[] = [];

  currentOwnerId(): Promise<string | null> {
    return Promise.resolve(this.ownerId);
  }

  candidate(userId: string): Promise<TransferCandidate | null> {
    return Promise.resolve(this.candidates.get(userId) ?? null);
  }

  transfer(transfer: OwnershipTransfer): Promise<void> {
    // Mirrors the guarded `UPDATE … WHERE owner_id = fromUserId` the real repository runs: a
    // transfer built on a stale read of who currently owns the organization must fail rather than
    // silently overwrite whoever holds it now — two transfers racing off the same origin must not
    // both be able to succeed.
    if (transfer.fromUserId !== this.ownerId) {
      throw new ConflictError('stale_version', { cause: 'ownership_changed_concurrently' });
    }

    this.transfers.push(transfer);
    this.ownerId = transfer.toUserId;

    return Promise.resolve();
  }
}

/**
 * Teams in memory: the rows, the memberships, and every version bump the use-cases asked for.
 *
 * Two behaviours are modelled rather than stubbed, because a use-case reads them as decisions:
 * `addMember` reports the three-way `AddMemberResult` the port declares — `'created'` for a pair
 * that did not exist, `'role_changed'` for one that did but under a different `teamRole` (the
 * gate's L-3: promoting an existing member to `LEAD` is a second call to this same method, and a
 * boolean could not tell that apart from a genuine no-op), `'unchanged'` otherwise, with
 * `previousRole` carried for the two outcomes that have one — and `disband` removes the memberships
 * and returns who held them (`RETURNING`, which is the only record left of them once `team_members`
 * has no `deleted_at`).
 */
export class FakeTeamRepository implements TeamRepositoryPort {
  readonly teams = new Map<string, TeamDetail>();
  readonly subjects = new Map<string, TeamSubject>();
  /** Every account whose folded permission view a use-case asked to invalidate, in order. */
  readonly versionBumps: string[] = [];
  private next = 1;

  constructor(
    private readonly options: {
      readonly duplicateSlug?: boolean;
      /**
       * The team is readable but gone by the time the write runs — the concurrent-delete window.
       *
       * Modelled rather than stubbed because it is a branch of the use-cases: between the decision
       * and the statement, somebody else may disband the team, and the answer has to be the same 404
       * a team of another organization gets. Without this there is no way to reach that branch, and
       * an unreachable `throw` is one nobody has run.
       */
      readonly vanishesBeforeWrite?: boolean;
    } = {},
  ) {}

  /** Seeds a live team and returns its id — the shape most suites start from. */
  seed(team: Partial<TeamDetail> & { readonly teamId: string }): string {
    this.teams.set(team.teamId, {
      name: 'Backend',
      slug: 'backend',
      description: null,
      isDeleted: false,
      memberCount: team.members?.length ?? 0,
      members: [],
      ...team,
    });

    return team.teamId;
  }

  list(): Promise<readonly TeamListEntry[]> {
    return Promise.resolve(
      [...this.teams.values()]
        // The `WHERE deleted_at IS NULL` of the real query: a list that showed a disbanded team
        // would be wrong, and a fake that forgot the filter would let a suite pass on a use-case
        // that had dropped it.
        .filter((team) => !team.isDeleted)
        .map((team) => ({
          teamId: team.teamId,
          name: team.name,
          slug: team.slug,
          description: team.description,
          memberCount: team.members.length,
        })),
    );
  }

  scope(teamId: string): Promise<TeamScope | null> {
    const team = this.teams.get(teamId);

    return Promise.resolve(
      team === undefined ? null : { teamId: team.teamId, isDeleted: team.isDeleted },
    );
  }

  summary(teamId: string): Promise<TeamSummary | null> {
    const team = this.teams.get(teamId);

    return Promise.resolve(
      team === undefined
        ? null
        : { teamId: team.teamId, name: team.name, slug: team.slug, isDeleted: team.isDeleted },
    );
  }

  detail(teamId: string): Promise<TeamDetail | null> {
    const team = this.teams.get(teamId);

    return Promise.resolve(
      team === undefined ? null : { ...team, memberCount: team.members.length },
    );
  }

  /**
   * `uq_teams_org_slug`, reproduced: a live team already holding this slug, wherever the write came
   * from. `excludingTeamId` is what makes a rename that keeps its own slug not a conflict with
   * itself — the same distinction the partial index draws by matching `id <> excluded.id` implicitly
   * through `ON CONFLICT`.
   */
  private slugTaken(slug: string, excludingTeamId?: string): boolean {
    return [...this.teams.values()].some(
      (team) => team.slug === slug && !team.isDeleted && team.teamId !== excludingTeamId,
    );
  }

  create(draft: TeamDraft): Promise<string> {
    if (this.options.duplicateSlug === true || this.slugTaken(draft.slug)) {
      return Promise.reject(new ConflictError('team_already_exists'));
    }

    const teamId = `team-${String(this.next++)}`;

    this.teams.set(teamId, {
      teamId,
      name: draft.name,
      slug: draft.slug,
      description: draft.description,
      isDeleted: false,
      memberCount: 0,
      members: [],
    });

    return Promise.resolve(teamId);
  }

  update(teamId: string, draft: TeamDraft): Promise<boolean> {
    if (this.options.vanishesBeforeWrite === true) return Promise.resolve(false);

    const team = this.teams.get(teamId);

    if (team === undefined || team.isDeleted) return Promise.resolve(false);

    if (this.slugTaken(draft.slug, teamId)) {
      return Promise.reject(new ConflictError('team_already_exists'));
    }

    this.teams.set(teamId, { ...team, ...draft });

    return Promise.resolve(true);
  }

  disband(teamId: string): Promise<DisbandedTeam | null> {
    if (this.options.vanishesBeforeWrite === true) return Promise.resolve(null);

    const team = this.teams.get(teamId);

    if (team === undefined || team.isDeleted) return Promise.resolve(null);

    this.teams.set(teamId, { ...team, isDeleted: true, members: [], memberCount: 0 });

    return Promise.resolve({
      name: team.name,
      members: team.members.map((member) => ({
        userId: member.userId,
        teamRole: member.teamRole,
      })),
    });
  }

  subject(userId: string): Promise<TeamSubject | null> {
    return Promise.resolve(this.subjects.get(userId) ?? null);
  }

  addMember(teamId: string, userId: string, teamRole: string): Promise<AddMemberResult> {
    const team = this.teams.get(teamId);

    if (team === undefined) return Promise.resolve({ outcome: 'unchanged', previousRole: null });

    const existing = team.members.find((member) => member.userId === userId);

    // `ON CONFLICT (team_id, user_id) DO UPDATE … WHERE team_role <> EXCLUDED.team_role`: a repeat
    // with the same role is a true no-op, a repeat with a different one changes the row in place
    // (the gate's L-3), and only a pair nobody has written yet is a new membership.
    if (existing !== undefined) {
      if (existing.teamRole === teamRole) {
        return Promise.resolve({ outcome: 'unchanged', previousRole: null });
      }

      this.teams.set(teamId, {
        ...team,
        members: team.members.map((member) =>
          member.userId === userId ? { ...member, teamRole } : member,
        ),
      });

      return Promise.resolve({ outcome: 'role_changed', previousRole: existing.teamRole });
    }

    this.teams.set(teamId, {
      ...team,
      members: [...team.members, { userId, teamRole, joinedAt: new Date('2026-01-01T00:00:00Z') }],
    });

    return Promise.resolve({ outcome: 'created', previousRole: null });
  }

  removeMember(teamId: string, userId: string): Promise<boolean> {
    const team = this.teams.get(teamId);

    if (team === undefined) return Promise.resolve(false);

    const remaining = team.members.filter((member) => member.userId !== userId);

    if (remaining.length === team.members.length) return Promise.resolve(false);

    this.teams.set(teamId, { ...team, members: remaining });

    return Promise.resolve(true);
  }

  bumpPermissionsVersionOf(userIds: readonly string[]): Promise<void> {
    this.versionBumps.push(...userIds);

    return Promise.resolve();
  }
}
