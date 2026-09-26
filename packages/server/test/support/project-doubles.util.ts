import {
  type ProjectAclFacts,
  type ProjectAccessReaderPort,
} from '@/application/access/ports/project-access-reader.port.js';
import { type AclReaderPort } from '@/application/access/ports/acl-reader.port.js';
import {
  type AclEntryDraft,
  type AclEntryRow,
  type AclListEntry,
  type AclRepositoryPort,
} from '@/application/access/ports/acl-repository.port.js';
import {
  type ProjectMemberEntry,
  type ProjectMemberPatch,
  type ProjectMemberRepositoryPort,
} from '@/application/project/ports/project-member-repository.port.js';
import {
  type ProjectDetail,
  type ProjectDraft,
  type ProjectListEntry,
  type ProjectPatch,
  type ProjectRepositoryPort,
} from '@/application/project/ports/project-repository.port.js';
import { type TenantScope } from '@/application/platform/ports/unit-of-work.port.js';
import {
  type AclChainNode,
  type AclEntryOnChain,
  type AclResourceRef,
  type AclSubjectRef,
} from '@/domain/access/acl-chain.types.js';
import { type ProjectRole, type ProjectVisibility } from '@/domain/access/implicit-level.policy.js';
import {
  type ProjectMembership,
  type ProjectScope,
  type ProjectSubject,
  type ProjectSummary,
} from '@/domain/project/project.entity.js';
import { type ProjectStatus } from '@/domain/project/project.enums.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';

/** A project as the store keeps it: the detail plus the tenant it belongs to. */
export interface StoredProject extends ProjectDetail {
  readonly organizationId: string;
}

/** One `resource_acl` row as the store keeps it: the grant, its tenant, and when it was given. */
interface StoredGrant extends AclListEntry {
  readonly organizationId: string;
}

/** When every grant the store writes was given — the double keeps no clock of its own. */
export const GRANTED_AT = new Date('2026-09-06T12:00:00.000Z');

const refKey = (ref: AclResourceRef | AclSubjectRef): string => `${ref.type}:${ref.id}`;

/** One membership row as the store keeps it — live while `leftAt` is `null`. */
interface StoredMembership {
  readonly projectId: string;
  readonly userId: string;
  projectRole: ProjectRole;
  allocationPct: number;
  readonly joinedAt: Date;
  leftAt: Date | null;
}

/**
 * Projects in memory, behind the four ports a read or a write of one project goes through.
 *
 * One store rather than four doubles, because the four ports read **the same rows** on a real
 * database — `projects` under the tenant's policy, `project_members` beside it, `resource_acl`
 * along the chain — and a suite that seeded them separately could describe a project the access
 * reader has and the repository has not. That is precisely the disagreement the closed contour
 * must never show a caller, so the double cannot be allowed to produce it either.
 *
 * **The tenant is read from the unit of work, not from a constructor argument.** Every real
 * adapter here runs inside the scope `withTenant` opened and sees other organizations' rows as no
 * rows at all; this store does the same by asking the fake unit of work whose scope is open. A
 * project seeded under another organization is therefore reachable by nobody in the suite — the
 * fixture for «a foreign id is 404», which the team double cannot express because it has no
 * tenant.
 *
 * Reads by id do not filter deleted rows and the list does — the same split
 * `PrismaProjectRepository` makes, so that a deleted project reaches the policy flagged rather than
 * silently absent. A membership ends by `leftAt`, never by removal, as the real table has it.
 */
