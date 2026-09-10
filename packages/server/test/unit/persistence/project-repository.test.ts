import { assert, describe, expect, it } from 'vitest';

import { PrismaProjectRepository } from '@/infrastructure/persistence/prisma/project.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Projects through Prisma, with the driver replaced by a recorder — STORY-014-01, the persistence
 * half.
 *
 * The **arguments** are the subject, as in `team-repository.test.ts` next door: a live database
 * shows that a statement was accepted, never which decision produced it. The decisions that matter
 * here and are invisible in an integration run:
 *
 *   * **the tenant is never a parameter** — every statement takes `organizationId` from the scope;
 *   * **the list filters soft deletions in SQL and the reads by id do not** — a list showing a
 *     deleted project would be wrong, and a `WHERE deleted_at IS NULL` on `scope`/`detail` would take
 *     the 404-for-a-deleted-project decision away from the policy (`data-model.md` asks for a global
 *     `$extends` filter; the tree has none, so the filter is explicit and this test is what keeps it
 *     on every list and off every read by id);
 *   * **every write carries `deletedAt: null`** — a deleted project must not be editable, and a rename
 *     without that predicate would resurrect a key conflict against a live project;
 *   * **`scope` reads under `FOR SHARE`** — the same TOCTOU the team repository closes: a membership
 *     written later in the transaction must not land on a project a concurrent request has hidden.
 *
 * Whether PostgreSQL accepts these statements is the subject of
 * `test/integration/db/project-repository.test.ts`.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000e1';
const PROJECT = '018f4a3b-0000-7000-8000-0000000000e2';
const LEAD = '018f4a3b-0000-7000-8000-0000000000e3';

interface Recorder {
  readonly calls: { name: string; args: Record<string, unknown> }[];
  readonly raw: { sql: string; values: unknown[] }[];
  readonly base: Parameters<typeof withTenant>[0];
}

const isTenantPreamble = (sql: string): boolean => sql.includes('set_config');

const recordingClient = (overrides: Record<string, unknown> = {}): Recorder => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const record =
    <T>(name: string, result: T) =>
    (args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ name, args });

      return Promise.resolve(result);
    };

  const raw: { sql: string; values: unknown[] }[] = [];
  const queued = [...((overrides['queryRaw'] as unknown[][] | undefined) ?? [])];

  const tx = {
    // `withTenant` opens the scope with two `set_config` calls through `$executeRaw`; the
    // repository itself issues none — every raw statement it sends is a `$queryRaw`.
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      raw.push({ sql: strings.join('?'), values });

      return Promise.resolve(1);
    },
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      raw.push({ sql: strings.join('?'), values });

      return Promise.resolve(queued.shift() ?? []);
    },
    project: {
      findFirst: record('project.findFirst', overrides['project'] ?? null),
      findMany: record('project.findMany', overrides['projects'] ?? []),
      create: record('project.create', { id: 'project-created' }),
      updateMany: record('project.updateMany', { count: overrides['updated'] ?? 1 }),
    },
  };

  return {
    calls,
    get raw() {
      return raw.filter((statement) => !isTenantPreamble(statement.sql));
    },
    base: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const inScope = async <T>(
  recorder: Recorder,
  work: (repository: PrismaProjectRepository) => Promise<T>,
): Promise<T> =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    work(new PrismaProjectRepository()),
  );

const argsOf = (recorder: Recorder, name: string): Record<string, unknown> =>
  (recorder.calls.find((call) => call.name === name)?.args ?? {}) as Record<string, unknown>;

const whereOf = (recorder: Recorder, name: string): Record<string, unknown> =>
  argsOf(recorder, name)['where'] as Record<string, unknown>;

const statementAt = (recorder: Recorder, index: number): { sql: string; values: unknown[] } => {
  const statement = recorder.raw[index];

  assert(statement !== undefined, `the repository issued statement #${index}`);

  return statement;
};

const draft = {
  key: 'BAD',
  name: 'Bad CRM',
  description: null,
  visibility: 'PUBLIC_ORG' as const,
  leadId: LEAD,
  startedAt: null,
  dueAt: null,
  color: 'indigo',
};

