import { type Prisma } from '@prisma/client';
import { assert, describe, expect, it } from 'vitest';

import { type ProjectListViewer } from '@/application/project/ports/project-list-query.port.js';
import { type ProjectOptionsFilter } from '@/application/project/ports/project-options-query.port.js';
import { PrismaProjectListQuery } from '@/infrastructure/persistence/prisma/project-list-query.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * The switcher's read (STORY-014-06) with the driver replaced by a recorder — what is **bound**.
 *
 * The row-level policy would hide another organization's projects even if the statement forgot its
 * tenant predicate, so only a recorder can hold that the organization of the scope is bound, and
 * that the plan reaching the statement is the list's own prefix and not a second rule
 * (`rules/testing.mdc`, «Второй рубеж обороны умеет скрывать отсутствие первого»). Whether the SQL
 * means what the policy means is `test/integration/db/project-options.test.ts`.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const PROJECT = '018f4a3b-0000-7000-8000-0000000000d1';
const OTHER = '018f4a3b-0000-7000-8000-0000000000d2';

interface Recorder {
  readonly statements: { sql: string; values: unknown[] }[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (answer: unknown[] = []): Recorder => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    $queryRaw: (query: Prisma.Sql): Promise<unknown[]> => {
      statements.push({ sql: query.text, values: query.values });

      return Promise.resolve(answer);
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

const FILTER: ProjectOptionsFilter = {
  query: '',
  statuses: ['ACTIVE', 'ON_HOLD', 'CLOSED'],
  ids: null,
  limit: 51,
};

const run = async (filter: ProjectOptionsFilter, answer: unknown[] = []) => {
  const recorder = recordingClient(answer);
  const rows = await withTenant(recorder.base, { organizationId: ORG, userId: IVAN }, () =>
    new PrismaProjectListQuery().options(VIEWER, filter),
  );
  const [statement] = recorder.statements;

  assert(statement !== undefined, 'the options read sent its statement');
  expect(recorder.statements).toHaveLength(1);

  return { statement, rows };
};

describe('PrismaProjectListQuery.options', () => {
  it('is one statement over the list’s visible set, tenant, caller and plan bound', async () => {
    const { statement } = await run(FILTER);

    // The list's own prefix — the same visible set, not a second predicate.
    expect(statement.sql).toContain('WITH subjects (subject_type, subject_id) AS');
    expect(statement.sql).toContain('p.deleted_at IS NULL');
    expect(statement.values.filter((value) => value === ORG).length).toBeGreaterThanOrEqual(2);
    expect(statement.values).toContain(IVAN);
    expect(statement.values).toContainEqual(['VIEWER', 'EDITOR']);
    expect(statement.values).toContainEqual(['PUBLIC_ORG:-', 'PRIVATE:LEAD']);
    expect(statement.values).toContainEqual(['ACTIVE', 'ON_HOLD', 'CLOSED']);
    expect(statement.sql).not.toContain(ORG);
    // Five columns and nothing that costs a subquery per row.
    expect(statement.sql).toMatch(
      /SELECT v\.id, v\.key, v\.name, v\.status, v\.color\s+FROM visible v/,
    );
    expect(statement.sql).not.toContain('member_count');
    expect(statement.sql).toMatch(/ORDER BY v\.name ASC, v\.id ASC\s+LIMIT/);
    expect(statement.values.at(-1)).toBe(51);
  });

  it('narrows by text and by ids only when asked, escaping the text', async () => {
    const { statement: plain } = await run(FILTER);
    const { statement: narrowed } = await run({
      ...FILTER,
      query: '50%_off\\',
      ids: [PROJECT, OTHER],
    });

    expect(narrowed.sql).toContain('ILIKE');
    expect(narrowed.values).toContain('%50\\%\\_off\\\\%');
    expect(narrowed.sql).toContain('v.id = ANY(');
    expect(narrowed.values).toContainEqual([PROJECT, OTHER]);

    expect(plain.sql).not.toContain('ILIKE');
    expect(plain.sql).not.toContain('v.id = ANY(');
  });

  it('binds an empty id list as «none of them», not as «no id filter»', async () => {
    const { statement } = await run({ ...FILTER, ids: [] });

    expect(statement.sql).toContain('v.id = ANY(');
    expect(statement.values).toContainEqual([]);
  });

  it('maps a row to the five fields of an option', async () => {
    const { rows } = await run(FILTER, [
      { id: PROJECT, key: 'BAD', name: 'Bad CRM', status: 'ARCHIVED', color: 'teal' },
    ]);

    expect(rows).toEqual([
      { projectId: PROJECT, key: 'BAD', name: 'Bad CRM', status: 'ARCHIVED', color: 'teal' },
    ]);
  });
});
