import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { ChangePasswordUseCase } from '@/application/identity/use-cases/change-password.use-case.js';
import { ConfirmPasswordResetUseCase } from '@/application/identity/use-cases/confirm-password-reset.use-case.js';
import { RequestPasswordResetUseCase } from '@/application/identity/use-cases/request-password-reset.use-case.js';
import { Argon2PasswordHasher } from '@/infrastructure/crypto/argon2-password-hasher.adapter.js';
import { HmacAddressHasher } from '@/infrastructure/crypto/address-hasher.adapter.js';
import { Sha256ResetTokenAdapter } from '@/infrastructure/crypto/reset-token.adapter.js';
import { ImmediateMailDispatcher } from '@/infrastructure/mail/immediate-mail-dispatcher.adapter.js';
import { type ClosableMailPort } from '@/infrastructure/mail/mail.factory.js';
import { NodemailerMailAdapter } from '@/infrastructure/mail/nodemailer.adapter.js';
import { createSmtpTransport } from '@/infrastructure/mail/smtp-transport.factory.js';
import { UnconfiguredMailAdapter } from '@/infrastructure/mail/unconfigured-mail.adapter.js';
import { PrismaAuthLookup } from '@/infrastructure/persistence/prisma/auth-lookup.adapter.js';
import { createAuthLookupClient } from '@/infrastructure/persistence/prisma/auth-lookup.client.js';
import { connectDatabase } from '@/infrastructure/persistence/prisma/database.factory.js';
import { PrismaPasswordResetTokenRepository } from '@/infrastructure/persistence/prisma/password-reset-token.repository.js';
import { PrismaSessionRepository } from '@/infrastructure/persistence/prisma/session.repository.js';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma/unit-of-work.adapter.js';
import { PrismaUserRepository } from '@/infrastructure/persistence/prisma/user.repository.js';

