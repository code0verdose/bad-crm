import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';

import { PrismaSessionRepository } from '@/infrastructure/persistence/prisma/session.repository.js';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma/unit-of-work.adapter.js';
import { connectDatabase } from '@/infrastructure/persistence/prisma/database.factory.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';

import {
  asMaintenance,
  asTenant,
  closePools,
  createPools,
  insertOrganizationWithOwner,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * Rotation under concurrency, against a real PostgreSQL.
 *
 * This is the one property of EPIC-006 that no in-memory double can establish. `FakeSessions`
 * serialises everything through one JavaScript object, so "only one of two rotations wins" holds
 * there by construction — it would hold just as well for a read-then-write implementation. Against a
 * server with two connections and READ COMMITTED it holds only if the statement is what the port
 * promises: `UPDATE … WHERE id = $1 AND revoked_at IS NULL`.
 *
 * The failure this rules out is not an abstraction. Two tabs refreshing at the same moment is
 * ordinary; if both won, two live sessions would exist for one spent token, and the reuse detection
 * the whole epic is built on would start reporting thefts that never happened — or, worse, stop
 * noticing the ones that did.
 */

const NOW = new Date('2026-07-29T10:00:00.000Z');

/**
 * How many extra sessions the index test seeds into one organization.
 *
 * Enough that a sequential scan is genuinely the more expensive plan and the planner has a choice
 * to get wrong — measured on PostgreSQL 16, the sequential scan already loses at 500 rows, and 2 000
 * leaves margin without making the suite slow (~80 ms to seed).
 */
const NOISE_SESSIONS = 2_000;

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

let pools: HarnessPools;
let database: ReturnType<typeof connectDatabase>;
let unitOfWork: PrismaUnitOfWork;

const sessions = new PrismaSessionRepository();

interface Fixture {
  readonly organizationId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly familyId: string;
}

/** An organization with one account and one live session, seeded as the owner. */
const seed = async (): Promise<Fixture> => {
  const organizationId = randomUUID();
  const familyId = randomUUID();

  return asMaintenance(pools.owner, async (client) => {
    await insertOrganizationWithOwner(client, organizationId, { name: 'Bad Company' });

    const { rows: users } = await client.query<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, status, updated_at)
         VALUES ($1, $2, 'placeholder-not-a-credential', 'ACTIVE', now())
       RETURNING id`,
      [organizationId, `ada-${organizationId.slice(0, 8)}@example.test`],
    );

    const userId = users[0]?.id ?? '';

    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO sessions (organization_id, user_id, family_id, refresh_token_hash, user_agent,
                             ip_hash, ip_masked, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, 'integration-suite', 'hmac', '203.0.113.0/24',
                 now() + interval '30 days', now())
       RETURNING id`,
      [organizationId, userId, familyId, randomBytes(32)],
    );

    return { organizationId, userId, sessionId: created[0]?.id ?? '', familyId };
  });
};

const scopeOf = (fixture: Fixture): { organizationId: string; userId: string } => ({
  organizationId: fixture.organizationId,
  userId: fixture.userId,
});

beforeAll(() => {
  pools = createPools();
  database = connectDatabase({ url: inject('databaseUrls').appUser, logger: silentLogger });
  unitOfWork = new PrismaUnitOfWork(database.base);
});

afterAll(async () => {
  await database.close();
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
});

