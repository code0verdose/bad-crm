import { describe, expect, it } from 'vitest';

import { PrismaOwnershipRepository } from '@/infrastructure/persistence/prisma/ownership.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Ownership through Prisma, with the driver replaced by a recorder.
 *
 * The decisions worth pinning are the ones a live database would accept just as happily if they were
 * wrong:
 *
 *   * **the root is repointed by a guarded statement, and first.** `organization.updateMany` carries
 *     `ownerId: fromUserId` in its `where`, not only `id` — that predicate is the whole defence
 *     against two transfers racing off the same owner (`test/integration/db/ownership-transfer.test.ts`
 *     is where it is proven against a real Postgres; what a recorder can prove is that the statement
 *     carries the right shape, and first, before anything else is queried or written);
 *   * **a `count` other than `1` is a conflict, not a silent no-op.** The caller's `fromUserId` was
 *     stale — somebody else's transfer already moved the root — and this is where that becomes a
 *     refusal instead of an organization with an inconsistent `owner` role;
 *   * **the recipient is granted before the previous owner is stripped.** Invisible from outside —
 *     the transaction commits whole or not at all — but it is the order a reader of a partial log
 *     would want, and the reverse would read as «the organization had no owner for a moment»;
 *   * **both versions are bumped in one statement.** The recipient needs the new authority on their
 *     next request; the outgoing owner's live token still claims one they gave away;
 *   * **a missing system role fails loudly.** Handing the organization to somebody and leaving them
 *     without the role is worse than refusing.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const FROM = '018f4a3b-0000-7000-8000-0000000000a2';
const TO = '018f4a3b-0000-7000-8000-0000000000a3';

interface Recorder {
  readonly calls: { name: string; args: Record<string, unknown> }[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (
  state: {
    roles?: { id: string; key: string }[];
    organization?: unknown;
    account?: unknown;
    /** How many rows the guarded root repoint claims to have matched. Defaults to the success case. */
    claimedRoot?: number;
  } = {},
): Recorder => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const record =
    <T>(name: string, result: T) =>
    (args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ name, args });

      return Promise.resolve(result);
    };

  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    organization: {
      findFirst: record('organization.findFirst', state.organization ?? null),
      updateMany: record('organization.updateMany', { count: state.claimedRoot ?? 1 }),
    },
    user: {
      findFirst: record('user.findFirst', state.account ?? null),
      updateMany: record('user.updateMany', { count: 2 }),
    },
    role: {
      findMany: record(
        'role.findMany',
        state.roles ?? [
          { id: 'role-owner', key: 'owner' },
          { id: 'role-admin', key: 'admin' },
        ],
      ),
    },
    userRole: {
      createMany: record('userRole.createMany', { count: 2 }),
      deleteMany: record('userRole.deleteMany', { count: 1 }),
    },
  };

  return {
    calls,
    base: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const inScope = async <T>(
  recorder: Recorder,
  work: (repository: PrismaOwnershipRepository) => Promise<T>,
): Promise<T> =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    work(new PrismaOwnershipRepository()),
  );

const argsOf = (recorder: Recorder, name: string): Record<string, unknown> =>
  (recorder.calls.find((call) => call.name === name)?.args ?? {}) as Record<string, unknown>;

const handOver = { fromUserId: FROM, toUserId: TO, previousOwnerRoleKey: 'admin' };