import {
  asMaintenance,
  closePools,
  createPools,
  insertOrganizationWithOwner,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';
import { FakeClock, FakeRateLimit } from '../../support/identity-doubles.util.js';

/**
 * Password recovery against the two services it actually depends on: a real PostgreSQL and a real
 * SMTP server.
 *
 * Four properties live here and can live nowhere else, because an in-memory double holds each of
 * them by construction and would hold them just as well for a wrong implementation:
 *
 *   1. **the row stores a digest** — the token in the link cannot be found in the table;
 *   2. **the token is spent by one statement** — two interleaved connections under READ COMMITTED,
 *      not two calls into one JavaScript object, so a read-then-write implementation fails here;
 *   3. **the reset really does resolve across the tenant boundary and only through the resolver** —
 *      the `app_auth` connection can call the function and cannot read the table;
 *   4. **a message leaves the process** — Mailpit receives it, and the link in it works.
 *
 * Every block opens with a positive control. A suite that only proves things are unreachable passes
 * on a broken connection.
 *
 * It lives under `test/integration/db` rather than under a directory of its own because it needs the
 * PostgreSQL that project's `globalSetup` already starts, and because its truncation has to be
 * serialised with the rest of that project (`vitest.integration.config.ts`, `fileParallelism`). The
 * Mailpit container is started here: it is cheap and needs no shared bootstrap.
 */

const MAILPIT_IMAGE = 'axllent/mailpit:v1.30.5';
const SMTP_PORT = 1025;
const HTTP_PORT = 8025;
const MAIL_FROM = 'Bad CRM <crm@example.com>';
const APP_URL = 'https://crm.example.com';

const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'staple-generator-lantern';

/** The OWASP floor the hasher enforces; a test may not weaken what production may not weaken. */
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

interface MailpitMessage {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
}

let mailpit: StartedTestContainer;
let mailpitApi: string;
let pools: HarnessPools;
let database: ReturnType<typeof connectDatabase>;
let authClient: ReturnType<typeof createAuthLookupClient>;

const messages = async (): Promise<readonly MailpitMessage[]> => {
  const response = await fetch(`${mailpitApi}/api/v1/messages`);

  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
};

const bodyOf = async (id: string): Promise<string> => {
  const response = await fetch(`${mailpitApi}/api/v1/message/${id}`);

  return ((await response.json()) as { Text: string }).Text;
};

interface Harness {
  readonly request: RequestPasswordResetUseCase;
  readonly confirm: ConfirmPasswordResetUseCase;
  readonly changePassword: ChangePasswordUseCase;
  readonly dispatcher: ImmediateMailDispatcher;
  readonly close: () => Promise<void>;
}

/** `mail: 'unconfigured'` builds the adapter an installation without `SMTP_URL` actually gets. */
const buildHarness = (options: { readonly mail?: 'smtp' | 'unconfigured' } = {}): Harness => {
  const clock = new FakeClock(new Date());
  const unitOfWork = new PrismaUnitOfWork(database.base);
  const lookup = new PrismaAuthLookup(authClient);
  const tokens = new PrismaPasswordResetTokenRepository();
  const users = new PrismaUserRepository();
  const sessions = new PrismaSessionRepository();
  const hasher = new Argon2PasswordHasher(ARGON2);
  const resetTokens = new Sha256ResetTokenAdapter();
  const rateLimit = new FakeRateLimit();
  const mailer: ClosableMailPort =
    options.mail === 'unconfigured'
      ? new UnconfiguredMailAdapter(silentLogger)
      : new NodemailerMailAdapter(
          createSmtpTransport(`smtp://${mailpit.getHost()}:${mailpit.getMappedPort(SMTP_PORT)}`),
          silentLogger,
          MAIL_FROM,
        );
  const dispatcher = new ImmediateMailDispatcher(mailer, silentLogger);

  return {
    dispatcher,
    request: new RequestPasswordResetUseCase(
      lookup,
      tokens,
      resetTokens,
      new HmacAddressHasher(Buffer.alloc(32, 7).toString('base64')),
      unitOfWork,
      rateLimit,
      mailer,
      dispatcher,
      clock,
      silentLogger,
      APP_URL,
    ),
    confirm: new ConfirmPasswordResetUseCase(
      lookup,
      tokens,
      resetTokens,
      users,
      sessions,
      hasher,
      unitOfWork,
      rateLimit,
      clock,
      silentLogger,
    ),
    changePassword: new ChangePasswordUseCase(
      users,
      sessions,
      tokens,
      hasher,
      unitOfWork,
      rateLimit,
      dispatcher,
      clock,
      silentLogger,
      APP_URL,
    ),
    close: async (): Promise<void> => {
      await dispatcher.drain();
      await mailer.close();
    },
  };
};

interface Fixture {
  readonly organizationId: string;
  readonly userId: string;
  readonly email: string;
  readonly families: readonly string[];
}

/** An organization, one account with a real argon2id digest, and three signed-in devices. */
const seed = async (): Promise<Fixture> => {
  const organizationId = randomUUID();
  const email = `ada-${organizationId.slice(0, 8)}@example.test`;
  const families = [randomUUID(), randomUUID(), randomUUID()];
  const passwordHash = await new Argon2PasswordHasher(ARGON2).hash(PASSWORD);

  return asMaintenance(pools.owner, async (client) => {
    await insertOrganizationWithOwner(client, organizationId, { name: 'Bad Company' });

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, status, locale, timezone, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', 'en', 'UTC', now())
       RETURNING id`,
      [organizationId, email, passwordHash],
    );

    const userId = rows[0]?.id ?? '';

    for (const familyId of families) {
      await client.query(
        `INSERT INTO sessions (organization_id, user_id, family_id, refresh_token_hash, user_agent,
                               ip_hash, ip_masked, expires_at, updated_at)
           VALUES ($1, $2, $3, $4, 'integration-suite', 'hmac', '203.0.113.0/24',
                   now() + interval '30 days', now())`,
        [organizationId, userId, familyId, randomBytes(32)],
      );
    }

    return { organizationId, userId, email, families };
  });
};

const liveFamilies = async (userId: string): Promise<string[]> =>
  asMaintenance(pools.owner, async (client) => {
    const { rows } = await client.query<{ family_id: string }>(
      `SELECT DISTINCT family_id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );

    return rows.map((row) => row.family_id).sort();
  });

/**
 * Waits until some `app_user` statement is blocked on a lock, so the interleaving under test is the
 * one the test means rather than whatever the scheduler produced.
 *
 * It gives up rather than failing: a read-then-write implementation blocks on its `UPDATE` too, so
 * the wait is an optimisation of determinism, not the assertion. The assertion is what `consume`
 * answers once the competitor has committed.
 */
const waitForBlockedStatement = async (timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { rows } = await pools.owner.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_stat_activity
        WHERE usename = 'app_user' AND wait_event_type = 'Lock'`,
    );

    if (rows[0]?.count !== '0') return;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** The token out of the message Mailpit received — the path a person's browser takes. */
const tokenFromMailpit = async (): Promise<string> => {
  const received = await messages();
  const text = await bodyOf(received[0]?.ID ?? '');

  return /reset-password\/([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';
};

beforeAll(async () => {
  mailpit = await new GenericContainer(MAILPIT_IMAGE)
    .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: 'true', MP_SMTP_AUTH_ALLOW_INSECURE: 'true' })
    .withExposedPorts(SMTP_PORT, HTTP_PORT)
    .withWaitStrategy(Wait.forHttp('/readyz', HTTP_PORT))
    .start();

  mailpitApi = `http://${mailpit.getHost()}:${mailpit.getMappedPort(HTTP_PORT)}`;

  pools = createPools();
  database = connectDatabase({ url: inject('databaseUrls').appUser, logger: silentLogger });
  authClient = createAuthLookupClient(inject('databaseUrls').auth);
}, 300_000);

