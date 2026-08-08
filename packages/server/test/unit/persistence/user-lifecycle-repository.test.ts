import { describe, expect, it } from 'vitest';

import { PrismaUserLifecycleRepository } from '@/infrastructure/persistence/prisma/user-lifecycle.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * The account lifecycle through Prisma, with the driver replaced by a recorder.
 *
 * What is pinned here is the **shape** of the writes, which is where the decisions live and where a
 * live database would agree with a wrong one just as happily:
 *
 *   * **status and version move in one statement.** A version bumped separately, after the status
 *     change, is a window in which a live access token still passes `AuthenticateSessionQuery` —
 *     and the whole point of offboarding is that there is no such window;
 *   * **the personnel record is updated with `updateMany`.** An account with no record yet has
 *     nothing to terminate, and that is an ordinary case rather than a row to raise about;
 *   * **the memberships come back, not their count.** `team_members` has no `deleted_at`, so the
 *     rows are gone and `team_role` with them — the answer is the only record that they existed;
 *   * **the tenant leads every filter**, taken from the scope rather than from an argument.
 *
 * What a recorder cannot say is whether PostgreSQL accepts any of it. The `DELETE … RETURNING` is
 * raw, and a recorder is happy with SQL no server would parse — so the same statements are run
 * against a real database in `test/integration/db/user-lifecycle-repository.test.ts`.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000f1';
const USER = '018f4a3b-0000-7000-8000-0000000000f2';

interface RawCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface Recorder {
  readonly calls: { name: string; args: Record<string, unknown> }[];
  readonly raw: RawCall[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (
  state: {
    account?: unknown;
    teamsRemoved?: readonly { team_id: string; team_role: string }[];
  } = {},
): Recorder => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const raw: RawCall[] = [];
  const record =
    <T>(name: string, result: T) =>
    (args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ name, args });

      return Promise.resolve(result);
    };

  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    // A tagged template, recorded as the interpolated statement plus the bound values — which is
    // exactly the split that matters: an identifier in `sql`, every tenant and user id in `values`.
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      raw.push({ sql: strings.join('?'), values });

      return Promise.resolve([...(state.teamsRemoved ?? [])]);
    },
    user: {
      findFirst: record('user.findFirst', state.account ?? null),
      update: record('user.update', {}),
    },
    employeeProfile: { updateMany: record('profile.updateMany', { count: 1 }) },
  };

  return {
    calls,
    raw,
    base: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const inScope = async <T>(
  recorder: Recorder,
  work: (repository: PrismaUserLifecycleRepository) => Promise<T>,
): Promise<T> =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    work(new PrismaUserLifecycleRepository()),
  );

const argsOf = (recorder: Recorder, name: string): Record<string, unknown> =>
  (recorder.calls.find((call) => call.name === name)?.args ?? {}) as Record<string, unknown>;

describe('reading the subject', () => {
  it('answers null for an account of another organization', async () => {
    const recorder = recordingClient({ account: null });

    expect(await inScope(recorder, (repository) => repository.byId(USER))).toBeNull();
    expect(argsOf(recorder, 'user.findFirst')['where']).toEqual({
      organizationId: ORG,
      id: USER,
      deletedAt: null,
    });
  });

  it('carries the owner id with the subject, read in the same statement', async () => {
    // Two values that are about to be compared. Fetched separately, an ownership transfer landing
    // between the reads would let the previous owner be deactivated on a fact that had already
    // stopped being true.
    const recorder = recordingClient({
      account: { id: USER, status: 'ACTIVE', organization: { ownerId: 'boss' } },
    });

    expect(await inScope(recorder, (repository) => repository.byId(USER))).toEqual({
      userId: USER,
      status: 'ACTIVE',
      organizationOwnerId: 'boss',
    });
    expect(argsOf(recorder, 'user.findFirst')['select']).toMatchObject({
      organization: { select: { ownerId: true } },
    });
  });
});

describe('switching the account off', () => {
  it('changes the status and the version in one statement', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) =>
      repository.suspend(USER, new Date('2026-08-07T10:00:00.000Z')),
    );

    expect(argsOf(recorder, 'user.update')['data']).toEqual({
      status: 'SUSPENDED',
      permissionsVersion: { increment: 1 },
    });
  });

  it('terminates the personnel record without requiring one to exist', async () => {
    const recorder = recordingClient();
    const at = new Date('2026-08-07T10:00:00.000Z');

    await inScope(recorder, (repository) => repository.suspend(USER, at));

    // `updateMany`, so somebody who accepted an invitation this morning — and has no record yet —
    // is offboarded without a row to raise about.
    expect(recorder.calls.map((call) => call.name)).toContain('profile.updateMany');
    expect(argsOf(recorder, 'profile.updateMany')).toEqual({
      where: { organizationId: ORG, userId: USER },
      data: { terminatedAt: at },
    });
  });

  it('answers which memberships it removed, and in what role, rather than how many', async () => {
    // The rows are deleted outright and `team_role` goes with them. Reactivation restores no
    // membership on purpose, so this list is the only thing whoever re-grants them tomorrow has to
    // read — and the only way back from a mistaken offboarding short of restoring the database.
    const recorder = recordingClient({
      teamsRemoved: [
        { team_id: 'team-platform', team_role: 'LEAD' },
        { team_id: 'team-design', team_role: 'MEMBER' },
      ],
    });

    const removed = await inScope(recorder, (repository) => repository.suspend(USER, new Date()));

    expect(removed).toEqual([
      { teamId: 'team-platform', teamRole: 'LEAD' },
      { teamId: 'team-design', teamRole: 'MEMBER' },
    ]);
  });

  it('removes membership with one statement that returns what it removed', async () => {
    const recorder = recordingClient({ teamsRemoved: [] });

    await inScope(recorder, (repository) => repository.suspend(USER, new Date()));

    const [statement] = recorder.raw;

    expect(statement?.sql).toContain('DELETE FROM team_members');
    // `RETURNING`, because reading first and deleting afterwards is two statements over a set that
    // can change between them — and `deleteMany` cannot return a row at all.
    expect(statement?.sql).toContain('RETURNING team_id, team_role');
    // The tenant leads the filter and both ids are bound, never interpolated.
    expect(statement?.values).toEqual([ORG, USER]);
  });
});

describe('bringing the account back', () => {
  it('clears the termination date and bumps the version again', async () => {
    // The version moves on the way back in as well: the account may have been suspended while a
    // token was in flight, and a returning account whose version never moved would accept it.
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.reactivate(USER));

    expect(argsOf(recorder, 'user.update')['data']).toEqual({
      status: 'ACTIVE',
      permissionsVersion: { increment: 1 },
    });
    expect(argsOf(recorder, 'profile.updateMany')['data']).toEqual({ terminatedAt: null });
  });

  it('scopes both writes to the tenant of the open scope, not to an argument', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.reactivate(USER));

    expect(argsOf(recorder, 'user.update')['where']).toEqual({
      organizationId_id: { organizationId: ORG, id: USER },
    });
    expect(argsOf(recorder, 'profile.updateMany')['where']).toEqual({
      organizationId: ORG,
      userId: USER,
    });
  });

  it('restores no membership: the teams stay left', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.reactivate(USER));

    // Restoring them would be re-granting access on the strength of a state that was correct months
    // ago — an access review that never happened. Asserted against every statement the repository
    // sent, raw ones included, so a membership write added later cannot hide in the SQL.
    expect(recorder.calls.some((call) => call.name.startsWith('team'))).toBe(false);
    expect(recorder.raw).toEqual([]);
  });
});
