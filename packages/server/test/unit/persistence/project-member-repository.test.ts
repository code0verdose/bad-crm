import { assert, describe, expect, it } from 'vitest';

import { PrismaProjectMemberRepository } from '@/infrastructure/persistence/prisma/project-member.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Project membership through Prisma, with the driver replaced by a recorder — STORY-014-02, the
 * persistence half.
 *
 * What the recorder is asked to prove, because a live run cannot see the decision behind the
 * statement:
 *
 *   * **the tenant is never a parameter** — every statement takes `organizationId` from the scope;
 *   * **a membership ends by `left_at`, not by `DELETE`** — the row is history and a later link
 *     target (`data-model.md` §3), so `leave` is a conditional `UPDATE … WHERE left_at IS NULL`;
 *   * **`add` is `ON CONFLICT … DO NOTHING` against the partial index** — the second of two
 *     concurrent adds of the same pair must be a silent no-op reported as `false`, not a 500, and
 *     the conflict target has to name the index predicate (`WHERE left_at IS NULL`) or PostgreSQL
 *     cannot infer the partial index at all;
 *   * **`leads` reads under `FOR UPDATE`** — «the last lead cannot leave» is a rule of the use-case,
 *     and it is only sound if two concurrent removals cannot both count two leads;
 *   * **`subject` reads under `FOR NO KEY UPDATE`** — the same TOCTOU `team.repository.ts` closes
 *     against offboarding, but not with the team's `FOR SHARE`: every reader of the subject goes
 *     on to bump `users.permissions_version` in the same transaction, and two of them sharing the
 *     row deadlock on the upgrade (measured red in `project-roster-races.test.ts`, «one person
 *     put on two different projects at the same time»).
 *
 * Whether PostgreSQL accepts these statements, and whether the locks serialize, is the subject of
 * `test/integration/db/project-repository.test.ts`.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000f1';
const PROJECT = '018f4a3b-0000-7000-8000-0000000000f2';
const IVAN = '018f4a3b-0000-7000-8000-0000000000f3';
const PETR = '018f4a3b-0000-7000-8000-0000000000f4';

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
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      raw.push({ sql: strings.join('?'), values });

      return Promise.resolve((overrides['executed'] as number | undefined) ?? 1);
    },
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      raw.push({ sql: strings.join('?'), values });

      return Promise.resolve(queued.shift() ?? []);
    },
    projectMember: {
      findFirst: record('projectMember.findFirst', overrides['member'] ?? null),
      findMany: record('projectMember.findMany', overrides['members'] ?? []),
      updateMany: record('projectMember.updateMany', { count: overrides['updated'] ?? 1 }),
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
  work: (repository: PrismaProjectMemberRepository) => Promise<T>,
): Promise<T> =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    work(new PrismaProjectMemberRepository()),
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

describe('the roster of a project', () => {
  it('lists live memberships in joining order, scoped to the tenant', async () => {
    const joinedAt = new Date('2026-01-01T00:00:00Z');
    const recorder = recordingClient({
      members: [{ userId: IVAN, projectRole: 'LEAD', allocationPct: 100, joinedAt, leftAt: null }],
    });

    await expect(inScope(recorder, (repository) => repository.roster(PROJECT))).resolves.toEqual([
      { userId: IVAN, projectRole: 'LEAD', allocationPct: 100, joinedAt, leftAt: null },
    ]);

    expect(whereOf(recorder, 'projectMember.findMany')).toEqual({
      organizationId: ORG,
      projectId: PROJECT,
      leftAt: null,
    });
    expect(argsOf(recorder, 'projectMember.findMany')['orderBy']).toEqual({ joinedAt: 'asc' });
  });

  it('includes the people who left only when asked to', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.roster(PROJECT, { includeLeft: true }));

    expect(whereOf(recorder, 'projectMember.findMany')).toEqual({
      organizationId: ORG,
      projectId: PROJECT,
    });
  });
});

describe('the membership of one person', () => {
  it('reads the live row only: a membership that ended is no membership', async () => {
    const recorder = recordingClient({ member: { projectRole: 'REVIEWER', allocationPct: 20 } });

    await expect(
      inScope(recorder, (repository) => repository.membershipOf(PROJECT, IVAN)),
    ).resolves.toEqual({ projectRole: 'REVIEWER', allocationPct: 20 });

    expect(whereOf(recorder, 'projectMember.findFirst')).toEqual({
      organizationId: ORG,
      projectId: PROJECT,
      userId: IVAN,
      leftAt: null,
    });
  });

  it('answers null when there is no live membership', async () => {
    const recorder = recordingClient();

    await expect(
      inScope(recorder, (repository) => repository.membershipOf(PROJECT, IVAN)),
    ).resolves.toBeNull();
  });
});

describe('the leads of a project', () => {
  it('locks the live LEAD rows FOR UPDATE and returns their ids', async () => {
    const recorder = recordingClient({ queryRaw: [[{ user_id: IVAN }]] });

    await expect(inScope(recorder, (repository) => repository.leads(PROJECT))).resolves.toEqual([
      IVAN,
    ]);

    const read = statementAt(recorder, 0);

    expect(read.sql).toContain('FOR UPDATE');
    expect(read.sql).toContain('left_at IS NULL');
    expect(read.sql).toContain("'LEAD'");
    expect(read.values).toEqual(expect.arrayContaining([ORG, PROJECT]));
  });
});

