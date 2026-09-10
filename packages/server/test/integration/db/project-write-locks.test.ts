import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { PrismaProjectMemberRepository } from '@/infrastructure/persistence/prisma/project-member.repository.js';
import { PrismaProjectRepository } from '@/infrastructure/persistence/prisma/project.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

import {
  asMaintenance,
  closePools,
  createPools,
  insertOrganizationWithOwner,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * The write lock of a project, measured rather than reasoned about — the gate's note on step 3 of
 * EPIC-014, and `rules/agent-orchestration.mdc` A.4.4 («замер вместо предположения»).
 *
 * The note said: a writer of the `projects` row must take `FOR UPDATE`, not `scope()`'s
 * `FOR SHARE`, or two concurrent edits of one project deadlock on the share-lock upgrade. Both
 * shapes are run here against a real PostgreSQL, with the two transactions held at a barrier so
 * that both have taken their first lock before either writes:
 *
 * 1. **the trap** — `scope()` then `update()` in both: exactly one transaction is refused with a
 *    deadlock, because each waits for the other's share lock to go away before its own `UPDATE`
 *    can take the exclusive one;
 * 2. **the fix** — `lockForWrite()` then `update()` in both: the second `FOR UPDATE` waits for the
 *    first transaction to commit, both succeed, and the second one *reads the first one's write*
 *    (`READ COMMITTED` re-reads the row once the lock is granted) — the serialization the
 *    use-cases rely on for «the last lead» and for every audit `before`.
 *
 * Plus the two facts about the lock read itself that a recorder cannot prove: the tenant policy
 * hides another organization's row from it, and a deleted row comes back flagged, not hidden.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();

/** `deadlock_detected` — the SQLSTATE PostgreSQL answers the loser of a deadlock with. */
const DEADLOCK = '40P01';

interface Seeded {
  readonly ownerId: string;
  readonly ivanId: string;
  readonly projectId: string;
  readonly foreignProjectId: string;
}

let seeded: Seeded;

const insertUser = async (client: PoolClient, organizationId: string): Promise<string> => {
  const userId = randomUUID();

  await client.query(
    `INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'placeholder-not-a-credential', 'ACTIVE', now())`,
    [userId, organizationId, `member-${userId.slice(0, 8)}@example.test`],
  );

  return userId;
};

const insertProject = async (
  client: PoolClient,
  organizationId: string,
  key: string,
  leadId: string,
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO projects (organization_id, key, name, lead_id, color, updated_at)
     VALUES ($1::uuid, $2, $2, $3::uuid, 'indigo', now())
     RETURNING id`,
    [organizationId, key, leadId],
  );

  return rows[0]?.id ?? '';
};

const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `locks-${ORG.slice(0, 8)}`,
    });
    const { ownerId: foreignOwnerId } = await insertOrganizationWithOwner(client, OTHER_ORG, {
      slug: `other-${OTHER_ORG.slice(0, 8)}`,
    });

    return {
      ownerId,
      ivanId: await insertUser(client, ORG),
      projectId: await insertProject(client, ORG, 'BAD', ownerId),
      foreignProjectId: await insertProject(client, OTHER_ORG, 'THEIRS', foreignOwnerId),
    };
  });

const inTenant = <T>(work: (repository: PrismaProjectRepository) => Promise<T>): Promise<T> =>
  withTenant(prisma, { organizationId: ORG, userId: null }, () =>
    work(new PrismaProjectRepository()),
  );

const patch = (name: string) => ({
  name,
  description: null,
  leadId: seeded.ownerId,
  startedAt: null,
  dueAt: null,
  color: 'indigo',
});

/**
 * Two transactions racing for one row, held at a barrier so that the measurement does not depend
 * on scheduling luck.
 *
 * The barrier differs by lock mode, and the difference is the whole point:
 *
 * - `'after-read'` — both writers wait until **both reads have returned** before either writes.
 *   Possible only when the reads do not exclude each other: two `FOR SHARE` are granted together,
 *   and the trap springs on the writes.
 * - `'on-issue'` — the second writer sends its read only once the first one's read has
 *   **returned**, so the first holds the lock before the second asks for it; the first then waits
 *   until the second has **sent** its read, writes and commits. Under `FOR UPDATE` the second read
 *   cannot return before that commit — waiting for it would be the test deadlocking itself, which
 *   is what the first draft of this file did. The second draft let both reads go at once and
 *   assumed the first would win the lock; the connection pool hands out connections in no promised
 *   order, and on the run where the second won, its read answered the seed and the assertion
 *   failed while the serialization it measures was working. The order is now imposed, not assumed.
 */
const raceTwoWriters = async (
  read: (repository: PrismaProjectRepository) => Promise<unknown>,
  barrier: 'after-read' | 'on-issue',
): Promise<{ readonly outcomes: PromiseSettledResult<string>[]; readonly secondRead: unknown }> => {
  let returned = 0;
  let issued = 0;
  let releaseReturned: () => void = () => undefined;
  let releaseIssued: () => void = () => undefined;
  let releaseFirstReturned: () => void = () => undefined;
  const bothReturned = new Promise<void>((resolve) => {
    releaseReturned = resolve;
  });
  const bothIssued = new Promise<void>((resolve) => {
    releaseIssued = resolve;
  });
  const firstReturned = new Promise<void>((resolve) => {
    releaseFirstReturned = resolve;
  });
  let secondRead: unknown;

  const writer = (name: string, second: boolean): Promise<string> =>
    inTenant(async (repository) => {
      // Under the lock, the second writer asks for the row only once the first one holds it.
      if (barrier === 'on-issue' && second) await firstReturned;

      issued += 1;
      if (issued === 2) releaseIssued();

      const row = await read(repository);

      if (second) secondRead = row;
      else releaseFirstReturned();

      returned += 1;
      if (returned === 2) releaseReturned();

      if (barrier === 'after-read') {
        await bothReturned;
      } else if (!second) {
        // Let the second writer's `SELECT … FOR UPDATE` reach the server and queue behind this
        // transaction's lock before this one writes; a wait for its *return* would never end.
        await bothIssued;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      await repository.update(seeded.projectId, patch(name));

      return name;
    });

  const outcomes = await Promise.allSettled([writer('first', false), writer('second', true)]);

  return { outcomes, secondRead };
};

const nameOf = async (projectId: string): Promise<string | undefined> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      `SELECT name FROM projects WHERE id = $1::uuid`,
      [projectId],
    );

    return rows[0]?.name;
  });

const sqlStateOf = (outcome: PromiseSettledResult<string>): string | undefined => {
  if (outcome.status === 'fulfilled') return undefined;

  const reason: unknown = outcome.reason;
  const text =
    reason instanceof Error ? `${reason.message} ${JSON.stringify(reason)}` : String(reason);

  return text.includes(DEADLOCK) ? DEADLOCK : text.includes('deadlock') ? DEADLOCK : undefined;
};

beforeAll(() => {
  pools = createPools();
  prisma = new PrismaClient({ datasourceUrl: inject('databaseUrls').appUser });
});

afterAll(async () => {
  await prisma.$disconnect();
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
  seeded = await seed();
});

describe('two writers of one project', () => {
  /**
   * The trap, sprung on purpose. Both take `FOR SHARE` through `scope()`; the first `UPDATE` waits
   * for the second's share lock, the second `UPDATE` waits for the first's, and PostgreSQL breaks
   * the cycle by refusing one of them with `40P01`. This is the shape every mutation must avoid.
   */
  it('deadlock when both start from scope() FOR SHARE: exactly one writer is refused', async () => {
    const { outcomes } = await raceTwoWriters(
      (repository) => repository.scope(seeded.projectId),
      'after-read',
    );

    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(refused).toHaveLength(1);
    expect(sqlStateOf(refused[0] as PromiseSettledResult<string>)).toBe(DEADLOCK);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  });

  /**
   * The fix, measured: `lockForWrite()` takes `FOR UPDATE` from the first statement, the second
   * writer waits for the first to commit, both succeed — and the second one's read is the first
   * one's write, which is what makes an audit `before` and «the last lead» sound.
   */
  it('CONTROL: serialize when both start from lockForWrite() FOR UPDATE — both succeed, in order', async () => {
    const { outcomes, secondRead } = await raceTwoWriters(
      (repository) => repository.lockForWrite(seeded.projectId),
      'on-issue',
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    // The second read was granted only once the first writer committed, so it saw the first
    // writer's name — and the last write is the second writer's.
    expect(secondRead).toMatchObject({ name: 'first' });
    await expect(nameOf(seeded.projectId)).resolves.toBe('second');
  });
});

describe('the lock read itself', () => {
  it('CONTROL: reads the tenant’s own project, live, with every editable field', async () => {
    await expect(
      inTenant((repository) => repository.lockForWrite(seeded.projectId)),
    ).resolves.toMatchObject({
      projectId: seeded.projectId,
      isDeleted: false,
      key: 'BAD',
      name: 'BAD',
      status: 'ACTIVE',
      visibility: 'PUBLIC_ORG',
      leadId: seeded.ownerId,
      color: 'indigo',
    });
  });

  it('answers null for a project of another organization: the policy hides it from the lock too', async () => {
    await expect(
      inTenant((repository) => repository.lockForWrite(seeded.foreignProjectId)),
    ).resolves.toBeNull();
  });

  it('returns a deleted project flagged rather than hidden', async () => {
    await inTenant((repository) => repository.softDelete(seeded.projectId));

    await expect(
      inTenant((repository) => repository.lockForWrite(seeded.projectId)),
    ).resolves.toMatchObject({ isDeleted: true });
  });
});

describe('invalidating the folded rights of the people concerned', () => {
  const versionOf = async (userId: string): Promise<number> =>
    asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ permissions_version: number }>(
        `SELECT permissions_version FROM users WHERE id = $1::uuid`,
        [userId],
      );

      return rows[0]?.permissions_version ?? -1;
    });

  it('bumps the listed accounts by one, in one statement, and nobody else', async () => {
    const before = await versionOf(seeded.ivanId);
    const untouched = await versionOf(seeded.ownerId);

    await withTenant(prisma, { organizationId: ORG, userId: null }, () =>
      new PrismaProjectMemberRepository().bumpPermissionsVersionOf([seeded.ivanId]),
    );

    await expect(versionOf(seeded.ivanId)).resolves.toBe(before + 1);
    await expect(versionOf(seeded.ownerId)).resolves.toBe(untouched);
  });
});