describe('reading who holds the organization', () => {
  it('answers the owner of the current scope', async () => {
    const recorder = recordingClient({ organization: { ownerId: FROM } });

    expect(await inScope(recorder, (repository) => repository.currentOwnerId())).toBe(FROM);
    expect(argsOf(recorder, 'organization.findFirst')['where']).toEqual({
      id: ORG,
      deletedAt: null,
    });
  });

  it('answers null for a soft-deleted organization rather than its last owner', async () => {
    const recorder = recordingClient({ organization: null });

    expect(await inScope(recorder, (repository) => repository.currentOwnerId())).toBeNull();
  });

  it('answers null for a candidate of another organization', async () => {
    const recorder = recordingClient({ account: null });

    expect(await inScope(recorder, (repository) => repository.candidate(TO))).toBeNull();
    expect(argsOf(recorder, 'user.findFirst')['where']).toEqual({
      organizationId: ORG,
      id: TO,
      deletedAt: null,
    });
  });

  it('carries the candidate’s status, which is what decides the refusal', async () => {
    const recorder = recordingClient({ account: { id: TO, status: 'SUSPENDED' } });

    expect(await inScope(recorder, (repository) => repository.candidate(TO))).toEqual({
      userId: TO,
      status: 'SUSPENDED',
    });
  });
});

describe('handing the organization over', () => {
  it('claims the root first, and grants before it strips', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.transfer(handOver));

    expect(recorder.calls.map((call) => call.name)).toEqual([
      'organization.updateMany',
      'role.findMany',
      'userRole.createMany',
      'userRole.deleteMany',
      'user.updateMany',
    ]);
  });

  it('repoints the root only if the row still names the caller’s `fromUserId`', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.transfer(handOver));

    expect(argsOf(recorder, 'organization.updateMany')).toEqual({
      where: { id: ORG, ownerId: FROM },
      data: { ownerId: TO },
    });
  });

  /**
   * The regression test for the race a live database proves at
   * `test/integration/db/ownership-transfer.test.ts`: this file cannot make two transactions race
   * each other, but it can pin that the repository *reacts* correctly to the one signal Postgres
   * would send it — a conditional `UPDATE` that matched nothing.
   */
  it('refuses as a conflict when the guarded update claims no row', async () => {
    const recorder = recordingClient({ claimedRoot: 0 });

    await expect(
      inScope(recorder, (repository) => repository.transfer(handOver)),
    ).rejects.toMatchObject({ code: 'stale_version', status: 409 });
    // Nothing past the guard ran: a transfer that lost the race must not touch a single role.
    expect(recorder.calls.map((call) => call.name)).toEqual(['organization.updateMany']);
  });

  it('gives the recipient `owner` and the previous holder the role they chose', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.transfer(handOver));

    expect(argsOf(recorder, 'userRole.createMany')['data']).toEqual([
      { organizationId: ORG, userId: TO, roleId: 'role-owner' },
      { organizationId: ORG, userId: FROM, roleId: 'role-admin' },
    ]);
    // Already holding the fallback is not a failure: an administrator promoted to owner keeps their
    // `admin` row, and a re-run must not collide.
    expect(argsOf(recorder, 'userRole.createMany')['skipDuplicates']).toBe(true);
  });

  it('takes `owner` off the previous holder and nothing else', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.transfer(handOver));

    expect(argsOf(recorder, 'userRole.deleteMany')['where']).toEqual({
      organizationId: ORG,
      userId: FROM,
      roleId: 'role-owner',
    });
  });

  it('bumps both versions in one statement', async () => {
    const recorder = recordingClient();

    await inScope(recorder, (repository) => repository.transfer(handOver));

    expect(argsOf(recorder, 'user.updateMany')).toEqual({
      where: { organizationId: ORG, id: { in: [FROM, TO] } },
      data: { permissionsVersion: { increment: 1 } },
    });
  });

  it('refuses loudly when the organization has no such system role', async () => {
    // A provisioned organization always has them; one that does not is a broken installation, and
    // handing it over anyway would leave somebody owning it with no role at all.
    const recorder = recordingClient({ roles: [{ id: 'role-owner', key: 'owner' }] });

    await expect(inScope(recorder, (repository) => repository.transfer(handOver))).rejects.toThrow(
      /no `admin` role/,
    );
    expect(recorder.calls.map((call) => call.name)).toEqual([
      'organization.updateMany',
      'role.findMany',
    ]);
  });
});
