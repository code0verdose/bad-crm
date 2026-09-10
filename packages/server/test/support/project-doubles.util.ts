import {
  type ProjectAclFacts,
  type ProjectAccessReaderPort,
} from '@/application/access/ports/project-access-reader.port.js';
import { type AclReaderPort } from '@/application/access/ports/acl-reader.port.js';
import {
  type ProjectDetail,
  type ProjectDraft,
  type ProjectListEntry,
  type ProjectPatch,
  type ProjectRepositoryPort,
} from '@/application/project/ports/project-repository.port.js';
import { type TenantScope } from '@/application/platform/ports/unit-of-work.port.js';
import { type AclChainNode, type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';
import { type ProjectRole, type ProjectVisibility } from '@/domain/access/implicit-level.policy.js';
import { type ProjectScope } from '@/domain/project/project.entity.js';
import { type ProjectStatus } from '@/domain/project/project.enums.js';

/** A project as the store keeps it: the detail plus the tenant it belongs to. */
export interface StoredProject extends ProjectDetail {
  readonly organizationId: string;
}

/**
 * Projects in memory, behind the three ports a read of one project goes through.
 *
 * One store rather than three doubles, because the three ports read **the same rows** on a real
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
 * silently absent.
 */
export class FakeProjectStore
  implements ProjectRepositoryPort, ProjectAccessReaderPort, AclReaderPort
{
  readonly rows: StoredProject[] = [];
  /** `projectId → userId → role`: live memberships only. */
  readonly members = new Map<string, Map<string, ProjectRole>>();
  /** What `entriesAlong` answers for everybody — a chain-shaped grant, seeded by a suite that wants one. */
  readonly entries: AclEntryOnChain[] = [];
  /** Every chain the resolver asked about, in order. */
  readonly chains: (readonly AclChainNode[])[] = [];
  /** Every call that reached a port, in order — the trace `get-project-detail.query.test.ts` also holds. */
  readonly trace: string[] = [];

  /** The unit of work whose open scope names the tenant — attached by the harness, not by a suite. */
  private scopes: { readonly current: TenantScope | undefined } | undefined;

  /** Set to make the chain read fail — the 503 branch of the resolver, reachable on purpose. */
  aclFailure: Error | undefined;

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

  addMember(projectId: string, userId: string, role: ProjectRole): void {
    const roster = this.members.get(projectId) ?? new Map<string, ProjectRole>();

    roster.set(userId, role);
    this.members.set(projectId, roster);
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

  private withCount(row: StoredProject): StoredProject {
    return { ...row, memberCount: this.members.get(row.projectId)?.size ?? 0 };
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

  detail(projectId: string): Promise<ProjectDetail | null> {
    this.trace.push('detail');

    const row = this.visible(projectId);

    return Promise.resolve(row === null ? null : this.withCount(row));
  }

  create(draft: ProjectDraft): Promise<string> {
    const tenant = this.tenant;

    if (tenant === undefined) throw new Error('a project was written outside a tenant scope');

    return Promise.resolve(
      this.seed({ ...draft, projectId: `${this.rows.length + 1}`, organizationId: tenant }),
    );
  }

  update(projectId: string, patch: ProjectPatch): Promise<boolean> {
    return this.replace(projectId, patch);
  }

  changeVisibility(projectId: string, visibility: ProjectVisibility): Promise<boolean> {
    return this.replace(projectId, { visibility });
  }

  changeStatus(projectId: string, status: ProjectStatus): Promise<boolean> {
    return this.replace(projectId, { status });
  }

  softDelete(projectId: string): Promise<boolean> {
    return this.replace(projectId, { isDeleted: true });
  }

  private replace(projectId: string, patch: Partial<StoredProject>): Promise<boolean> {
    const index = this.rows.findIndex(
      (row) => row.projectId === projectId && row.organizationId === this.tenant && !row.isDeleted,
    );

    if (index === -1) return Promise.resolve(false);

    this.rows[index] = { ...(this.rows[index] as StoredProject), ...patch };

    return Promise.resolve(true);
  }

  /** The access reader: the same tenant rule, a deleted row is no row, membership from the roster. */
  aclFacts(projectId: string, userId: string): Promise<ProjectAclFacts | null> {
    this.trace.push('aclFacts');

    const row = this.visible(projectId);

    if (row === null || row.isDeleted) return Promise.resolve(null);

    return Promise.resolve({
      organizationId: row.organizationId,
      visibility: row.visibility,
      memberRole: this.members.get(projectId)?.get(userId) ?? null,
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