export class FakeProjectStore
  implements
    ProjectRepositoryPort,
    ProjectMemberRepositoryPort,
    ProjectAccessReaderPort,
    AclReaderPort,
    AclRepositoryPort
{
  readonly rows: StoredProject[] = [];
  /** Every membership the store ever wrote, live and ended alike. */
  readonly memberships: StoredMembership[] = [];
  /** The accounts a membership may be written for, by id — seeded like `FakeTeamRepository.subjects`. */
  readonly subjects = new Map<string, ProjectSubject>();
  /** Every account whose folded permission view a use-case asked to invalidate, in order. */
  readonly versionBumps: string[] = [];
  /** What `entriesAlong` answers for everybody — a chain-shaped grant, seeded by a suite that wants one. */
  readonly entries: AclEntryOnChain[] = [];
  /**
   * The rows of `resource_acl` the `/acl` commands write and list — kept apart from `entries`,
   * which is what the *resolver* answers, so a suite decides the caller's own level on an object
   * independently of the grants it manages there.
   */
  readonly grants: StoredGrant[] = [];
  /**
   * The subjects a grant may name besides the accounts in `subjects`: `ROLE:<id>` and `TEAM:<id>`,
   * each with the accounts it stands for — the rows `user_roles` and `team_members` would hold.
   */
  readonly aclSubjects = new Map<string, readonly string[]>();
  /** Every chain the resolver asked about, in order. */
  readonly chains: (readonly AclChainNode[])[] = [];
  /** Every call that reached a port, in order — the trace `get-project-detail.query.test.ts` also holds. */
  readonly trace: string[] = [];

  /** The unit of work whose open scope names the tenant — attached by the harness, not by a suite. */
  private scopes: { readonly current: TenantScope | undefined } | undefined;

  /** Set to make the chain read fail — the 503 branch of the resolver, reachable on purpose. */
  aclFailure: Error | undefined;

  /**
   * The row is readable under the lock and gone by the time the write runs — the concurrent-delete
   * window a real lock closes and this double cannot. Modelled so the branch that answers it (the
   * same 404 a foreign id gets) is one a test has run.
   */
  vanishesBeforeWrite = false;

  /** Every insert of a membership answers `false` — the `ON CONFLICT … DO NOTHING` outcome. */
  refusesInsert = false;

  private next = 1;

  /**
   * A suite builds the store before the harness exists and seeds it, so the tenant source cannot be
   * a constructor argument; the harness binds its own unit of work here, once.
   */
  bindTo(scopes: { readonly current: TenantScope | undefined }): this {
    this.scopes = scopes;

    return this;
  }

  seed(
    project: Partial<StoredProject> & {
      readonly projectId: string;
      readonly organizationId: string;
    },
  ): string {
    this.rows.push({
      key: 'BAD',
      name: 'Bad CRM',
      description: null,
      status: 'ACTIVE',
      visibility: 'PUBLIC_ORG',
      leadId: project.organizationId,
      color: 'indigo',
      memberCount: 0,
      startedAt: null,
      dueAt: null,
      taskCounter: 0,
      createdAt: new Date('2026-09-06T12:00:00.000Z'),
      isDeleted: false,
      ...project,
    });

    return project.projectId;
  }

  /** Seeds a live membership directly, the way a suite sets up a roster it is not testing. */
  addMember(projectId: string, userId: string, role: ProjectRole, allocationPct = 100): void {
    this.memberships.push({
      projectId,
      userId,
      projectRole: role,
      allocationPct,
      joinedAt: new Date('2026-09-06T12:00:00.000Z'),
      leftAt: null,
    });
  }

  private get tenant(): string | undefined {
    if (this.scopes === undefined) throw new Error('FakeProjectStore is bound to no unit of work');

    return this.scopes.current?.organizationId;
  }

  private visible(projectId: string): StoredProject | null {
    const tenant = this.tenant;

    if (tenant === undefined) throw new Error('a project was read outside a tenant scope');

    return (
      this.rows.find((row) => row.projectId === projectId && row.organizationId === tenant) ?? null
    );
  }

  private live(projectId: string): StoredMembership[] {
    return this.memberships.filter((row) => row.projectId === projectId && row.leftAt === null);
  }

  private liveOf(projectId: string, userId: string): StoredMembership | undefined {
    return this.live(projectId).find((row) => row.userId === userId);
  }

  private withCount(row: StoredProject): StoredProject {
    return { ...row, memberCount: this.live(row.projectId).length };
  }

  list(): Promise<readonly ProjectListEntry[]> {
    this.trace.push('list');

    return Promise.resolve(
      this.rows
        .filter((row) => row.organizationId === this.tenant && !row.isDeleted)
        .map((row) => this.withCount(row)),
    );
  }

  scope(projectId: string): Promise<ProjectScope | null> {
    this.trace.push('scope');

    const row = this.visible(projectId);

    return Promise.resolve(
      row === null
        ? null
        : { projectId: row.projectId, isDeleted: row.isDeleted, visibility: row.visibility },
    );
  }

  lockForWrite(projectId: string): Promise<ProjectSummary | null> {
    this.trace.push('lockForWrite');

    const row = this.visible(projectId);

    return Promise.resolve(
      row === null
        ? null
        : {
            projectId: row.projectId,
            isDeleted: row.isDeleted,
            visibility: row.visibility,
            key: row.key,
            name: row.name,
            description: row.description,
            status: row.status,
            leadId: row.leadId,
            startedAt: row.startedAt,
            dueAt: row.dueAt,
            color: row.color,
          },
    );
  }

  detail(projectId: string): Promise<ProjectDetail | null> {
    this.trace.push('detail');

    const row = this.visible(projectId);

    return Promise.resolve(row === null ? null : this.withCount(row));
  }

  create(draft: ProjectDraft): Promise<string> {
    this.trace.push('create');

    const tenant = this.tenant;

    if (tenant === undefined) throw new Error('a project was written outside a tenant scope');

    // `uq_projects_org_key … WHERE deleted_at IS NULL`, reproduced: live rows of this tenant only.
    const taken = this.rows.some(
      (row) => row.organizationId === tenant && row.key === draft.key && !row.isDeleted,
    );

    if (taken) return Promise.reject(new ConflictError('project_already_exists'));

    return Promise.resolve(
      this.seed({
        ...draft,
        projectId: `018f4a3b-2c1d-7a41-9f00-2b7c1d0e5c${String(this.next++).padStart(2, '0')}`,
        organizationId: tenant,
      }),
    );
  }

  changeVisibility(projectId: string, visibility: ProjectVisibility): Promise<boolean> {
    this.trace.push('changeVisibility');

    return this.replace(projectId, { visibility });
  }

  changeStatus(projectId: string, status: ProjectStatus): Promise<boolean> {
    this.trace.push('changeStatus');

    return this.replace(projectId, { status });
  }

  softDelete(projectId: string): Promise<boolean> {
    this.trace.push('softDelete');

    return this.replace(projectId, { isDeleted: true });
  }

  private replace(projectId: string, patch: Partial<StoredProject>): Promise<boolean> {
    if (this.vanishesBeforeWrite) return Promise.resolve(false);

    const index = this.rows.findIndex(
      (row) => row.projectId === projectId && row.organizationId === this.tenant && !row.isDeleted,
    );

    if (index === -1) return Promise.resolve(false);

    this.rows[index] = { ...(this.rows[index] as StoredProject), ...patch };

    return Promise.resolve(true);
  }

  roster(
    projectId: string,
    options: { readonly includeLeft?: boolean } = {},
  ): Promise<readonly ProjectMemberEntry[]> {
    this.trace.push('roster');

    const rows =
      options.includeLeft === true
        ? this.memberships.filter((row) => row.projectId === projectId)
        : this.live(projectId);

    return Promise.resolve(
      rows.map((row) => ({
        userId: row.userId,
        projectRole: row.projectRole,
        allocationPct: row.allocationPct,
        joinedAt: row.joinedAt,
        leftAt: row.leftAt,
      })),
    );
  }

  membershipOf(projectId: string, userId: string): Promise<ProjectMembership | null> {
    this.trace.push('membershipOf');

    const row = this.liveOf(projectId, userId);

    return Promise.resolve(
      row === undefined ? null : { projectRole: row.projectRole, allocationPct: row.allocationPct },
    );
  }

  leads(projectId: string): Promise<readonly string[]> {
    this.trace.push('leads');

    return Promise.resolve(
      this.live(projectId)
        .filter((row) => row.projectRole === 'LEAD')
        .map((row) => row.userId),
    );
  }

  subject(userId: string): Promise<ProjectSubject | null> {
    this.trace.push('subject');

    return Promise.resolve(this.subjects.get(userId) ?? null);
  }

  add(
    projectId: string,
    userId: string,
    projectRole: ProjectRole,
    allocationPct: number,
  ): Promise<boolean> {
    this.trace.push('add');

    if (this.refusesInsert || this.liveOf(projectId, userId) !== undefined) {
      return Promise.resolve(false);
    }

    this.addMember(projectId, userId, projectRole, allocationPct);

    return Promise.resolve(true);
  }

  update(projectId: string, userId: string, patch: ProjectMemberPatch): Promise<boolean>;
  update(projectId: string, patch: ProjectPatch): Promise<boolean>;
  update(
    projectId: string,
    userIdOrPatch: string | ProjectPatch,
    patch?: ProjectMemberPatch,
  ): Promise<boolean> {
    if (typeof userIdOrPatch !== 'string') return this.updateProject(projectId, userIdOrPatch);

    this.trace.push('member.update');

    const row = this.liveOf(projectId, userIdOrPatch);

    if (row === undefined || this.vanishesBeforeWrite) return Promise.resolve(false);

    if (patch?.projectRole !== undefined) row.projectRole = patch.projectRole;
    if (patch?.allocationPct !== undefined) row.allocationPct = patch.allocationPct;

    return Promise.resolve(true);
  }

  private updateProject(projectId: string, patch: ProjectPatch): Promise<boolean> {
    this.trace.push('update');

    return this.replace(projectId, patch);
  }

  leave(projectId: string, userId: string): Promise<boolean> {
    this.trace.push('leave');

    const row = this.liveOf(projectId, userId);

    if (row === undefined || this.vanishesBeforeWrite) return Promise.resolve(false);

    row.leftAt = new Date('2026-09-10T12:00:00.000Z');

    return Promise.resolve(true);
  }

  bumpPermissionsVersionOf(userIds: readonly string[]): Promise<void> {
    this.versionBumps.push(...userIds);

    return Promise.resolve();
  }

  /** Seeds a grant directly under a tenant, the way a suite sets up a row it is not testing the writing of. */
  seedGrant(grant: Omit<StoredGrant, 'id' | 'grantedAt'> & { readonly id?: string }): string {
    const id = grant.id ?? this.nextGrantId();

    this.grants.push({ ...grant, id, grantedAt: GRANTED_AT });

    return id;
  }

  private nextGrantId(): string {
    return `018f4a3b-2c1d-7a41-9f00-2b7c1d0e5d${String(this.next++).padStart(2, '0')}`;
  }

  private tenantGrants(): StoredGrant[] {
    const tenant = this.tenant;

    if (tenant === undefined) throw new Error('a grant was read outside a tenant scope');

    return this.grants.filter((grant) => grant.organizationId === tenant);
  }

  private row(grant: StoredGrant): AclEntryRow {
    return {
      id: grant.id,
      resource: grant.resource,
      subject: grant.subject,
      level: grant.level,
      expiresAt: grant.expiresAt,
      grantedById: grant.grantedById,
    };
  }

  private grantOf(resource: AclResourceRef, subject: AclSubjectRef): StoredGrant | undefined {
    return this.tenantGrants().find(
      (grant) =>
        refKey(grant.resource) === refKey(resource) && refKey(grant.subject) === refKey(subject),
    );
  }

  find(resource: AclResourceRef, subject: AclSubjectRef): Promise<AclEntryRow | null> {
    this.trace.push('acl.find');

    const grant = this.grantOf(resource, subject);

    return Promise.resolve(grant === undefined ? null : this.row(grant));
  }

  findById(id: string): Promise<AclEntryRow | null> {
    this.trace.push('acl.findById');

    const grant = this.tenantGrants().find((candidate) => candidate.id === id);

    return Promise.resolve(grant === undefined ? null : this.row(grant));
  }

  listOn(resource: AclResourceRef, now: Date): Promise<readonly AclListEntry[]> {
    this.trace.push('acl.listOn');

    return Promise.resolve(
      this.tenantGrants()
        .filter(
          (grant) =>
            refKey(grant.resource) === refKey(resource) &&
            (grant.expiresAt === null || grant.expiresAt.getTime() > now.getTime()),
        )
        .map((grant) => ({ ...this.row(grant), grantedAt: grant.grantedAt })),
    );
  }

  upsert(draft: AclEntryDraft): Promise<string> {
    this.trace.push('acl.upsert');

    const tenant = this.tenant;

    if (tenant === undefined) throw new Error('a grant was written outside a tenant scope');

    const existing = this.grantOf(draft.resource, draft.subject);
    const id = existing?.id ?? this.nextGrantId();
    const grant: StoredGrant = {
      id,
      organizationId: tenant,
      resource: draft.resource,
      subject: draft.subject,
      level: draft.level,
      expiresAt: draft.expiresAt,
      grantedById: draft.grantedById,
      grantedAt: GRANTED_AT,
    };

    if (existing === undefined) this.grants.push(grant);
    else this.grants[this.grants.indexOf(existing)] = grant;

    return Promise.resolve(id);
  }

  removeById(id: string): Promise<AclEntryRow | null> {
    this.trace.push('acl.removeById');

    const existing = this.tenantGrants().find((candidate) => candidate.id === id);

    if (existing === undefined) return Promise.resolve(null);

    this.grants.splice(this.grants.indexOf(existing), 1);

    return Promise.resolve(this.row(existing));
  }

  removeAllOfSubject(subject: AclSubjectRef): Promise<readonly AclEntryRow[]> {
    this.trace.push('acl.removeAllOfSubject');

    const removed = this.tenantGrants().filter(
      (grant) => refKey(grant.subject) === refKey(subject),
    );

    for (const grant of removed) this.grants.splice(this.grants.indexOf(grant), 1);

    return Promise.resolve(removed.map((grant) => this.row(grant)));
  }

  subjectExists(subject: AclSubjectRef): Promise<boolean> {
    this.trace.push('acl.subjectExists');

    return Promise.resolve(
      subject.type === 'USER'
        ? this.subjects.has(subject.id)
        : this.aclSubjects.has(refKey(subject)),
    );
  }

  subjectUserIds(subject: AclSubjectRef): Promise<readonly string[]> {
    if (subject.type === 'USER') {
      return Promise.resolve(this.subjects.has(subject.id) ? [subject.id] : []);
    }

    return Promise.resolve(this.aclSubjects.get(refKey(subject)) ?? []);
  }

  /** The access reader: the same tenant rule, a deleted row is no row, membership from the roster. */
  aclFacts(projectId: string, userId: string): Promise<ProjectAclFacts | null> {
    this.trace.push('aclFacts');

    const row = this.visible(projectId);

    if (row === null || row.isDeleted) return Promise.resolve(null);

    return Promise.resolve({
      organizationId: row.organizationId,
      visibility: row.visibility,
      memberRole: this.liveOf(projectId, userId)?.projectRole ?? null,
    });
  }

  /** The chain read; `aclFailure` makes it fail the way an unreachable database does. */
  entriesAlong(chain: readonly AclChainNode[]): Promise<readonly AclEntryOnChain[]> {
    this.trace.push('entriesAlong');
    this.chains.push(chain);

    return this.aclFailure === undefined
      ? Promise.resolve([...this.entries])
      : Promise.reject(this.aclFailure);
  }
}
