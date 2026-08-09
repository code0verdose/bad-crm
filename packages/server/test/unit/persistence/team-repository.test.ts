import { describe, expect, it } from 'vitest';

import { PrismaTeamRepository } from '@/infrastructure/persistence/prisma/team.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Teams through Prisma, with the driver replaced by a recorder.
 *
 * The **arguments** are the subject here, as in the neighbouring repository tests: a live database
 * shows that a statement was accepted, never which decision produced it. Several of those decisions
 * are invisible in an integration run and expensive when wrong:
 *
 *   * **the tenant is never a parameter** — every statement takes `organizationId` from the scope,
 *     because a repository that accepted one would have a second source of truth about which
 *     organization the caller is in, and a mismatch is *filtered* by the policy rather than refused;
 *   * **the list filters soft deletions and the reads by id do not** — a list showing a disbanded
 *     team would be wrong, and a `WHERE deleted_at IS NULL` on `scope`/`detail` would take the
 *     404-for-a-disbanded-team decision away from the policy and leave that branch unreachable;
 *   * **the update carries `deletedAt: null`** — a disbanded team must not be editable, and a rename
 *     without that predicate would resurrect a slug conflict against a live team;
 *   * **the bump is one statement over an array**, not a statement per person;
 *   * **`scope` and `subject` read under `FOR SHARE`** — the gate's M-1: without the lock, a decision
 *     made from either read can be overturned by a concurrent write before this transaction acts on
 *     it, and a live run has no way to force that interleaving on demand;
 *   * **`addMember` locks with `FOR UPDATE` before deciding to upsert** — the gate's L-3: the
 *     conflict clause has to be `DO UPDATE … WHERE team_role <> EXCLUDED.team_role`, never `DO
 *     NOTHING`, or a role change through this endpoint silently stops working again.
 *
 * Whether PostgreSQL accepts these statements — and whether the locks actually serialize two
 * concurrent transactions — is the subject of `test/integration/db/team-repository.test.ts`; a
 * recorder cannot answer either and does not try.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000d1';
const TEAM = '018f4a3b-0000-7000-8000-0000000000d2';
const IVAN = '018f4a3b-0000-7000-8000-0000000000d3';

interface Recorder {
  readonly calls: { name: string; args: Record<string, unknown> }[];
  /**
   * Raw statements the **repository** issued, as the tagged template hands them over.
   *
   * The two `set_config` calls `withTenant` opens the scope with are excluded: they are the harness,
   * not the subject, and counting them would make «one statement for the whole team» read as three.
   */
  readonly raw: { sql: string; values: unknown[] }[];
  readonly base: Parameters<typeof withTenant>[0];
}

/** The tenant preamble of `withTenant`, which every scope issues before any repository runs. */
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
    team: {
      findFirst: record('team.findFirst', overrides['team'] ?? null),
      findMany: record('team.findMany', overrides['teams'] ?? []),
      create: record('team.create', { id: 'team-created' }),
      updateMany: record('team.updateMany', { count: overrides['updated'] ?? 1 }),
    },
    teamMember: {
      deleteMany: record('teamMember.deleteMany', { count: overrides['removed'] ?? 1 }),
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
  work: (repository: PrismaTeamRepository) => Promise<T>,
): Promise<T> =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    work(new PrismaTeamRepository()),
  );

const argsOf = (recorder: Recorder, name: string): Record<string, unknown> =>
  (recorder.calls.find((call) => call.name === name)?.args ?? {}) as Record<string, unknown>;

const whereOf = (recorder: Recorder, name: string): Record<string, unknown> =>
  argsOf(recorder, name)['where'] as Record<string, unknown>;

describe('listing the teams of the tenant', () => {
  it('reads the rows and the member count in one statement, ordered by name', async () => {
    const recorder = recordingClient({
      teams: [
        {
          id: TEAM,
          name: 'Backend',
          slug: 'backend',
          description: null,
          _count: { members: 2 },
        },
      ],
    });

    expect(await inScope(recorder, (repository) => repository.list())).toEqual([
      { teamId: TEAM, name: 'Backend', slug: 'backend', description: null, memberCount: 2 },
    ]);

    expect(argsOf(recorder, 'team.findMany')['orderBy']).toEqual({ name: 'asc' });
  });

  it('filters the soft deletions in the query, not afterwards', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.list());

    // A list and a count computed from different sets is how the two disagree; the `WHERE` is what
    // keeps them one query (`rules/permissions.mdc`, 8).
    expect(whereOf(recorder, 'team.findMany')).toEqual({ organizationId: ORG, deletedAt: null });
  });
});

