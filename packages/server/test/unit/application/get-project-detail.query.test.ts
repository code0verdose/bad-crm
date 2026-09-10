import { describe, expect, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import {
  type ProjectDetail,
  type ProjectDraft,
  type ProjectListEntry,
  type ProjectPatch,
  type ProjectRepositoryPort,
} from '@/application/project/ports/project-repository.port.js';
import { GetProjectDetailQuery } from '@/application/project/use-cases/get-project-detail.query.js';
import {
  type TenantScope,
  type UnitOfWorkPort,
} from '@/application/platform/ports/unit-of-work.port.js';
import { type AclResourceRef } from '@/domain/access/acl-chain.types.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type AclScope } from '@/domain/access/authorize.util.js';
import { type ProjectScope, type ProjectSummary } from '@/domain/project/project.entity.js';
import { type ProjectStatus, type ProjectVisibility } from '@/domain/project/project.enums.js';

/**
 * One project, read — and the order the reads happen in (STORY-011-07, acceptance 4, the resource
 * half; `docs/security/permission-model.md` §7 (в), «сначала `taskScope`, потом `findById`»).
 *
 * The property this file holds and a table test of the policy cannot: **the entity is not read
 * until the policy has decided.** A refused caller — no key, a foreign id, a private project they
 * are not on — never causes `detail()` to be sent, so «you may not» and «that is not there» cost
 * the same and confirm nothing. The trace of port calls is the observable here, not a mock's
 * bookkeeping: the order of statements is what the criterion is about.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const OTHER_ORG = '018f4a3b-0000-7000-8000-0000000000a2';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const PROJECT = '018f4a3b-0000-7000-8000-0000000000d1';
const UNKNOWN = '018f4a3b-0000-7000-8000-0000000000d9';

const actorWith = (
  granted: readonly SharedPermissions.PermissionKey[] = ['project:read'],
  overrides: Partial<Actor> = {},
): Actor => ({
  userId: IVAN,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(granted),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: ['developer'],
  ...overrides,
});

interface StoredProject extends ProjectDetail {
  readonly organizationId: string;
}

const project = (overrides: Partial<StoredProject> = {}): StoredProject => ({
  organizationId: ORG,
  projectId: PROJECT,
  key: 'BAD',
  name: 'Bad CRM',
  description: null,
  status: 'ACTIVE',
  visibility: 'PUBLIC_ORG',
  leadId: IVAN,
  color: 'indigo',
  memberCount: 1,
  startedAt: null,
  dueAt: null,
  taskCounter: 0,
  createdAt: new Date('2026-09-06T12:00:00Z'),
  isDeleted: false,
  ...overrides,
});

/**
 * Projects in memory, answering as the tenant's policy would: a row of another organization is no
 * row at all. `scope()` and `detail()` both read by id and neither filters a deleted row — exactly
 * the split `PrismaProjectRepository` makes, so a deleted project reaches the policy flagged.
 */
class InMemoryProjectRepository implements ProjectRepositoryPort {
  readonly trace: string[] = [];

  constructor(
    private readonly tenant: string,
    private readonly rows: StoredProject[],
  ) {}

  private visible(projectId: string): StoredProject | null {
    return (
      this.rows.find((row) => row.projectId === projectId && row.organizationId === this.tenant) ??
      null
    );
  }

  list(): Promise<readonly ProjectListEntry[]> {
    this.trace.push('list');

    return Promise.resolve(
      this.rows.filter((row) => row.organizationId === this.tenant && !row.isDeleted),
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

    return Promise.resolve(this.visible(projectId));
  }

  detail(projectId: string): Promise<ProjectDetail | null> {
    this.trace.push('detail');

    return Promise.resolve(this.visible(projectId));
  }

  create(draft: ProjectDraft): Promise<string> {
    this.rows.push(
      project({ ...draft, projectId: `${this.rows.length + 1}`, organizationId: this.tenant }),
    );

    return Promise.resolve(this.rows.at(-1)?.projectId ?? '');
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
}

/** A resolver answering one scope, and recording that it was asked — on the same trace as the repository. */
class TracingAclResolver implements AclScopeResolver {
  readonly asked: AclResourceRef[] = [];

  constructor(
    private readonly trace: string[],
    private readonly scope: AclScope,
  ) {}

  resolve(_actor: Actor, ref: AclResourceRef): Promise<AclScope> {
    this.trace.push('acl.resolve');
    this.asked.push(ref);

    return Promise.resolve(this.scope);
  }
}

const resolved = (level: SharedPermissions.AccessLevel, organizationId = ORG): AclScope => ({
  status: 'resolved',
  organizationId,
  level,
  family: 'standard',
});

const harness = (options: { rows?: StoredProject[]; acl?: AclScope; tenant?: string } = {}) => {
  const scopes: TenantScope[] = [];
  const unitOfWork: UnitOfWorkPort = {
    withTenant: async <T>(scope: TenantScope, work: () => Promise<T>): Promise<T> => {
      scopes.push(scope);

      return await work();
    },
  };
  const projects = new InMemoryProjectRepository(
    options.tenant ?? ORG,
    options.rows ?? [project()],
  );
  const acl = new TracingAclResolver(projects.trace, options.acl ?? resolved('VIEWER'));

  return {
    scopes,
    projects,
    acl,
    query: new GetProjectDetailQuery(unitOfWork, projects, acl),
  };
};

describe('GetProjectDetailQuery', () => {
  it('CONTROL: a member of the organization reads their own PUBLIC_ORG project', async () => {
    const { query, scopes } = harness();

    await expect(query.execute({ actor: actorWith(), projectId: PROJECT })).resolves.toMatchObject({
      projectId: PROJECT,
      key: 'BAD',
      name: 'Bad CRM',
    });
    expect(scopes).toEqual([{ organizationId: ORG, userId: IVAN }]);
  });

  it('reads the scope and the chain, decides, and only then reads the entity', async () => {
    const { query, projects, acl } = harness();

    await query.execute({ actor: actorWith(), projectId: PROJECT });

    expect(projects.trace).toEqual(['scope', 'acl.resolve', 'detail']);
    expect(acl.asked).toEqual([{ type: 'PROJECT', id: PROJECT }]);
  });

  it('refuses a caller without project:read before any port is asked', async () => {
    const { query, projects } = harness();

    await expect(query.execute({ actor: actorWith([]), projectId: PROJECT })).rejects.toMatchObject(
      {
        code: 'project_forbidden',
        reason: 'permission_not_granted',
        permissionKey: 'project:read',
      },
    );
    expect(projects.trace).toEqual([]);
  });

  describe('the closed contour — three refusals that must be one answer', () => {
    it.each<[string, () => ReturnType<typeof harness>, string]>([
      ['a project that does not exist', () => harness({ acl: { status: 'missing' } }), UNKNOWN],
      [
        'a project of another organization',
        () =>
          harness({
            rows: [project({ organizationId: OTHER_ORG })],
            acl: { status: 'missing' },
          }),
        PROJECT,
      ],
      [
        'a PRIVATE project the caller is not on',
        () => harness({ rows: [project({ visibility: 'PRIVATE' })], acl: resolved('NONE') }),
        PROJECT,
      ],
      [
        'a deleted project',
        () => harness({ rows: [project({ isDeleted: true })], acl: { status: 'missing' } }),
        PROJECT,
      ],
    ])('%s → project_not_found, and the entity is never read', async (_case, build, projectId) => {
      const { query, projects } = build();

      await expect(query.execute({ actor: actorWith(), projectId })).rejects.toMatchObject({
        code: 'project_not_found',
        reason: 'resource_not_found',
      });
      expect(projects.trace).not.toContain('detail');
    });
  });

  it('answers a resolver that failed with 503, not with the row', async () => {
    const { query, projects } = harness({ acl: { status: 'unavailable' } });

    await expect(query.execute({ actor: actorWith(), projectId: PROJECT })).rejects.toMatchObject({
      code: 'service_unavailable',
      reason: 'acl_resolution_failed',
    });
    expect(projects.trace).not.toContain('detail');
  });

  it('lets the owner through NONE on the root project', async () => {
    const { query } = harness({ acl: resolved('NONE') });

    await expect(
      query.execute({ actor: actorWith([], { isOwner: true }), projectId: PROJECT }),
    ).resolves.toMatchObject({ projectId: PROJECT });
  });

  /**
   * The row the policy decided on is read under `FOR SHARE`, so it cannot vanish between the
   * decision and `detail()` on a real database. The in-memory double has no lock, which makes the
   * gap reachable here — and what the gap must answer is the same 404, never a 500 from a `null`.
   */
  it('answers a row that vanished between the decision and the read as project_not_found', async () => {
    const { query, projects } = harness();
    const original = projects.detail.bind(projects);

    projects.detail = async (projectId: string): Promise<ProjectDetail | null> => {
      await original(projectId);

      return null;
    };

    await expect(query.execute({ actor: actorWith(), projectId: PROJECT })).rejects.toMatchObject({
      code: 'project_not_found',
    });
  });
});