describe('rotating a refresh token concurrently', () => {
  it('CONTROL: one rotation on its own succeeds', async () => {
    const fixture = await seed();

    await expect(
      unitOfWork.withTenant(scopeOf(fixture), () => sessions.markRotated(fixture.sessionId, NOW)),
    ).resolves.toBe(true);
  });

  /**
   * The property at the level it is actually decided: two connections, interleaved by hand.
   *
   * Both read the row before either writes — the order a read-then-write implementation would
   * produce — and only then do they attempt the update. With the statement the port promises, the
   * second `UPDATE` blocks on the row lock the first took and, when it is released, no longer
   * matches: `revoked_at IS NULL` is false. It reports zero rows.
   *
   * This is written against `pg` rather than through the repository on purpose. Prisma serialises
   * interactive transactions, so `Promise.all` over two `withTenant` calls does **not** interleave
   * them — the test below it passes for a read-then-write implementation too, and would be a test of
   * the client's queue rather than of the statement. Measured, not assumed.
   */
  it('refuses the second update even when both transactions read the row first', async () => {
    const fixture = await seed();
    const first = await pools.app.connect();
    const second = await pools.app.connect();

    const spend = async (client: typeof first): Promise<number> => {
      const { rowCount } = await client.query(
        `UPDATE sessions
            SET revoked_at = $2, revoked_reason = 'ROTATED'::session_revoked_reason
          WHERE id = $1::uuid
            AND revoked_at IS NULL`,
        [fixture.sessionId, NOW],
      );

      return rowCount ?? 0;
    };

    try {
      for (const client of [first, second]) {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1, $2, true)', [
          'app.organization_id',
          fixture.organizationId,
        ]);
        // Both read before either writes — the interleaving a read-then-write loses on.
        await client.query('SELECT revoked_at FROM sessions WHERE id = $1', [fixture.sessionId]);
      }

      const winner = await spend(first);
      const pending = spend(second);

      await first.query('COMMIT');

      const loser = await pending;

      await second.query('COMMIT');

      expect(winner).toBe(1);
      expect(loser).toBe(0);
    } finally {
      first.release();
      second.release();
    }
  });

  /**
   * The same thing through the repository. It passes for a read-then-write implementation as well —
   * Prisma serialises interactive transactions — so it is kept as a regression guard over the port's
   * contract rather than as the proof, which is the test above.
   */
  it('lets exactly one of two concurrent transactions spend it', async () => {
    const fixture = await seed();

    const results = await Promise.all([
      unitOfWork.withTenant(scopeOf(fixture), () => sessions.markRotated(fixture.sessionId, NOW)),
      unitOfWork.withTenant(scopeOf(fixture), () => sessions.markRotated(fixture.sessionId, NOW)),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('leaves the row spent exactly once, with the rotation reason', async () => {
    const fixture = await seed();

    await Promise.all(
      Array.from({ length: 5 }, () =>
        unitOfWork.withTenant(scopeOf(fixture), () => sessions.markRotated(fixture.sessionId, NOW)),
      ),
    );

    const { rows } = await asMaintenance(pools.owner, (client) =>
      client.query<{ revoked_at: Date; revoked_reason: string }>(
        'SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1',
        [fixture.sessionId],
      ),
    );

    expect(rows[0]?.revoked_reason).toBe('ROTATED');
    expect(rows[0]?.revoked_at).toEqual(NOW);
  });

  it('cannot be spent again after it was', async () => {
    const fixture = await seed();

    await unitOfWork.withTenant(scopeOf(fixture), () =>
      sessions.markRotated(fixture.sessionId, NOW),
    );

    await expect(
      unitOfWork.withTenant(scopeOf(fixture), () => sessions.markRotated(fixture.sessionId, NOW)),
    ).resolves.toBe(false);
  });
});

describe('revoking a family', () => {
  /** One indexed `UPDATE` over `family_id`, not a walk of the rotation chain. */
  it('closes every live row of the family in one statement', async () => {
    const fixture = await seed();

    // Two more rotations of the same family, as the refresh path would have written them.
    const extra = await unitOfWork.withTenant(scopeOf(fixture), async () => {
      const first = await sessions.create({
        userId: fixture.userId,
        familyId: fixture.familyId,
        rotatedFromId: fixture.sessionId,
        refreshTokenHash: randomBytes(32),
        userAgent: 'integration-suite',
        ipHash: 'hmac',
        ipMasked: '203.0.113.0/24',
        expiresAt: new Date(NOW.getTime() + 30 * 24 * 3600 * 1000),
      });

      return first;
    });

    expect(extra).not.toBeNull();

    await expect(
      unitOfWork.withTenant(scopeOf(fixture), () =>
        sessions.revokeFamily(fixture.familyId, 'REUSE_DETECTED', NOW),
      ),
    ).resolves.toBe(2);

    const { rows } = await asMaintenance(pools.owner, (client) =>
      client.query<{ revoked_reason: string }>(
        'SELECT revoked_reason FROM sessions WHERE family_id = $1',
        [fixture.familyId],
      ),
    );

    expect(rows.map((row) => row.revoked_reason)).toEqual(['REUSE_DETECTED', 'REUSE_DETECTED']);
  });

  it('counts nothing on a repeat, so a second reuse does not inflate the number', async () => {
    const fixture = await seed();

    await unitOfWork.withTenant(scopeOf(fixture), () =>
      sessions.revokeFamily(fixture.familyId, 'REUSE_DETECTED', NOW),
    );

    await expect(
      unitOfWork.withTenant(scopeOf(fixture), () =>
        sessions.revokeFamily(fixture.familyId, 'REUSE_DETECTED', NOW),
      ),
    ).resolves.toBe(0);
  });

  /**
   * The tenant boundary, over the one operation that addresses rows by a value the caller supplies.
   * A family of another organization is not "refused" — it is invisible, which is what the policy
   * does and what makes the answer indistinguishable from a family that does not exist.
   */
  it('cannot touch a family of another organization', async () => {
    const mine = await seed();
    const theirs = await seed();

    await expect(
      unitOfWork.withTenant(scopeOf(mine), () =>
        sessions.revokeFamily(theirs.familyId, 'REUSE_DETECTED', NOW),
      ),
    ).resolves.toBe(0);

    const { rows } = await asMaintenance(pools.owner, (client) =>
      client.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM sessions WHERE id = $1', [
        theirs.sessionId,
      ]),
    );

    expect(rows[0]?.revoked_at).toBeNull();
  });

  /**
   * And it has to be *fast*, because revoking a family is the response to a stolen token.
   *
   * `revokeFamily` filters by `family_id` alone — the user is not known at that point, the reuse was
   * detected from the digest — and row-level security adds `organization_id`. So the predicate is
   * `(organization_id, family_id)` and nothing else.
   *
   * WHAT GOES WRONG WITHOUT `idx_sessions_org_family`, precisely.
   *
   * `idx_sessions_org_user_family (organization_id, user_id, family_id)` is not unusable for this
   * predicate — and that is the trap. PostgreSQL happily attaches `family_id` to the scan as a
   * **non-boundary** index qual: the plan reads
   * `Index Cond: ((organization_id = …) AND (family_id = …))`, with no `Filter` in sight. What it
   * cannot do is *position* on it. `user_id` sits between the two columns the statement supplies, so
   * the scan starts at the first entry of the organization and walks **every** one of them, testing
   * `family_id` on each. The planner costs that honestly, finds it worse than reading the heap, and
   * picks a sequential scan.
   *
   * The visible symptom is therefore a `Seq Scan`, never a `Filter: family_id` — which is why the
   * assertions this test used to carry (`Index Cond` contains `family_id`, `Filter` does not) held
   * with the index dropped and proved nothing. Reproduced on PostgreSQL 16
   * (pgvector/pgvector:0.8.5-pg16) with the index removed and `enable_seqscan = off`:
   * `Index Scan using idx_sessions_org_user_family … Index Cond: ((organization_id = …) AND
   * (family_id = …))`, cost 1092.43 against 8.32 for the two-column index.
   *
   * Hence the shape below: enough rows for the choice to be a real one, the planner's own settings,
   * and an assertion on which index answers. Measured here with 2 000 sessions in one organization —
   * `Seq Scan on sessions, Rows Removed by Filter: 1 999` without the index, `Index Scan using
   * idx_sessions_org_family` with it.
   */
  it('revokes a family through the two-column index rather than a scan of the organization', async () => {
    const fixture = await seed();

    await asMaintenance(pools.owner, async (client) => {
      await client.query(
        `INSERT INTO sessions (organization_id, user_id, family_id, refresh_token_hash, user_agent,
                               ip_hash, ip_masked, expires_at, updated_at)
         SELECT $1, $2, gen_random_uuid(), sha256(g::text::bytea), 'integration-suite', 'hmac',
                '203.0.113.0/24', now() + interval '30 days', now()
           FROM generate_series(1, $3::int) g`,
        [fixture.organizationId, fixture.userId, NOISE_SESSIONS],
      );
      // Without statistics the planner guesses, and a guess is not the decision under test.
      await client.query('ANALYZE sessions');
    });

    const plan = await asTenant(pools.app, fixture.organizationId, async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) UPDATE sessions
            SET revoked_at = now(), revoked_reason = 'REUSE_DETECTED'
          WHERE family_id = $1::uuid AND revoked_at IS NULL`,
        [fixture.familyId],
      );

      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });

    expect(
      plan,
      `revoking a family reads every session of the organization — (organization_id, family_id) ` +
        `is not served by an index of its own:\n${plan}`,
    ).not.toMatch(/Seq Scan on sessions/);
    expect(plan, `the two-column index was not the one chosen:\n${plan}`).toMatch(
      /Index Scan using idx_sessions_org_family on sessions/,
    );
  });

  /**
   * The same guard for the statement a password change runs, which is the one with no upper bound on
   * how much it touches.
   *
   * `revokeAllFamilies` closes every session of one person — after a password change, and after a
   * reset. It filters on `user_id` alone, and `idx_sessions_org_user_family` starts with
   * `organization_id`, so under RLS the tenant predicate supplies that column and the index is usable.
   * Whether the planner *uses* it is not something the behavioural tests can see: measured with the
   * index dropped, the statement returns exactly the same count from a `Seq Scan on sessions,
   * Rows Removed by Filter: 39 900` — right answer, whole table read, every test still green.
   *
   * That matters more here than for a single family because the row count grows with the installation
   * rather than with the session: this is the statement that runs while somebody waits for their
   * password change to answer.
   */
  it('revokes every family of one person through an index rather than a scan', async () => {
    const fixture = await seed();

    // The noise belongs to a **different** person in the same organization, and it has to: with the
    // target's own sessions filling the table, a sequential scan is the correct plan and asserting
    // against it would be asserting a falsehood. The index only earns its keep when one person's
    // sessions are a small share of the tenant's — which is what an installation looks like.
    await asMaintenance(pools.owner, async (client) => {
      const { rows: others } = await client.query<{ id: string }>(
        `INSERT INTO users (organization_id, email, password_hash, status, updated_at)
           VALUES ($1, $2, 'placeholder-not-a-credential', 'ACTIVE', now())
         RETURNING id`,
        [fixture.organizationId, `grace-${fixture.organizationId.slice(0, 8)}@example.test`],
      );

      await client.query(
        `INSERT INTO sessions (organization_id, user_id, family_id, refresh_token_hash, user_agent,
                               ip_hash, ip_masked, expires_at, updated_at)
         SELECT $1, $2, gen_random_uuid(), sha256(g::text::bytea), 'integration-suite', 'hmac',
                '203.0.113.0/24', now() + interval '30 days', now()
           FROM generate_series(1, $3::int) g`,
        [fixture.organizationId, others[0]?.id ?? '', NOISE_SESSIONS],
      );
      await client.query('ANALYZE sessions');
    });

    const plan = await asTenant(pools.app, fixture.organizationId, async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) UPDATE sessions
            SET revoked_at = now(), revoked_reason = 'PASSWORD_CHANGED'
          WHERE user_id = $1::uuid AND revoked_at IS NULL`,
        [fixture.userId],
      );

      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });

    expect(plan, `closing every session of one person reads the whole table:\n${plan}`).not.toMatch(
      /Seq Scan on sessions/,
    );
  });

  /**
   * The positive control for the measurement above: the row count it depends on is really there.
   * A seeding statement that silently inserted nothing would leave the planner with three rows, an
   * index scan by default, and an assertion that passes for the wrong reason.
   */
  it('CONTROL: the plan above is measured against a populated organization', async () => {
    const fixture = await seed();

    await asMaintenance(pools.owner, (client) =>
      client.query(
        `INSERT INTO sessions (organization_id, user_id, family_id, refresh_token_hash, user_agent,
                               ip_hash, ip_masked, expires_at, updated_at)
         SELECT $1, $2, gen_random_uuid(), sha256(g::text::bytea), 'integration-suite', 'hmac',
                '203.0.113.0/24', now() + interval '30 days', now()
           FROM generate_series(1, $3::int) g`,
        [fixture.organizationId, fixture.userId, NOISE_SESSIONS],
      ),
    );

    const { rows } = await asTenant(pools.app, fixture.organizationId, (client) =>
      client.query<{ count: string }>('SELECT count(*)::text AS count FROM sessions'),
    );

    expect(Number(rows[0]?.count)).toBe(NOISE_SESSIONS + 1);
  });
});