describe('reading one team', () => {
  it('does not filter soft deletions: the policy decides, not the WHERE clause', async () => {
    const recorder = recordingClient({
      queryRaw: [[{ id: TEAM, deleted_at: new Date() }]],
    });

    await expect(inScope(recorder, (repository) => repository.scope(TEAM))).resolves.toEqual({
      teamId: TEAM,
      isDeleted: true,
    });

    // `FOR SHARE`, not a plain read — the gate's M-1. Without this lock, this read and `disband()`'s
    // `UPDATE` can interleave under `ReadCommitted` so that a write later in the same transaction —
    // `addMember` above all — lands on a fact a concurrent `disband` had already overturned.
    expect(recorder.raw[0]?.sql).toContain('FOR SHARE');
    // No `deleted_at IS NULL` in the predicate. With one, `teamAddressable`'s disbanded branch could
    // never run and the 404 it produces would be untested — the row would simply be absent.
    expect(recorder.raw[0]?.sql).not.toContain('deleted_at IS NULL');
    // The tenant predicate and the id are both bound values, not only one of them.
    expect(recorder.raw[0]?.values).toEqual(expect.arrayContaining([ORG, TEAM]));
  });

  it('answers null when the tenant policy returns no row', async () => {
    const recorder = recordingClient();

    await expect(inScope(recorder, (repository) => repository.scope(TEAM))).resolves.toBeNull();
  });

  it('reports a live team as not deleted', async () => {
    const recorder = recordingClient({ queryRaw: [[{ id: TEAM, deleted_at: null }]] });

    await expect(inScope(recorder, (repository) => repository.scope(TEAM))).resolves.toMatchObject({
      isDeleted: false,
    });
  });

  /**
   * `summary` is what `UpdateTeamUseCase` reads for its audit `before` (`write-team.use-case.ts`) —
   * `name`/`slug` and the deletion flag, never the roster `detail` pulls in alongside them.
   */
  it('reads name and slug without the roster `detail` would fetch alongside them', async () => {
    const recorder = recordingClient({
      team: { id: TEAM, name: 'Backend', slug: 'backend', deletedAt: null },
    });

    await expect(inScope(recorder, (repository) => repository.summary(TEAM))).resolves.toEqual({
      teamId: TEAM,
      name: 'Backend',
      slug: 'backend',
      isDeleted: false,
    });

    // `members` never asked for: the whole point of this method existing beside `detail`.
    expect(argsOf(recorder, 'team.findFirst')['select']).not.toHaveProperty('members');
  });

  it('answers null for a summary the tenant cannot see', async () => {
    const recorder = recordingClient();

    await expect(inScope(recorder, (repository) => repository.summary(TEAM))).resolves.toBeNull();
  });

  it('maps the roster and counts it from the rows themselves', async () => {
    const joinedAt = new Date('2026-01-01T00:00:00Z');
    const recorder = recordingClient({
      team: {
        id: TEAM,
        name: 'Backend',
        slug: 'backend',
        description: 'Ships the API',
        deletedAt: null,
        members: [{ userId: IVAN, teamRole: 'LEAD', joinedAt }],
      },
    });

    await expect(inScope(recorder, (repository) => repository.detail(TEAM))).resolves.toEqual({
      teamId: TEAM,
      name: 'Backend',
      slug: 'backend',
      description: 'Ships the API',
      isDeleted: false,
      memberCount: 1,
      members: [{ userId: IVAN, teamRole: 'LEAD', joinedAt }],
    });
  });

  it('scopes the detail lookup to the tenant: the WHERE clause carries organizationId', async () => {
    const recorder = recordingClient({
      team: {
        id: TEAM,
        name: 'Backend',
        slug: 'backend',
        description: null,
        deletedAt: null,
        members: [],
      },
    });

    await inScope(recorder, (repository) => repository.detail(TEAM));

    // No `deletedAt` in the predicate, for the same reason as `scope` above: with one, the
    // 404-for-a-disbanded-team branch could never run and would be untested. The `organizationId`
    // is what this test exists to pin — without it, RLS alone would still return null for a foreign
    // team and the integration suite would stay green over a repository that never asked.
    expect(whereOf(recorder, 'team.findFirst')).toEqual({ organizationId: ORG, id: TEAM });
  });

  it('answers null for a detail the tenant cannot see', async () => {
    const recorder = recordingClient();

    await expect(inScope(recorder, (repository) => repository.detail(TEAM))).resolves.toBeNull();
  });
});