afterAll(async () => {
  await authClient.$disconnect();
  await database.close();
  await closePools(pools);
  await mailpit.stop();
});

beforeEach(async () => {
  await truncateAll(pools.owner);
  await fetch(`${mailpitApi}/api/v1/messages`, { method: 'DELETE' });
});

describe('asking for a reset link, end to end', () => {
  it('CONTROL: delivers a message to the address and stores one live token', async () => {
    const fixture = await seed();
    const harness = buildHarness();

    await harness.request.execute({
      email: fixture.email,
      client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
    });
    await harness.dispatcher.drain();

    const received = await messages();

    expect(received).toHaveLength(1);
    expect(received[0]?.To[0]?.Address).toBe(fixture.email);

    const stored = await asMaintenance(pools.owner, (client) =>
      client.query<{ used_at: Date | null }>(
        `SELECT used_at FROM password_reset_tokens WHERE user_id = $1`,
        [fixture.userId],
      ),
    );

    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.used_at).toBeNull();

    await harness.close();
  });

  /**
   * The token is in the mail and its SHA-256 is in the table. Recomputing the digest here is the
   * only version of this assertion worth making: `not.toContain(token)` alone would pass on a row
   * that stored the token base64-encoded.
   */
  it('stores the digest of the token and not the token', async () => {
    const fixture = await seed();
    const harness = buildHarness();

    await harness.request.execute({
      email: fixture.email,
      client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
    });
    await harness.dispatcher.drain();

    const token = await tokenFromMailpit();
    const stored = await asMaintenance(pools.owner, (client) =>
      client.query<{ token_hash: Buffer }>(
        `SELECT token_hash FROM password_reset_tokens WHERE user_id = $1`,
        [fixture.userId],
      ),
    );

    expect(token).not.toBe('');
    expect(stored.rows[0]?.token_hash.toString('hex')).toBe(
      createHash('sha256').update(token, 'utf8').digest('hex'),
    );
    expect(stored.rows[0]?.token_hash.toString('utf8')).not.toContain(token);

    await harness.close();
  });

  it('sends nothing for an address nobody has, and answers the same way', async () => {
    await seed();
    const harness = buildHarness();

    await expect(
      harness.request.execute({
        email: 'nobody@example.test',
        client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
      }),
    ).resolves.toBeUndefined();
    await harness.dispatcher.drain();

    expect(await messages()).toEqual([]);

    await harness.close();
  });
});