describe('listing the projects of the tenant', () => {
  it('reads the rows and the live member count in one statement, ordered by key', async () => {
    const recorder = recordingClient({
      projects: [
        {
          id: PROJECT,
          key: 'BAD',
          name: 'Bad CRM',
          status: 'ACTIVE',
          visibility: 'PUBLIC_ORG',
          leadId: LEAD,
          color: 'indigo',
          _count: { members: 3 },
        },
      ],
    });

    expect(await inScope(recorder, (repository) => repository.list())).toEqual([
      {
        projectId: PROJECT,
        key: 'BAD',
        name: 'Bad CRM',
        status: 'ACTIVE',
        visibility: 'PUBLIC_ORG',
        leadId: LEAD,
        color: 'indigo',
        memberCount: 3,
      },
    ]);

    expect(argsOf(recorder, 'project.findMany')['orderBy']).toEqual({ key: 'asc' });
    // People who left are not on the team: the count is over live memberships only.
    expect(argsOf(recorder, 'project.findMany')['select']).toMatchObject({
      _count: { select: { members: { where: { leftAt: null } } } },
    });
  });

  it('filters the soft deletions in the query, not afterwards', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.list());

    expect(whereOf(recorder, 'project.findMany')).toEqual({ organizationId: ORG, deletedAt: null });
  });
});

describe('reading one project', () => {
  it('scope does not filter soft deletions and locks the row FOR SHARE', async () => {
    const recorder = recordingClient({
      queryRaw: [[{ id: PROJECT, deleted_at: new Date(), visibility: 'PRIVATE' }]],
    });

    await expect(inScope(recorder, (repository) => repository.scope(PROJECT))).resolves.toEqual({
      projectId: PROJECT,
      isDeleted: true,
      visibility: 'PRIVATE',
    });

    const read = statementAt(recorder, 0);

    expect(read.sql).toContain('FOR SHARE');
    expect(read.sql).not.toContain('deleted_at IS NULL');
    expect(read.values).toEqual(expect.arrayContaining([ORG, PROJECT]));
  });

  it('answers null when the tenant policy returns no row', async () => {
    const recorder = recordingClient();

    await expect(inScope(recorder, (repository) => repository.scope(PROJECT))).resolves.toBeNull();
  });

  it('reports a live project as not deleted', async () => {
    const recorder = recordingClient({
      queryRaw: [[{ id: PROJECT, deleted_at: null, visibility: 'PUBLIC_ORG' }]],
    });

    await expect(
      inScope(recorder, (repository) => repository.scope(PROJECT)),
    ).resolves.toMatchObject({ isDeleted: false });
  });

  /**
   * The writer's read. `FOR UPDATE`, not `FOR SHARE`: a writer that took the share lock through
   * `scope()` and then ran `UPDATE` would upgrade its lock while a second writer holds the same
   * share lock — and two such requests on one project deadlock, each waiting for the other to
   * release the share it will not release until it has upgraded (the gate's note on step 3; measured
   * in `test/integration/db/project-write-locks.test.ts`). Every mutation reads through this method.
   */
  it('lockForWrite reads the summary FOR UPDATE, flagged rather than filtered', async () => {
    const startedAt = new Date('2026-01-01T00:00:00Z');
    const recorder = recordingClient({
      queryRaw: [
        [
          {
            id: PROJECT,
            key: 'BAD',
            name: 'Bad CRM',
            description: null,
            status: 'ARCHIVED',
            visibility: 'PRIVATE',
            lead_id: LEAD,
            started_at: startedAt,
            due_at: null,
            color: 'indigo',
            deleted_at: new Date(),
          },
        ],
      ],
    });

    await expect(
      inScope(recorder, (repository) => repository.lockForWrite(PROJECT)),
    ).resolves.toEqual({
      projectId: PROJECT,
      isDeleted: true,
      visibility: 'PRIVATE',
      key: 'BAD',
      name: 'Bad CRM',
      description: null,
      status: 'ARCHIVED',
      leadId: LEAD,
      startedAt,
      dueAt: null,
      color: 'indigo',
    });

    const read = statementAt(recorder, 0);

    expect(read.sql).toContain('FOR UPDATE');
    expect(read.sql).not.toContain('FOR SHARE');
    expect(read.sql).not.toContain('deleted_at IS NULL');
    expect(read.values).toEqual(expect.arrayContaining([ORG, PROJECT]));
  });

  it('lockForWrite answers null when the tenant policy returns no row', async () => {
    const recorder = recordingClient();

    await expect(
      inScope(recorder, (repository) => repository.lockForWrite(PROJECT)),
    ).resolves.toBeNull();
  });

  it('maps the detail and counts live members from the relation', async () => {
    const startedAt = new Date('2026-01-01T00:00:00Z');
    const createdAt = new Date('2025-12-31T00:00:00Z');
    const recorder = recordingClient({
      project: {
        id: PROJECT,
        key: 'BAD',
        name: 'Bad CRM',
        description: 'The product',
        status: 'ACTIVE',
        visibility: 'PUBLIC_ORG',
        leadId: LEAD,
        startedAt,
        dueAt: null,
        color: 'indigo',
        taskCounter: 14,
        createdAt,
        deletedAt: null,
        _count: { members: 2 },
      },
    });

    await expect(inScope(recorder, (repository) => repository.detail(PROJECT))).resolves.toEqual({
      projectId: PROJECT,
      key: 'BAD',
      name: 'Bad CRM',
      description: 'The product',
      status: 'ACTIVE',
      visibility: 'PUBLIC_ORG',
      leadId: LEAD,
      startedAt,
      dueAt: null,
      color: 'indigo',
      taskCounter: 14,
      createdAt,
      isDeleted: false,
      memberCount: 2,
    });

    // Scoped to the tenant and **not** filtered by `deletedAt`: the policy decides.
    expect(whereOf(recorder, 'project.findFirst')).toEqual({ organizationId: ORG, id: PROJECT });
  });

  it('answers null for a detail the tenant cannot see', async () => {
    const recorder = recordingClient();

    await expect(inScope(recorder, (repository) => repository.detail(PROJECT))).resolves.toBeNull();
  });
});