describe('writing a team', () => {
  it('takes the organization from the scope rather than from the caller', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) =>
      repository.create({ name: 'Backend', slug: 'backend', description: null }),
    );

    expect(argsOf(recorder, 'team.create')['data']).toMatchObject({ organizationId: ORG });
  });

  it('refuses to edit a disbanded team, by predicate', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) =>
      repository.update(TEAM, { name: 'Platform', slug: 'platform', description: null }),
    );

    expect(whereOf(recorder, 'team.updateMany')).toEqual({
      organizationId: ORG,
      id: TEAM,
      deletedAt: null,
    });
  });

  it('reports that nothing was updated when the row went away', async () => {
    const recorder = recordingClient({ updated: 0 });

    await expect(
      inScope(recorder, (repository) =>
        repository.update(TEAM, { name: 'Platform', slug: 'platform', description: null }),
      ),
    ).resolves.toBe(false);
  });
});

describe('disbanding a team', () => {
  it('hides the row and deletes the memberships, returning both in one pass each with their role', async () => {
    const recorder = recordingClient({
      queryRaw: [[{ name: 'Backend' }], [{ user_id: IVAN, team_role: 'LEAD' }]],
    });

    await expect(inScope(recorder, (repository) => repository.disband(TEAM))).resolves.toEqual({
      name: 'Backend',
      members: [{ userId: IVAN, teamRole: 'LEAD' }],
    });

    // Conditional on `deleted_at IS NULL` and returning in the same statement: reading first and
    // hiding afterwards is a window in which a second caller files a deletion somebody else made.
    expect(recorder.raw[0]?.sql).toContain('deleted_at IS NULL');
    expect(recorder.raw[0]?.sql).toContain('RETURNING name');
    // Both halves of the predicate are bound values, not only the organization: a `WHERE` that lost
    // `id = teamId` and fell back to `organization_id` alone would hide every team of the tenant, and
    // a check for `ORG` on its own would not notice `TEAM` missing from the same statement.
    expect(recorder.raw[0]?.values).toEqual(expect.arrayContaining([ORG, TEAM]));
    // `RETURNING user_id, team_role`, because `deleteMany` cannot report what it removed and
    // `team_members` has no `deleted_at` — neither column exists anywhere else once the statement
    // has run, and `team.deleted` (M-2 of the STORY-012-07 gate) is what carries `team_role` on.
    expect(recorder.raw[1]?.sql).toContain('RETURNING user_id, team_role');
    // Same reasoning as above, for the DELETE: losing `team_id = teamId` here would unstaff every
    // team of the tenant, not just the one addressed.
    expect(recorder.raw[1]?.values).toEqual(expect.arrayContaining([ORG, TEAM]));
  });

  it('answers null without touching the memberships when nothing was live', async () => {
    const recorder = recordingClient({ queryRaw: [[]] });

    await expect(inScope(recorder, (repository) => repository.disband(TEAM))).resolves.toBeNull();

    // One statement, not two: a delete issued anyway would remove the memberships of a team this
    // caller did not disband.
    expect(recorder.raw).toHaveLength(1);
  });
});

