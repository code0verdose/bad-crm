import { type Prisma } from '@prisma/client';
import { assert, describe, expect, it } from 'vitest';

import {
  type ProjectListFilter,
  type ProjectListViewer,
} from '@/application/project/ports/project-list-query.port.js';
import { PrismaProjectListQuery } from '@/infrastructure/persistence/prisma/project-list-query.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * The project list with the driver replaced by a recorder.
 *
 * What the recorder can hold and a live database cannot: **what is bound**. The row-level policy
 * would hide another organization's projects even if the statement forgot its own tenant predicate,
 * so the integration suite stays green without it (`rules/testing.mdc`, «Второй рубеж обороны умеет
 * скрывать отсутствие первого»). Here every statement is required to bind the organization of the
 * scope — and the caller, the plan and the filters exactly as given, with the text of a search
 * escaped so that `%` and `_` are characters and not wildcards.
 *
 * Whether the SQL means what the policy means is the integration suite's question
 * (`test/integration/db/project-list.test.ts`, «list ≡ can() row by row»).
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const PETR = '018f4a3b-0000-7000-8000-0000000000c2';
const PROJECT = '018f4a3b-0000-7000-8000-0000000000d1';

interface Recorder {
  readonly statements: { sql: string; values: unknown[] }[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (answers: unknown[][] = []): Recorder => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    $queryRaw: (query: Prisma.Sql): Promise<unknown[]> => {
      statements.push({ sql: query.text, values: query.values });

      return Promise.resolve(answers[statements.length - 1] ?? []);
    },
  };

