import { describe, expect, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { type AclReaderPort } from '@/application/access/ports/acl-reader.port.js';
import {
  type ProjectListFacets,
  type ProjectListFilter,
  type ProjectListPage,
  type ProjectListQueryPort,
  type ProjectListViewer,
} from '@/application/project/ports/project-list-query.port.js';
import {
  DEFAULT_PROJECT_LIST_STATUSES,
  ListProjectsQuery,
  type ListProjectsInput,
} from '@/application/project/use-cases/list-projects.query.js';
import {
  type TenantScope,
  type UnitOfWorkPort,
} from '@/application/platform/ports/unit-of-work.port.js';
import { type AclChainNode, type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { visibleProjectsPlan } from '@/domain/project/access/visible-projects.policy.js';

/**
 * The list of projects, orchestrated — STORY-014-04 acceptance 5 and 8, the part that is neither
 * the rule (`visible-projects-policy.test.ts`) nor the SQL (`test/integration/db/project-list.test.ts`).
 *
 * What only this level can hold:
 *
 * - **the order**: the capability is decided before any port is asked, the organization node is
 *   read next, and the page and the facets only after — a caller without `project:read` costs no
 *   statement about access at all;
 * - **what reaches the adapter**: the plan the policy computed from *this* caller's organization
 *   node, the caller's own id for «my projects», and the default statuses when none were asked for;
 * - **the failure mode**: an organization node that cannot be read is a 503 `acl_resolution_failed`,
 *   never an empty list and never «everything».
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const PETR = '018f4a3b-0000-7000-8000-0000000000c2';
const PROJECT = '018f4a3b-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-09-26T12:00:00.000Z');

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: IVAN,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['project:read']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: ['developer'],
  ...overrides,
});

const FILTER: ListProjectsInput['filter'] = {
  query: '',
  statuses: [],
  leadId: null,
  memberOnly: false,
  sort: 'name',
  page: 1,
  perPage: 25,
};

class RecordingAclReader implements AclReaderPort {
  readonly chains: (readonly AclChainNode[])[] = [];

  constructor(
    private readonly trace: string[],
    private readonly answer: readonly AclEntryOnChain[] | Error = [],
  ) {}

  entriesAlong(
    chain: readonly AclChainNode[],
    userId: string,
  ): Promise<readonly AclEntryOnChain[]> {
    this.trace.push(`entriesAlong:${userId}`);
    this.chains.push(chain);

    return this.answer instanceof Error
      ? Promise.reject(this.answer)
      : Promise.resolve(this.answer);
  }
}

class RecordingProjectList implements ProjectListQueryPort {
  readonly pages: { viewer: ProjectListViewer; filter: ProjectListFilter }[] = [];
  readonly facetViewers: ProjectListViewer[] = [];

  constructor(private readonly trace: string[]) {}

  page(viewer: ProjectListViewer, filter: ProjectListFilter): Promise<ProjectListPage> {
    this.trace.push('page');
    this.pages.push({ viewer, filter });

    return Promise.resolve({
      items: [
        {
          projectId: PROJECT,
          key: 'BAD',
          name: 'Bad CRM',
          status: 'ACTIVE',
          visibility: 'PUBLIC_ORG',
          leadId: IVAN,
          color: 'indigo',
          memberCount: 2,
        },
      ],
      total: 41,
    });
  }

  facets(viewer: ProjectListViewer): Promise<ProjectListFacets> {
    this.trace.push('facets');
    this.facetViewers.push(viewer);

    return Promise.resolve({ statuses: ['ACTIVE'], leadIds: [IVAN] });
  }
}

const harness = (answer: readonly AclEntryOnChain[] | Error = []) => {
  const trace: string[] = [];
  const warnings: { fields: Record<string, unknown>; message: string }[] = [];
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (fields: Record<string, unknown>, message: string) => {
      warnings.push({ fields, message });
    },
    error: () => undefined,
    child: () => logger,
  };
  const scopes: TenantScope[] = [];
  const unitOfWork: UnitOfWorkPort = {
    withTenant: async <T>(scope: TenantScope, work: () => Promise<T>): Promise<T> => {
      scopes.push(scope);
      trace.push('withTenant');

      return work();
    },
  };
  const acl = new RecordingAclReader(trace, answer);
  const list = new RecordingProjectList(trace);

  return {
    trace,
    scopes,
    acl,
    list,
    warnings,
    query: new ListProjectsQuery(unitOfWork, acl, list, { now: () => NOW }, logger),
  };
};

describe('ListProjectsQuery', () => {
  it('reads the organization node once, then the page and the facets under one tenant scope', async () => {
    const { query, trace, scopes, acl } = harness();

    const result = await query.execute({ actor: actorWith(), filter: FILTER });

    expect(scopes).toEqual([{ organizationId: ORG, userId: IVAN }]);
    expect(trace).toEqual(['withTenant', `entriesAlong:${IVAN}`, 'page', 'facets']);
    // The organization node alone — the project node differs per row and is the SQL's to read.
    expect(acl.chains).toEqual([[{ depth: 0, type: 'ORGANIZATION', id: ORG }]]);
    expect(result).toEqual({
      items: [expect.objectContaining({ projectId: PROJECT })],
      total: 41,
      page: 1,
      perPage: 25,
      sort: 'name',
      facets: { statuses: ['ACTIVE'], leadIds: [IVAN] },
    });
  });

  it('hands the adapter the plan of this caller’s organization node, not a default one', async () => {
    const grants: AclEntryOnChain[] = [{ depth: 0, level: 'NONE', expiresAt: null }];
    const { query, list } = harness(grants);
    const actor = actorWith();

    await query.execute({ actor, filter: FILTER });

    const expected = { userId: IVAN, plan: visibleProjectsPlan(actor, grants, NOW) };

    // NONE on the organization closes every project without a grant of its own — the plan says so.
    expect(expected.plan.implicitlyVisible).toEqual([]);
    expect(list.pages[0]?.viewer).toEqual(expected);
    expect(list.facetViewers).toEqual([expected]);
  });

  it('answers «my projects» with the caller’s own id, resolved from the session', async () => {
    const { query, list } = harness();

    await query.execute({
      actor: actorWith({ userId: PETR }),
      filter: { ...FILTER, memberOnly: true },
    });

    expect(list.pages[0]?.viewer.userId).toBe(PETR);
    expect(list.pages[0]?.filter.memberOnly).toBe(true);
  });

  it('shows everything but the archive when no status is asked for', async () => {
    const { query, list } = harness();

    await query.execute({ actor: actorWith(), filter: FILTER });

    expect(DEFAULT_PROJECT_LIST_STATUSES).toEqual(['ACTIVE', 'ON_HOLD', 'CLOSED']);
    expect(list.pages[0]?.filter.statuses).toEqual(DEFAULT_PROJECT_LIST_STATUSES);
  });

  it('passes the asked statuses — the archive included — through untouched', async () => {
    const { query, list } = harness();

    await query.execute({ actor: actorWith(), filter: { ...FILTER, statuses: ['ARCHIVED'] } });

    expect(list.pages[0]?.filter).toEqual({ ...FILTER, statuses: ['ARCHIVED'] });
  });

  it.each<[string, Actor, string]>([
    ['without project:read', actorWith({ permissions: new Set() }), 'permission_not_granted'],
    [
      'with project:read taken away',
      actorWith({ denied: new Set(['project:read']) }),
      'denied_by_override',
    ],
  ])('refuses a caller %s before any port is asked', async (_case, actor, reason) => {
    const { query, trace } = harness();

    await expect(query.execute({ actor, filter: FILTER })).rejects.toMatchObject({
      code: 'project_forbidden',
      reason,
    });
    expect(trace).toEqual(['withTenant']);
  });

  it('answers 503 acl_resolution_failed when the organization node cannot be read', async () => {
    const failure = new Error('connection terminated');
    const { query, trace, warnings } = harness(failure);

    await expect(query.execute({ actor: actorWith(), filter: FILTER })).rejects.toMatchObject({
      code: 'service_unavailable',
      reason: 'acl_resolution_failed',
    });
    // Neither «nothing» nor «everything»: the page is never asked for.
    expect(trace).toEqual(['withTenant', `entriesAlong:${IVAN}`]);
    // The refusal carries a reason; the cause an operator needs is in the log.
    expect(warnings).toEqual([
      { fields: { resourceType: 'ORGANIZATION', err: failure }, message: 'acl resolution failed' },
    ]);
  });
});