describe('membership', () => {
  /**
   * The gate's L-3 turned `addMember` from one statement into a lock-then-write, and the gate's M-1
   * is why the lock comes first: two requests racing the same pair must resolve through PostgreSQL's
   * own row lock, not through whichever of them happens to run its `INSERT` first.
   */
  it('locks the existing row before deciding what to do with it', async () => {
    const recorder = recordingClient();

    await expect(
      inScope(recorder, (repository) => repository.addMember(TEAM, IVAN, 'LEAD')),
    ).resolves.toEqual({ outcome: 'created', previousRole: null });

    expect(recorder.raw[0]?.sql).toContain('FOR UPDATE');
    // The tenant, the team and the person are all bound values on the locking read, not only on the
    // write that follows it.
    expect(recorder.raw[0]?.values).toEqual(expect.arrayContaining([ORG, TEAM, IVAN]));
  });

  it('names the conflict target by columns, not by the constraint', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.addMember(TEAM, IVAN, 'LEAD'));

    // `uq_team_members` is a unique *index*, which `pg_constraint` does not carry, so
    // `ON CONFLICT ON CONSTRAINT` would fail at parse time on every call rather than only on a
    // conflict. Column inference matches the index instead.
    expect(recorder.raw[1]?.sql).toContain('ON CONFLICT (team_id, user_id) DO UPDATE');
    expect(recorder.raw[1]?.sql).not.toContain('ON CONSTRAINT');
    // Full binding, not one field: `toContain(ORG)` alone would still pass if `TEAM` or `IVAN` fell
    // out of the statement, and a tenant predicate that lost the team or the person is exactly the
    // defect `rules/testing.mdc` («Тест, который не видели красным», п. 2) singles out — the pin
    // has to name every bound value the write actually depends on.
    expect(recorder.raw[1]?.values).toEqual(expect.arrayContaining([ORG, TEAM, IVAN, 'LEAD']));
  });

  it('reports unchanged, and writes nothing, when the pair already holds this exact role', async () => {
    const recorder = recordingClient({ queryRaw: [[{ team_role: 'MEMBER' }]] });

    await expect(
      inScope(recorder, (repository) => repository.addMember(TEAM, IVAN, 'MEMBER')),
    ).resolves.toEqual({ outcome: 'unchanged', previousRole: null });

    // Only the locking `SELECT` was sent — no `INSERT`/`ON CONFLICT` for a role that did not change.
    expect(recorder.raw).toHaveLength(1);
  });

  /** The fix itself: a role held already, asked for again with a different value, actually moves. */
  it('reports role_changed, with the role it replaces, when the pair holds a different one', async () => {
    const recorder = recordingClient({ queryRaw: [[{ team_role: 'MEMBER' }]] });

    await expect(
      inScope(recorder, (repository) => repository.addMember(TEAM, IVAN, 'LEAD')),
    ).resolves.toEqual({ outcome: 'role_changed', previousRole: 'MEMBER' });

    expect(recorder.raw[1]?.sql).toContain('SET team_role = EXCLUDED.team_role');
    // The gate's docstring promise, pinned in SQL rather than only in the TypeScript check above
    // this statement: a second writer that reaches this table directly — a migration, an import
    // job, anything that is not this port — must still find a no-op guard on an unchanged role, or
    // `updated_at` moves on every call regardless of whether anything about the row did.
    expect(recorder.raw[1]?.sql).toContain('WHERE team_members.team_role <> EXCLUDED.team_role');
  });

  it('scopes the removal to the tenant and reports whether a row went', async () => {
    const recorder = recordingClient();

    await expect(
      inScope(recorder, (repository) => repository.removeMember(TEAM, IVAN)),
    ).resolves.toBe(true);

    expect(whereOf(recorder, 'teamMember.deleteMany')).toEqual({
      organizationId: ORG,
      teamId: TEAM,
      userId: IVAN,
    });
  });

  it('reports nothing removed when there was no membership', async () => {
    const recorder = recordingClient({ removed: 0 });

    await expect(
      inScope(recorder, (repository) => repository.removeMember(TEAM, IVAN)),
    ).resolves.toBe(false);
  });

  it('reads the subject inside the tenant and excludes deleted accounts, under a share lock', async () => {
    const recorder = recordingClient({ queryRaw: [[{ id: IVAN, status: 'SUSPENDED' }]] });

    await expect(inScope(recorder, (repository) => repository.subject(IVAN))).resolves.toEqual({
      userId: IVAN,
      status: 'SUSPENDED',
    });

    // `FOR SHARE`, not a plain read — the gate's M-1, symmetric with `scope()`: this is what keeps a
    // membership `INSERT` later in the same transaction from landing after offboarding has already
    // suspended the account and deleted its memberships.
    expect(recorder.raw[0]?.sql).toContain('FOR SHARE');
    expect(recorder.raw[0]?.sql).toContain('deleted_at IS NULL');
    expect(recorder.raw[0]?.values).toEqual(expect.arrayContaining([ORG, IVAN]));
  });

  it('answers null for a subject the tenant cannot see', async () => {
    const recorder = recordingClient();

    await expect(inScope(recorder, (repository) => repository.subject(IVAN))).resolves.toBeNull();
  });
});

describe('invalidating the folded permission view', () => {
  it('is one statement over an array, whatever the size of the team', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.bumpPermissionsVersionOf([IVAN, TEAM]));

    expect(recorder.raw).toHaveLength(1);
    expect(recorder.raw[0]?.sql).toContain('= ANY(');
    // The tenant predicate is on the statement, not only on the policy.
    expect(recorder.raw[0]?.values).toContain(ORG);
  });

  it('sends nothing for an empty list', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.bumpPermissionsVersionOf([]));

    // `id = ANY('{}')` matches nothing, so the statement would be harmless — and still a round trip
    // inside a transaction, issued every time a team nobody was on is disbanded.
    expect(recorder.raw).toEqual([]);
  });
});