describe('writing a session row', () => {
  /**
   * The `23505` that must never reach a client. `uq_sessions_refresh_hash` is global, so a duplicate
   * digest is an answer about another organization — and `ON CONFLICT DO NOTHING` turns it into a
   * `null` the caller retries, rather than into an error that aborts the transaction.
   */
  it('answers null for a digest another organization already holds, without aborting', async () => {
    const mine = await seed();
    const theirs = await seed();
    const shared = randomBytes(32);

    const first = await unitOfWork.withTenant(scopeOf(theirs), () =>
      sessions.create({
        userId: theirs.userId,
        familyId: theirs.familyId,
        rotatedFromId: null,
        refreshTokenHash: shared,
        userAgent: 'integration-suite',
        ipHash: 'hmac',
        ipMasked: '203.0.113.0/24',
        expiresAt: new Date(NOW.getTime() + 30 * 24 * 3600 * 1000),
      }),
    );

    expect(first).not.toBeNull();

    // The same transaction goes on to write a row with a fresh digest, which is exactly what the
    // retry in `IssueSessionUseCase` does — impossible if the collision had raised.
    const outcome = await unitOfWork.withTenant(scopeOf(mine), async () => {
      const collided = await sessions.create({
        userId: mine.userId,
        familyId: mine.familyId,
        rotatedFromId: null,
        refreshTokenHash: shared,
        userAgent: 'integration-suite',
        ipHash: 'hmac',
        ipMasked: '203.0.113.0/24',
        expiresAt: new Date(NOW.getTime() + 30 * 24 * 3600 * 1000),
      });

      const retried = await sessions.create({
        userId: mine.userId,
        familyId: mine.familyId,
        rotatedFromId: null,
        refreshTokenHash: randomBytes(32),
        userAgent: 'integration-suite',
        ipHash: 'hmac',
        ipMasked: '203.0.113.0/24',
        expiresAt: new Date(NOW.getTime() + 30 * 24 * 3600 * 1000),
      });

      return { collided, retried };
    });

    expect(outcome.collided).toBeNull();
    expect(outcome.retried).not.toBeNull();
  });
});