describe('the account a membership would be written for', () => {
  it('reads the live account under FOR NO KEY UPDATE, never FOR SHARE', async () => {
    const recorder = recordingClient({ queryRaw: [[{ id: IVAN, status: 'ACTIVE' }]] });

    await expect(inScope(recorder, (repository) => repository.subject(IVAN))).resolves.toEqual({
      userId: IVAN,
      status: 'ACTIVE',
    });

    const read = statementAt(recorder, 0);

    expect(read.sql).toContain('FOR NO KEY UPDATE');
    expect(read.sql).not.toContain('FOR SHARE');
    expect(read.sql).toContain('deleted_at IS NULL');
    expect(read.values).toEqual(expect.arrayContaining([ORG, IVAN]));
  });

  it('answers null for an account the tenant cannot see', async () => {
    const recorder = recordingClient();

    await expect(inScope(recorder, (repository) => repository.subject(IVAN))).resolves.toBeNull();
  });
});

describe('adding a member', () => {
  it('inserts against the partial index and reports that a row appeared', async () => {
    const recorder = recordingClient({ executed: 1 });

    await expect(
      inScope(recorder, (repository) => repository.add(PROJECT, IVAN, 'MEMBER', 50)),
    ).resolves.toBe(true);

    const insert = statementAt(recorder, 0);

    expect(insert.sql).toContain('INSERT INTO project_members');
    // The conflict target must carry the index predicate, or PostgreSQL has no partial index to
    // infer and answers `there is no unique or exclusion constraint matching the ON CONFLICT
    // specification` — on every call, not only on a conflict.
    expect(insert.sql).toMatch(
      /ON CONFLICT \(project_id, user_id\) WHERE left_at IS NULL DO NOTHING/,
    );
    expect(insert.values).toEqual(expect.arrayContaining([ORG, PROJECT, IVAN, 'MEMBER', 50]));
  });

  it('reports false when the pair already holds a live membership', async () => {
    const recorder = recordingClient({ executed: 0 });

    await expect(
      inScope(recorder, (repository) => repository.add(PROJECT, IVAN, 'MEMBER', 50)),
    ).resolves.toBe(false);
  });
});

describe('changing a membership', () => {
  it('writes role and allocation to the live row only', async () => {
    const recorder = recordingClient();

    await expect(
      inScope(recorder, (repository) =>
        repository.update(PROJECT, IVAN, { projectRole: 'LEAD', allocationPct: 80 }),
      ),
    ).resolves.toBe(true);

    expect(whereOf(recorder, 'projectMember.updateMany')).toEqual({
      organizationId: ORG,
      projectId: PROJECT,
      userId: IVAN,
      leftAt: null,
    });
    expect(argsOf(recorder, 'projectMember.updateMany')['data']).toEqual({
      projectRole: 'LEAD',
      allocationPct: 80,
    });
  });

  it('leaves a field alone when the patch does not name it', async () => {
    const recorder = recordingClient({ updated: 0 });

    await expect(
      inScope(recorder, (repository) => repository.update(PROJECT, IVAN, { allocationPct: 10 })),
    ).resolves.toBe(false);

    expect(argsOf(recorder, 'projectMember.updateMany')['data']).toEqual({ allocationPct: 10 });
  });

  it('changes the role alone without touching the allocation', async () => {
    const recorder = recordingClient();

    await expect(
      inScope(recorder, (repository) => repository.update(PROJECT, IVAN, { projectRole: 'LEAD' })),
    ).resolves.toBe(true);

    expect(argsOf(recorder, 'projectMember.updateMany')['data']).toEqual({ projectRole: 'LEAD' });
  });
});

describe('leaving a project', () => {
  it('stamps left_at on the live row in one conditional statement', async () => {
    const recorder = recordingClient({ executed: 1 });

    await expect(inScope(recorder, (repository) => repository.leave(PROJECT, IVAN))).resolves.toBe(
      true,
    );

    const update = statementAt(recorder, 0);

    expect(update.sql).toContain('UPDATE project_members');
    expect(update.sql).toContain('SET left_at = now()');
    expect(update.sql).toContain('left_at IS NULL');
    expect(update.sql).not.toContain('DELETE');
    expect(update.values).toEqual(expect.arrayContaining([ORG, PROJECT, IVAN]));
  });

  it('reports false when there was no live membership to end', async () => {
    const recorder = recordingClient({ executed: 0 });

    await expect(inScope(recorder, (repository) => repository.leave(PROJECT, IVAN))).resolves.toBe(
      false,
    );
  });
});

describe('invalidating the folded rights of the people concerned', () => {
  it('bumps every id in one statement, scoped to the tenant', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.bumpPermissionsVersionOf([IVAN, PETR]));

    const bump = statementAt(recorder, 0);

    expect(bump.sql).toContain('permissions_version = permissions_version + 1');
    expect(bump.sql).toContain('organization_id = ?');
    expect(bump.values).toEqual([ORG, [IVAN, PETR]]);
    expect(recorder.raw).toHaveLength(1);
  });

  it('sends nothing for nobody', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.bumpPermissionsVersionOf([]));

    expect(recorder.raw).toEqual([]);
  });
});
