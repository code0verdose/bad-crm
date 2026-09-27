import { describe, expect, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { type AclReaderPort } from '@/application/access/ports/acl-reader.port.js';
import { type ProjectListViewer } from '@/application/project/ports/project-list-query.port.js';
import {
  type ProjectOption,
  type ProjectOptionsFilter,
  type ProjectOptionsQueryPort,
} from '@/application/project/ports/project-options-query.port.js';
import {
  ListProjectOptionsQuery,
  PROJECT_OPTIONS_LIMIT,
  type ListProjectOptionsInput,
} from '@/application/project/use-cases/list-project-options.query.js';
import {
  type TenantScope,
  type UnitOfWorkPort,
} from '@/application/platform/ports/unit-of-work.port.js';
import { type AclChainNode, type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { visibleProjectsPlan } from '@/domain/project/access/visible-projects.policy.js';

/**
 * The header's project switcher, orchestrated — STORY-014-06 acceptances 3, 5, 7 and 9, the part
 * that is neither the rule (`visible-projects-policy.test.ts`) nor the SQL
 * (`test/integration/db/project-options.test.ts`).
 *
 * What only this level holds: the capability first, the organization node once, the **same** plan
 * the list uses handed to the adapter; the archive out unless asked for; «is there more» told by
 * one extra row, not by a count; and the recent ids asked as their own statement — or not at all.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const RECENT_A = '018f4a3b-0000-7000-8000-0000000000d1';
const RECENT_B = '018f4a3b-0000-7000-8000-0000000000d2';
const NOW = new Date('2026-09-27T12:00:00.000Z');

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

const INPUT: Omit<ListProjectOptionsInput, 'actor'> = {
  query: '',
  includeArchived: false,
  recentIds: [],
};

const option = (index: number): ProjectOption => ({
  projectId: `018f4a3b-0000-7000-8000-${index.toString().padStart(12, '0')}`,
  key: `P${index.toString()}`,
  name: `Project ${index.toString()}`,
  status: 'ACTIVE',
  color: 'indigo',
});

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

/** Answers `rows` rows to the id-less call and echoes the asked ids back as options. */
class RecordingOptions implements ProjectOptionsQueryPort {
  readonly calls: { viewer: ProjectListViewer; filter: ProjectOptionsFilter }[] = [];

  constructor(
    private readonly trace: string[],
    private readonly rows: number,
  ) {}

  options(
    viewer: ProjectListViewer,
    filter: ProjectOptionsFilter,
  ): Promise<readonly ProjectOption[]> {
    this.trace.push(filter.ids === null ? 'options' : 'recent');
    this.calls.push({ viewer, filter });

    if (filter.ids !== null) {
      return Promise.resolve(filter.ids.map((projectId) => ({ ...option(0), projectId })));
    }

    return Promise.resolve(
      Array.from({ length: Math.min(this.rows, filter.limit) }, (_, index) => option(index + 1)),
    );
  }
}

const harness = ({
  answer = [] as readonly AclEntryOnChain[] | Error,
  rows = 3,
}: { answer?: readonly AclEntryOnChain[] | Error; rows?: number } = {}) => {
  const trace: string[] = [];
  const warnings: string[] = [];
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (_fields: Record<string, unknown>, message: string) => {
      warnings.push(message);
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
  const options = new RecordingOptions(trace, rows);

  return {
    trace,
    scopes,
    acl,
    options,
    warnings,
    query: new ListProjectOptionsQuery(unitOfWork, acl, options, { now: () => NOW }, logger),
  };
};

describe('ListProjectOptionsQuery', () => {
  it('reads the organization node once, then the options, under one tenant scope', async () => {
    const { query, trace, scopes, acl } = harness();

    const result = await query.execute({ actor: actorWith(), ...INPUT });

    expect(scopes).toEqual([{ organizationId: ORG, userId: IVAN }]);
    // No recent ids asked for → no statement for them.
    expect(trace).toEqual(['withTenant', `entriesAlong:${IVAN}`, 'options']);
    expect(acl.chains).toEqual([[{ depth: 0, type: 'ORGANIZATION', id: ORG }]]);
    expect(result).toEqual({
      items: [option(1), option(2), option(3)],
      hasMore: false,
      recent: [],
    });
  });

  it('hands the adapter the plan the list would use — the same function, not a second one', async () => {
    const grants: AclEntryOnChain[] = [{ depth: 0, level: 'NONE', expiresAt: null }];
    const { query, options } = harness({ answer: grants });
    const actor = actorWith();

    await query.execute({ actor, ...INPUT, recentIds: [RECENT_A] });

    const expected = { userId: IVAN, plan: visibleProjectsPlan(actor, grants, NOW) };

    expect(options.calls.map((call) => call.viewer)).toEqual([expected, expected]);
  });

  it('keeps the archive out unless asked for, and lets it in when it is', async () => {
    const { query, options } = harness();

    await query.execute({ actor: actorWith(), ...INPUT, query: 'bad' });
    await query.execute({ actor: actorWith(), ...INPUT, includeArchived: true });

    expect(options.calls.map((call) => call.filter)).toEqual([
      {
        query: 'bad',
        statuses: ['ACTIVE', 'ON_HOLD', 'CLOSED'],
        ids: null,
        limit: PROJECT_OPTIONS_LIMIT + 1,
      },
      {
        query: '',
        statuses: ['ACTIVE', 'ON_HOLD', 'CLOSED', 'ARCHIVED'],
        ids: null,
        limit: PROJECT_OPTIONS_LIMIT + 1,
      },
    ]);
  });

  it('asks one row beyond the limit and answers «more» without returning it', async () => {
    const { query } = harness({ rows: PROJECT_OPTIONS_LIMIT + 1 });

    const result = await query.execute({ actor: actorWith(), ...INPUT });

    expect(result.items).toHaveLength(PROJECT_OPTIONS_LIMIT);
    expect(result.items.at(-1)).toEqual(option(PROJECT_OPTIONS_LIMIT));
    expect(result.hasMore).toBe(true);
  });

  it('answers exactly the limit as «no more»', async () => {
    const { query } = harness({ rows: PROJECT_OPTIONS_LIMIT });

    const result = await query.execute({ actor: actorWith(), ...INPUT });

    expect(result.items).toHaveLength(PROJECT_OPTIONS_LIMIT);
    expect(result.hasMore).toBe(false);
  });

  it('asks the recent ids as their own statement, without the text filter, under the same statuses', async () => {
    const { query, options, trace } = harness();

    const result = await query.execute({
      actor: actorWith(),
      ...INPUT,
      query: 'bad',
      recentIds: [RECENT_A, RECENT_B],
    });

    expect(trace).toEqual(['withTenant', `entriesAlong:${IVAN}`, 'options', 'recent']);
    expect(options.calls[1]?.filter).toEqual({
      query: '',
      statuses: ['ACTIVE', 'ON_HOLD', 'CLOSED'],
      ids: [RECENT_A, RECENT_B],
      limit: 2,
    });
    expect(result.recent.map((row) => row.projectId)).toEqual([RECENT_A, RECENT_B]);
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

    await expect(query.execute({ actor, ...INPUT })).rejects.toMatchObject({
      code: 'project_forbidden',
      reason,
    });
    expect(trace).toEqual(['withTenant']);
  });

  it('answers 503 acl_resolution_failed when the organization node cannot be read', async () => {
    const { query, trace, warnings } = harness({ answer: new Error('connection terminated') });

    await expect(query.execute({ actor: actorWith(), ...INPUT })).rejects.toMatchObject({
      code: 'service_unavailable',
      reason: 'acl_resolution_failed',
    });
    expect(trace).toEqual(['withTenant', `entriesAlong:${IVAN}`]);
    expect(warnings).toEqual(['acl resolution failed']);
  });
});