  return {
    statements,
    base: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const VIEWER: ProjectListViewer = {
  userId: IVAN,
  plan: {
    readableExplicitLevels: ['VIEWER', 'EDITOR'],
    implicitlyVisible: [
      { visibility: 'PUBLIC_ORG', memberRole: null },
      { visibility: 'PRIVATE', memberRole: 'LEAD' },
    ],
  },
};

const FILTER: ProjectListFilter = {
  query: '',
  statuses: ['ACTIVE', 'ON_HOLD'],
  leadId: null,
  memberOnly: false,
  sort: 'name',
  page: 3,
  perPage: 20,
};

const inScope = <T>(recorder: Recorder, work: (adapter: PrismaProjectListQuery) => Promise<T>) =>
  withTenant(recorder.base, { organizationId: ORG, userId: IVAN }, () =>
    work(new PrismaProjectListQuery()),
  );

/** The plan as the adapter binds it — two text arrays, the same shape in every statement. */
const PLAN_VALUES = [
  ['VIEWER', 'EDITOR'],
  ['PUBLIC_ORG:-', 'PRIVATE:LEAD'],
];

describe('PrismaProjectListQuery.page', () => {
  it('is two statements — the count and the page — over one visible set, tenant bound in both', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (adapter) => adapter.page(VIEWER, FILTER));

    expect(recorder.statements).toHaveLength(2);

    for (const statement of recorder.statements) {
      expect(statement.sql).toContain('WITH grants AS');
      expect(statement.sql).toContain('p.deleted_at IS NULL');
      expect(statement.sql).toContain('pm.left_at IS NULL');
      // The organization, the caller and the plan, bound — never interpolated.
      expect(statement.values.filter((value) => value === ORG).length).toBeGreaterThanOrEqual(2);
      expect(statement.values).toContain(IVAN);
      expect(statement.values).toContainEqual(PLAN_VALUES[0]);
      expect(statement.values).toContainEqual(PLAN_VALUES[1]);
      expect(statement.values).toContainEqual(['ACTIVE', 'ON_HOLD']);
      expect(statement.sql).not.toContain(ORG);
    }

    const [count, page] = recorder.statements;

    expect(count?.sql).toContain('count(*)');
    // Offset of page 3 at 20 per page, and the page size — bound, the last two values.
    expect(page?.values.slice(-2)).toEqual([20, 40]);
    // `id` settles every tie, so a row cannot appear on two consecutive pages.
    expect(page?.sql).toMatch(/ORDER BY v\.name ASC, v\.id ASC/);
  });

  it('narrows by text, lead and the caller’s own membership only when asked', async () => {
    const plain = recordingClient();
    const narrowed = recordingClient();

    await inScope(plain, (adapter) => adapter.page(VIEWER, FILTER));
    await inScope(narrowed, (adapter) =>
      adapter.page(VIEWER, { ...FILTER, query: '50%_off\\', leadId: PETR, memberOnly: true }),
    );

    const [plainCount] = plain.statements;
    const [narrowedCount] = narrowed.statements;

    // Narrowed first: a negation over a missing statement would pass by the statement's absence.
    assert(plainCount !== undefined, 'the plain page sent its count');
    assert(narrowedCount !== undefined, 'the narrowed page sent its count');

    expect(plainCount.sql).not.toContain('ILIKE');
    expect(plainCount.sql).not.toContain('v.lead_id =');
    expect(plainCount.sql).not.toContain('v.member_role IS NOT NULL');

    expect(narrowedCount.sql).toContain('ILIKE');
    expect(narrowedCount.sql).toContain('v.lead_id =');
    expect(narrowedCount.sql).toContain('v.member_role IS NOT NULL');
    // `%`, `_` and the escape character itself are literals of the search, not patterns.
    expect(narrowedCount.values).toContain('%50\\%\\_off\\\\%');
    expect(narrowedCount.values).toContain(PETR);
  });

  it.each<[ProjectListFilter['sort'], RegExp]>([
    ['name', /ORDER BY v\.name ASC, v\.id ASC/],
    ['-name', /ORDER BY v\.name DESC, v\.id ASC/],
    ['key', /ORDER BY v\.key ASC, v\.id ASC/],
    ['-key', /ORDER BY v\.key DESC, v\.id ASC/],
    ['createdAt', /ORDER BY v\.created_at ASC, v\.id ASC/],
    ['-createdAt', /ORDER BY v\.created_at DESC, v\.id ASC/],
  ])('orders %s from a closed list, id last', async (sort, order) => {
    const recorder = recordingClient();

    await inScope(recorder, (adapter) => adapter.page(VIEWER, { ...FILTER, sort }));

    expect(recorder.statements[1]?.sql).toMatch(order);
  });

  it('shapes the rows and the count', async () => {
    const recorder = recordingClient([
      [{ total: 41 }],
      [
        {
          id: PROJECT,
          key: 'BAD',
          name: 'Bad CRM',
          status: 'ON_HOLD',
          visibility: 'PRIVATE',
          lead_id: IVAN,
          color: 'indigo',
          member_count: 3,
        },
      ],
    ]);

    await expect(inScope(recorder, (adapter) => adapter.page(VIEWER, FILTER))).resolves.toEqual({
      items: [
        {
          projectId: PROJECT,
          key: 'BAD',
          name: 'Bad CRM',
          status: 'ON_HOLD',
          visibility: 'PRIVATE',
          leadId: IVAN,
          color: 'indigo',
          memberCount: 3,
        },
      ],
      total: 41,
    });
  });

  it('counts nothing as zero rather than as a missing row', async () => {
    await expect(
      inScope(recordingClient([[]]), (adapter) => adapter.page(VIEWER, FILTER)),
    ).resolves.toEqual({ items: [], total: 0 });
  });

  it('refuses to run outside a tenant scope', async () => {
    await expect(new PrismaProjectListQuery().page(VIEWER, FILTER)).rejects.toThrow(
      /ProjectListQuery\.page/,
    );
  });
});

describe('PrismaProjectListQuery.facets', () => {
  it('is one statement over the same visible set, without the caller’s filters', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (adapter) => adapter.facets(VIEWER));

    expect(recorder.statements).toHaveLength(1);

    const [statement] = recorder.statements;

    assert(statement !== undefined, 'the facets were asked for');
    expect(statement.sql).toContain('WITH grants AS');
    expect(statement.sql).not.toContain('ILIKE');
    expect(statement.values).toContain(ORG);
    expect(statement.values).toContain(IVAN);
    expect(statement.values).toContainEqual(PLAN_VALUES[1]);
  });

  it('splits the answer into statuses in catalogue order and leads by id', async () => {
    const recorder = recordingClient([
      [
        { facet: 'status', value: 'CLOSED' },
        { facet: 'lead', value: PETR },
        { facet: 'status', value: 'ACTIVE' },
        { facet: 'lead', value: IVAN },
      ],
    ]);

    await expect(inScope(recorder, (adapter) => adapter.facets(VIEWER))).resolves.toEqual({
      statuses: ['ACTIVE', 'CLOSED'],
      leadIds: [IVAN, PETR],
    });
  });
});