describe('spending the link, end to end', () => {
  it('sets the password, spends the token and closes every session', async () => {
    const fixture = await seed();
    const harness = buildHarness();

    expect(await liveFamilies(fixture.userId)).toEqual([...fixture.families].sort());

    await harness.request.execute({
      email: fixture.email,
      client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
    });
    await harness.dispatcher.drain();

    await harness.confirm.execute({
      token: await tokenFromMailpit(),
      newPassword: NEW_PASSWORD,
      client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
    });

    expect(await liveFamilies(fixture.userId)).toEqual([]);

    const after = await asMaintenance(pools.owner, (client) =>
      client.query<{ used_at: Date | null; password_hash: string; revoked_reason: string }>(
        `SELECT t.used_at, u.password_hash,
                (SELECT DISTINCT revoked_reason::text FROM sessions WHERE user_id = u.id)
                  AS revoked_reason
           FROM password_reset_tokens t
           JOIN users u ON u.id = t.user_id
          WHERE t.user_id = $1`,
        [fixture.userId],
      ),
    );

    expect(after.rows[0]?.used_at).not.toBeNull();
    expect(after.rows[0]?.revoked_reason).toBe('PASSWORD_CHANGED');

    const hasher = new Argon2PasswordHasher(ARGON2);

    await expect(hasher.verify(after.rows[0]?.password_hash ?? '', NEW_PASSWORD)).resolves.toBe(
      true,
    );
    await expect(hasher.verify(after.rows[0]?.password_hash ?? '', PASSWORD)).resolves.toBe(false);

    await harness.close();
  });

  /**
   * The race, driven through the **repository**, with the other half of it forced by hand.
   *
   * This is the assertion that separates one conditional `UPDATE` from a read followed by a write,
   * and it took two attempts to write one that does. The first version issued both statements from
   * `pg` and asserted that one of them reported zero rows — which is a test of PostgreSQL, not of
   * this code: it passed unchanged after `consume` was rewritten as
   * `findFirst` + unconditional `UPDATE`, because the repository was never called.
   *
   * So the competitor is `pg` and the subject is the repository. A connection takes the row lock and
   * holds it; `consume` is started and blocks; the competitor commits, having spent the token. With
   * the statement the port promises, `consume` re-evaluates `used_at IS NULL` when the lock is
   * released, matches nothing and answers `null`. With a read-then-write, the read already saw a
   * usable row in the snapshot it took before the commit, and the write that follows has no
   * predicate left to fail — it answers with a user id and a second password is set.
   *
   * Two `Promise.all` calls through Prisma would not reproduce this: Prisma serialises interactive
   * transactions on one client, so the two never interleave and the test becomes an assertion about
   * the client's queue (`test/integration/db/refresh-rotation.test.ts` records the same measurement).
   */
  it('answers null when another connection spent the token first', async () => {
    const fixture = await seed();
    const harness = buildHarness();
    const tokens = new PrismaPasswordResetTokenRepository();
    const unitOfWork = new PrismaUnitOfWork(database.base);

    await harness.request.execute({
      email: fixture.email,
      client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
    });
    await harness.dispatcher.drain();

    const tokenId = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM password_reset_tokens WHERE user_id = $1`,
        [fixture.userId],
      );

      return rows[0]?.id ?? '';
    });

    const competitor = await pools.app.connect();

    let spent: string | null = 'not-run';

    try {
      await competitor.query('BEGIN');
      await competitor.query('SELECT set_config($1, $2, true)', [
        'app.organization_id',
        fixture.organizationId,
      ]);
      // The lock is taken and held: anything the repository sends now waits for this transaction.
      await competitor.query(
        `UPDATE password_reset_tokens SET used_at = now(), updated_at = now() WHERE id = $1`,
        [tokenId],
      );

      const pending = unitOfWork.withTenant(
        { organizationId: fixture.organizationId, userId: fixture.userId },
        () => tokens.consume(tokenId, new Date()),
      );

      await waitForBlockedStatement();
      await competitor.query('COMMIT');

      spent = await pending;
    } finally {
      competitor.release();
    }

    expect(spent).toBeNull();

    const rows = await asMaintenance(pools.owner, (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM password_reset_tokens
          WHERE id = $1 AND used_at IS NOT NULL`,
        [tokenId],
      ),
    );

    expect(rows.rows[0]?.count).toBe('1');

    await harness.close();
  });

  it('lets exactly one of two interleaved spends win', async () => {
    const fixture = await seed();
    const harness = buildHarness();

    await harness.request.execute({
      email: fixture.email,
      client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
    });
    await harness.dispatcher.drain();

    const tokenId = await asMaintenance(pools.owner, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM password_reset_tokens WHERE user_id = $1`,
        [fixture.userId],
      );

      return rows[0]?.id ?? '';
    });

    const spend = async (): Promise<number> => {
      const client = await pools.app.connect();

      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1, $2, true)', [
          'app.organization_id',
          fixture.organizationId,
        ]);
        // Both read first, which is exactly what a read-then-write implementation does.
        await client.query(`SELECT used_at FROM password_reset_tokens WHERE id = $1`, [tokenId]);

        const result = await client.query(
          `UPDATE password_reset_tokens
              SET used_at = now(), updated_at = now()
            WHERE id = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING user_id`,
          [tokenId],
        );

        await client.query('COMMIT');

        return result.rowCount ?? 0;
      } finally {
        client.release();
      }
    };

    const [first, second] = await Promise.all([spend(), spend()]);

    expect([first, second].filter((rows) => rows === 1)).toHaveLength(1);
    expect([first, second].filter((rows) => rows === 0)).toHaveLength(1);

    await harness.close();
  });

  it('refuses the same link a second time, and refuses an unknown one the same way', async () => {
    const fixture = await seed();
    const harness = buildHarness();

    await harness.request.execute({
      email: fixture.email,
      client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
    });
    await harness.dispatcher.drain();

    const token = await tokenFromMailpit();
    const client = { userAgent: 'suite', ipAddress: '203.0.113.7' };

    await harness.confirm.execute({ token, newPassword: NEW_PASSWORD, client });

    const spent = await harness.confirm
      .execute({ token, newPassword: 'another-good-passphrase', client })
      .catch((error: unknown) => error);
    const unknown = await harness.confirm
      .execute({
        token: randomBytes(32).toString('base64url'),
        newPassword: 'another-good-passphrase',
        client,
      })
      .catch((error: unknown) => error);

    expect(spent).toMatchObject({ code: 'password_reset_token_invalid', status: 400 });
    expect(unknown).toMatchObject({ code: 'password_reset_token_invalid', status: 400 });

    await harness.close();
  });

  /**
   * Two links outstanding at once, one of them spent — against the policy that actually governs the
   * statement. `invalidateOutstanding` is an `updateMany` under `app_user` inside `withTenant`, so
   * what is proved here is that the rows really move: a `USING` predicate that did not match, or a
   * missing `WITH CHECK`, would leave the second link alive and the suite of doubles would never
   * notice.
   */
  it('kills the other outstanding links of the account when one of them is spent', async () => {
    const fixture = await seed();
    const harness = buildHarness();
    const client = { userAgent: 'suite', ipAddress: '203.0.113.7' };

    await harness.request.execute({ email: fixture.email, client });
    await harness.dispatcher.drain();

    const first = await tokenFromMailpit();

    await fetch(`${mailpitApi}/api/v1/messages`, { method: 'DELETE' });
    await harness.request.execute({ email: fixture.email, client });
    await harness.dispatcher.drain();

    const second = await tokenFromMailpit();

    expect(second).not.toBe(first);

    await harness.confirm.execute({ token: first, newPassword: NEW_PASSWORD, client });

    const replayed = await harness.confirm
      .execute({ token: second, newPassword: 'another-good-passphrase', client })
      .catch((error: unknown) => error);

    expect(replayed).toMatchObject({ code: 'password_reset_token_invalid', status: 400 });

    const live = await asMaintenance(pools.owner, (db) =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM password_reset_tokens
          WHERE user_id = $1 AND used_at IS NULL`,
        [fixture.userId],
      ),
    );

    expect(live.rows[0]?.count).toBe('0');

    // And the password is the one the first link set, not the one the second tried to.
    const stored = await asMaintenance(pools.owner, (db) =>
      db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [
        fixture.userId,
      ]),
    );

    await expect(
      new Argon2PasswordHasher(ARGON2).verify(stored.rows[0]?.password_hash ?? '', NEW_PASSWORD),
    ).resolves.toBe(true);

    await harness.close();
  });

  /**
   * The settled rows are removed when the next link is issued. Nothing else in the schema deletes
   * from this table, and every row in it is the digest of a credential that was mailed.
   */
  it('prunes the rows of the account that can never be spent again', async () => {
    const fixture = await seed();
    const harness = buildHarness();
    const client = { userAgent: 'suite', ipAddress: '203.0.113.7' };

    await harness.request.execute({ email: fixture.email, client });
    await harness.dispatcher.drain();
    await harness.confirm.execute({
      token: await tokenFromMailpit(),
      newPassword: NEW_PASSWORD,
      client,
    });

    await fetch(`${mailpitApi}/api/v1/messages`, { method: 'DELETE' });
    await harness.request.execute({ email: fixture.email, client });
    await harness.dispatcher.drain();

    const rows = await asMaintenance(pools.owner, (db) =>
      db.query<{ used_at: Date | null }>(
        `SELECT used_at FROM password_reset_tokens WHERE user_id = $1`,
        [fixture.userId],
      ),
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.used_at).toBeNull();

    await harness.close();
  });
});

