import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { PrismaMfaRecoveryCodeRepository } from '@/infrastructure/persistence/prisma/mfa-recovery-code.repository.js';
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
 * `PrismaMfaRecoveryCodeRepository.markUsed`, against a real PostgreSQL — the requirement STORY-013-02
 * acceptance 3 states explicitly: "он предъявляется двумя параллельными запросами; ровно один
 * успешен", proven the way `ownership-transfer.test.ts` proves the equivalent claim for a role
 * transfer and `team-membership-race.test.ts` proves it for a membership join — genuine PostgreSQL
 * concurrency under `READ COMMITTED`, not a mock that answers `{ count: 1 }` to anything.
 *
 * A unit test cannot prove this at all: `TenantScopedRepository.run` reaches a real `$queryRaw`, and
 * only a real database can show that `UPDATE ... WHERE used_at IS NULL RETURNING id` genuinely lets
 * exactly one of two concurrent statements match the row.
 */

let pools: HarnessPools;
let prisma: PrismaClient;

const ORG = randomUUID();

interface Seeded {
  readonly userId: string;
  readonly targetCodeId: string;
  readonly siblingCodeId: string;
}

let seeded: Seeded;

const seed = async (): Promise<Seeded> =>
  asMaintenance(pools.owner, async (client) => {
    const { ownerId } = await insertOrganizationWithOwner(client, ORG, {
      slug: `mfa-recovery-${ORG.slice(0, 8)}`,
    });

    // Two codes, so the assertion can show the race decided *this* row and left its sibling alone —
    // "exactly one write happened, and it was the right one" rather than "something happened once".
    const { rows: target } = await client.query<{ id: string }>(
      `INSERT INTO mfa_recovery_codes (organization_id, user_id, code_hash, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, now())
       RETURNING id`,
      [ORG, ownerId, 'not-a-real-argon2id-digest-target'],
    );
    const { rows: sibling } = await client.query<{ id: string }>(
      `INSERT INTO mfa_recovery_codes (organization_id, user_id, code_hash, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, now())
       RETURNING id`,
      [ORG, ownerId, 'not-a-real-argon2id-digest-sibling'],
    );

    return {
      userId: ownerId,
      targetCodeId: target[0]?.id ?? '',
      siblingCodeId: sibling[0]?.id ?? '',
    };
  });

const inTenant = <T>(
  work: (repository: PrismaMfaRecoveryCodeRepository) => Promise<T>,
): Promise<T> =>
  withTenant(prisma, { organizationId: ORG, userId: null }, () =>
    work(new PrismaMfaRecoveryCodeRepository()),
  );

const usedAtOf = async (codeId: string): Promise<Date | null> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ used_at: Date | null }>(
      `SELECT used_at FROM mfa_recovery_codes WHERE id = $1::uuid`,
      [codeId],
    );

    return rows[0]?.used_at ?? null;
  });

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

describe('spending a recovery code', () => {
  it('CONTROL: a single request marks the row used and answers true', async () => {
    const won = await inTenant((repository) =>
      repository.markUsed(seeded.userId, seeded.targetCodeId, new Date()),
    );

    expect(won).toBe(true);
    expect(await usedAtOf(seeded.targetCodeId)).not.toBeNull();
  });

  it('answers false for a code that is already used, and leaves used_at unchanged', async () => {
    await inTenant((repository) =>
      repository.markUsed(seeded.userId, seeded.targetCodeId, new Date()),
    );
    const firstUsedAt = await usedAtOf(seeded.targetCodeId);

    const wonAgain = await inTenant((repository) =>
      repository.markUsed(seeded.userId, seeded.targetCodeId, new Date()),
    );

    expect(wonAgain).toBe(false);
    expect(await usedAtOf(seeded.targetCodeId)).toEqual(firstUsedAt);
  });

  /**
   * The acceptance criterion itself: two callers racing to consume the *same* code — the shape a
   * genuine replay attempt or a double-submitted form takes. `attempt` is fixed before either promise
   * starts, so the assertion does not depend on which of the two PostgreSQL happens to run first —
   * only on the guarded `UPDATE` doing what it claims, whichever one that is
   * (`ownership-transfer.test.ts`'s own reasoning for the identical shape of race).
   */
  it('lets exactly one of two parallel spends of the same code win', async () => {
    const attempt = () =>
      inTenant((repository) => repository.markUsed(seeded.userId, seeded.targetCodeId, new Date()));

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const outcomes = [first, second];

    expect(outcomes.filter((won) => won)).toHaveLength(1);
    expect(outcomes.filter((won) => !won)).toHaveLength(1);
    expect(await usedAtOf(seeded.targetCodeId)).not.toBeNull();
  });

  /**
   * Wider than the pairwise case: ten concurrent requests against the same row, none of them awaited
   * before the next starts. `rate-limiter-flexible` bounds this to five a window in production
   * (`mfa_recovery_consume_attempt`); the database guarantee this test proves has to hold regardless
   * of how many requests get there, because the limiter is a second, independent rubric — not the
   * mechanism the one-code-one-use invariant actually rests on.
   */
  it('lets exactly one of ten concurrent spends of the same code win', async () => {
    const attempts = Array.from({ length: 10 }, () =>
      inTenant((repository) => repository.markUsed(seeded.userId, seeded.targetCodeId, new Date())),
    );

    const outcomes = await Promise.all(attempts);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('never touches a sibling code of the same account', async () => {
    const attempt = () =>
      inTenant((repository) => repository.markUsed(seeded.userId, seeded.targetCodeId, new Date()));

    await Promise.all([attempt(), attempt()]);

    expect(await usedAtOf(seeded.siblingCodeId)).toBeNull();
  });

  /**
   * The `user_id` predicate itself, not just the atomic race it happens to share a statement with.
   * `matchId` in `ConsumeRecoveryCodeUseCase.match` is trusted to belong to the caller because it came
   * from `listUnused(actor.userId)` — but that trust lives in application code, not in a database
   * constraint, and a future bug that resolved the wrong candidate id would otherwise spend a
   * *different* account's code inside the same organization (RLS stops nothing here: both rows share
   * one `organization_id`). This proves the guard the statement itself now provides independently of
   * that trust.
   */
  it('refuses to mark a row used under a different user_id, even inside the same organization', async () => {
    const wrongUserId = randomUUID();

    const won = await inTenant((repository) =>
      repository.markUsed(wrongUserId, seeded.targetCodeId, new Date()),
    );

    expect(won).toBe(false);
    expect(await usedAtOf(seeded.targetCodeId)).toBeNull();
  });
});