describe('writing a project', () => {
  it('creates with the tenant of the scope, never with one passed in', async () => {
    const recorder = recordingClient();

    await expect(inScope(recorder, (repository) => repository.create(draft))).resolves.toBe(
      'project-created',
    );

    expect(argsOf(recorder, 'project.create')['data']).toEqual({
      organizationId: ORG,
      ...draft,
    });
  });

  it('updates the editable fields only, and only a live row', async () => {
    const recorder = recordingClient();
    const patch = {
      name: 'Renamed',
      description: 'now described',
      leadId: LEAD,
      startedAt: new Date('2026-02-01T00:00:00Z'),
      dueAt: null,
      color: 'teal',
    };

    await expect(
      inScope(recorder, (repository) => repository.update(PROJECT, patch)),
    ).resolves.toBe(true);

    expect(whereOf(recorder, 'project.updateMany')).toEqual({
      organizationId: ORG,
      id: PROJECT,
      deletedAt: null,
    });
    // `key` is part of every task number (`BAD-14`) and is not on the patch at all.
    expect(argsOf(recorder, 'project.updateMany')['data']).toEqual(patch);
  });

  it('reports false when the row went away between the decision and the write', async () => {
    const recorder = recordingClient({ updated: 0 });

    await expect(
      inScope(recorder, (repository) =>
        repository.update(PROJECT, {
          name: 'Renamed',
          description: null,
          leadId: LEAD,
          startedAt: null,
          dueAt: null,
          color: 'teal',
        }),
      ),
    ).resolves.toBe(false);
  });

  it('changes visibility on a live row only', async () => {
    const recorder = recordingClient();

    await expect(
      inScope(recorder, (repository) => repository.changeVisibility(PROJECT, 'PRIVATE')),
    ).resolves.toBe(true);

    expect(whereOf(recorder, 'project.updateMany')).toEqual({
      organizationId: ORG,
      id: PROJECT,
      deletedAt: null,
    });
    expect(argsOf(recorder, 'project.updateMany')['data']).toEqual({ visibility: 'PRIVATE' });
  });

  it('changes status on a live row only', async () => {
    const recorder = recordingClient({ updated: 0 });

    await expect(
      inScope(recorder, (repository) => repository.changeStatus(PROJECT, 'ARCHIVED')),
    ).resolves.toBe(false);

    expect(whereOf(recorder, 'project.updateMany')).toEqual({
      organizationId: ORG,
      id: PROJECT,
      deletedAt: null,
    });
    expect(argsOf(recorder, 'project.updateMany')['data']).toEqual({ status: 'ARCHIVED' });
  });

  /**
   * One conditional statement, stamped by the database: reading first and hiding afterwards would be
   * two statements over a row a concurrent request can delete in between, and the second caller
   * would then file an audit entry for a deletion somebody else performed.
   */
  it('soft-deletes conditionally in one statement, stamped with the transaction clock', async () => {
    const recorder = recordingClient({ queryRaw: [[{ id: PROJECT }]] });

    await expect(inScope(recorder, (repository) => repository.softDelete(PROJECT))).resolves.toBe(
      true,
    );

    const statement = statementAt(recorder, 0);

    expect(statement.sql).toContain('deleted_at IS NULL');
    expect(statement.sql).toContain('now()');
    expect(statement.values).toEqual(expect.arrayContaining([ORG, PROJECT]));
  });

  it('reports false when there was nothing live to delete', async () => {
    const recorder = recordingClient();

    await expect(inScope(recorder, (repository) => repository.softDelete(PROJECT))).resolves.toBe(
      false,
    );
  });
});