describe('the resolver the reset link is looked up through', () => {
  it('CONTROL: app_auth resolves a token to its organization', async () => {
    const fixture = await seed();
    const harness = buildHarness();

    await harness.request.execute({
      email: fixture.email,
      client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
    });
    await harness.dispatcher.drain();

    const token = await tokenFromMailpit();
    const { rows } = await pools.auth.query<{ organization_id: string; user_id: string }>(
      'SELECT * FROM auth_lookup_password_reset($1)',
      [createHash('sha256').update(token, 'utf8').digest()],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: fixture.organizationId,
      user_id: fixture.userId,
    });

    await harness.close();
  });

  /**
   * The columns the resolver may return. `used_at` and `expires_at` are absent on purpose: a read
   * that could answer "is this token still usable" is a read two concurrent requests can both make,
   * and it would also let this privileged surface answer "did somebody complete a reset" — which is
   * the fact the single error code exists to hide.
   */
  it('returns the tenant and nothing about the state of the token', async () => {
    const fixture = await seed();
    const harness = buildHarness();

    await harness.request.execute({
      email: fixture.email,
      client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
    });
    await harness.dispatcher.drain();

    const token = await tokenFromMailpit();
    const { rows } = await pools.auth.query<Record<string, unknown>>(
      'SELECT * FROM auth_lookup_password_reset($1)',
      [createHash('sha256').update(token, 'utf8').digest()],
    );

    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['organization_id', 'token_id', 'user_id']);

    await harness.close();
  });

  it('answers nothing for a digest no row carries', async () => {
    await seed();

    const { rows } = await pools.auth.query('SELECT * FROM auth_lookup_password_reset($1)', [
      randomBytes(32),
    ]);

    expect(rows).toEqual([]);
  });

  it('is unreachable for app_user, the role every request runs as', async () => {
    await expect(
      pools.app.query('SELECT * FROM auth_lookup_password_reset($1)', [randomBytes(32)]),
    ).rejects.toThrow(/permission denied/i);
  });

  it('is the only way app_auth can reach the table', async () => {
    await seed();

    await expect(pools.auth.query('SELECT * FROM password_reset_tokens')).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('changing a password, end to end', () => {
  /**
   * The `minimal` profile, reproduced: a real database, a real `UnconfiguredMailAdapter`, and no
   * Mailpit behind it. The password has to change anyway.
   *
   * This is the assertion the earlier design would have failed — it answered `503` here — and it is
   * the one that matters most, because a password change is what somebody does *because* they think
   * the old password has leaked. An installation that cannot send mail must not be an installation
   * that cannot take an account back.
   */
  it('changes the password on an installation with no transport, and mails nothing', async () => {
    const fixture = await seed();
    const harness = buildHarness({ mail: 'unconfigured' });
    const [kept] = fixture.families;

    await harness.changePassword.execute({
      actor: { organizationId: fixture.organizationId, userId: fixture.userId },
      currentFamilyId: kept ?? '',
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
    });
    await harness.dispatcher.drain();

    expect(await liveFamilies(fixture.userId)).toEqual([kept]);
    expect(await messages()).toEqual([]);

    const stored = await asMaintenance(pools.owner, (client) =>
      client.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [
        fixture.userId,
      ]),
    );
    const hasher = new Argon2PasswordHasher(ARGON2);

    await expect(hasher.verify(stored.rows[0]?.password_hash ?? '', NEW_PASSWORD)).resolves.toBe(
      true,
    );

    await harness.close();
  });

  it('closes the other devices, keeps the calling one and mails a notification', async () => {
    const fixture = await seed();
    const harness = buildHarness();
    const [kept, ...closed] = fixture.families;

    await harness.changePassword.execute({
      actor: { organizationId: fixture.organizationId, userId: fixture.userId },
      currentFamilyId: kept ?? '',
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
    });
    await harness.dispatcher.drain();

    expect(await liveFamilies(fixture.userId)).toEqual([kept]);
    expect(closed).toHaveLength(2);

    const received = await messages();

    expect(received).toHaveLength(1);
    expect(received[0]?.To[0]?.Address).toBe(fixture.email);

    const body = await bodyOf(received[0]?.ID ?? '');

    expect(body).not.toContain(PASSWORD);
    expect(body).not.toContain(NEW_PASSWORD);

    await harness.close();
  });

  /**
   * The link somebody was holding when the owner changed their password.
   *
   * Closing every other session and leaving that link alive closes nothing: it mints a *new*
   * password, which outranks every session that was just revoked. Asserted here rather than only
   * against doubles because the statement runs under the tenant policy — and because the link is
   * followed all the way through `ConfirmPasswordResetUseCase`, which is what makes the refusal
   * mean "the row is spent" rather than "the fake said so".
   */
  it('invalidates a reset link that was outstanding when the password changed', async () => {
    const fixture = await seed();
    const harness = buildHarness();
    const client = { userAgent: 'suite', ipAddress: '203.0.113.7' };
    const [kept] = fixture.families;

    await harness.request.execute({ email: fixture.email, client });
    await harness.dispatcher.drain();

    const token = await tokenFromMailpit();

    await harness.changePassword.execute({
      actor: { organizationId: fixture.organizationId, userId: fixture.userId },
      currentFamilyId: kept ?? '',
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      client,
    });
    await harness.dispatcher.drain();

    const replayed = await harness.confirm
      .execute({ token, newPassword: 'another-good-passphrase', client })
      .catch((error: unknown) => error);

    expect(replayed).toMatchObject({ code: 'password_reset_token_invalid', status: 400 });

    // The password is still the one the change set, and the caller's own session is still open.
    const stored = await asMaintenance(pools.owner, (db) =>
      db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [
        fixture.userId,
      ]),
    );

    await expect(
      new Argon2PasswordHasher(ARGON2).verify(stored.rows[0]?.password_hash ?? '', NEW_PASSWORD),
    ).resolves.toBe(true);
    expect(await liveFamilies(fixture.userId)).toEqual([kept]);

    await harness.close();
  });
});
