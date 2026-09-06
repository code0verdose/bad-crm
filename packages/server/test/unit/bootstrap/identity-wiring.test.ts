import { assert, describe, expect, it } from 'vitest';

import { buildContainer } from '@/infrastructure/bootstrap/container.factory.js';
import { type AppError } from '@/domain/shared/errors/app.errors.js';
import { type DatabaseConnection } from '@/infrastructure/persistence/prisma/database.factory.js';
import { createRootLogger } from '@/infrastructure/logging/pino-logger.adapter.js';

import { testEnv } from '../../support/test-app.util.js';

/**
 * The authentication half of the composition root, in the three shapes a process can take.
 *
 * The container has always been buildable without a database — the HTTP and contract suites do it
 * on every run — and EPIC-006 adds a second optional connection beside it. That makes four
 * combinations, of which three are real: a full process, a process whose operator forgot
 * `DATABASE_AUTH_URL`, and the connectionless container the suites use. Each has to produce a
 * working *object*; what differs is what happens when somebody calls it, and that is asserted in
 * `test/unit/persistence/identity-repositories.test.ts`.
 */

const logger = (): ReturnType<typeof createRootLogger> =>
  createRootLogger({ level: 'silent', version: '0.0.0' }, { write: () => undefined });

/** A connection object with no server behind it: the container only stores and closes it. */
const fakeDatabase = (): DatabaseConnection & { closed: number } => {
  const connection = {
    base: {} as DatabaseConnection['base'],
    guarded: {} as DatabaseConnection['guarded'],
    closed: 0,
    close: (): Promise<void> => {
      connection.closed += 1;

      return Promise.resolve();
    },
  };

  return connection;
};

const AUTH_URL = 'postgres://app_auth:secret@localhost:5432/bad_crm';

describe('wiring the authentication surface', () => {
  /**
   * The upgrade path of an installation whose `.env` predates `MAIL_FROM`.
   *
   * `SMTP_URL` has been in `.env.example` since EPIC-001 and `MAIL_FROM` is new, so this is the
   * common case rather than a corner one. It is asserted through `buildContainer` and not through
   * `createMailer`, because the defect it guards was not in the mailer: the mailer threw, the throw
   * was correct in isolation, and `buildContainer` calls it *before* `api-process.factory.ts` prints
   * any degradation. The process therefore exited before opening the port, while `CHANGELOG.md` and
   * `docs/runbooks/upgrade.md` both promised a warning — and the `warn` branch in
   * `env-features.util.ts` was unreachable code that no test could have noticed.
   *
   * A unit test on the mailer alone would have stayed green through all of that. The composition
   * root is the smallest place where "the installation still starts" is a statement about behaviour.
   */
  it('starts an installation whose SMTP_URL predates MAIL_FROM', () => {
    expect(() =>
      buildContainer({
        env: testEnv({ SMTP_URL: 'smtp://localhost:1025', MAIL_FROM: undefined }),
        logger: logger(),
      }),
    ).not.toThrow();
  });

  it('builds every use-case even without a database, so the routes always exist', () => {
    const container = buildContainer({ env: testEnv(), logger: logger() });

    expect(Object.keys(container.http.identity).sort()).toEqual([
      'authLookup',
      'authenticate',
      'changePassword',
      'confirmPasswordReset',
      'confirmTotp',
      'disableTotp',
      'endSession',
      'listSessions',
      'login',
      'recoveryCodeStatus',
      'refresh',
      'refreshTokens',
      'regenerateRecoveryCodes',
      'register',
      'requestPasswordReset',
      'setupTotp',
      'verifySecondFactor',
    ]);
    // `mail` is unconditional: both mailers expose `close()`, so the step does not become a
    // conditional the day an installation is configured without SMTP (`mail.factory.ts`).
    expect(container.shutdownSteps.map((step) => step.name)).toEqual(['mail']);
  });

  it('opens the second pool when the authentication URL is configured, and closes it', async () => {
    const database = fakeDatabase();
    const container = buildContainer({
      env: testEnv({ DATABASE_AUTH_URL: AUTH_URL }),
      logger: logger(),
      database,
    });

    // Mail **before** both pools, and asserted as a sequence because `createShutdownHandler` awaits
    // the steps in array order — so this array is the order of execution, not a set of names. It read
    // `['database', 'auth-database', 'mail']` while the comment in `container.factory.ts` promised the
    // opposite; the steps were pushed as their subjects happened to be constructed.
    expect(container.shutdownSteps.map((step) => step.name)).toEqual([
      'mail',
      'database',
      'auth-database',
    ]);

    // Sequentially, the way the handler does it — `Promise.all` starts them all at once and would
    // report the same success for any order, which is how the reversed order survived until now.
    const closed: string[] = [];

    for (const step of container.shutdownSteps) {
      await step.close();
      closed.push(step.name);
    }

    expect(closed).toEqual(['mail', 'database', 'auth-database']);
    expect(database.closed).toBe(1);
  });

  /**
   * A deployment with a database and no `DATABASE_AUTH_URL` is incomplete rather than broken: it
   * serves everything else and refuses the authentication path loudly on first use, which is what
   * `.optional()` in the env schema buys and why it is optional at all
   * (rules/self-host-packaging.mdc, rule 2).
   */
  it('registers no second shutdown step when the authentication URL is absent', () => {
    const container = buildContainer({
      env: testEnv(),
      logger: logger(),
      database: fakeDatabase(),
    });

    expect(container.shutdownSteps.map((step) => step.name)).toEqual(['mail', 'database']);
  });

  /**
   * The floor is enforced where the parameters are read, so a container is the last place a
   * weakened configuration can be caught before it starts hashing passwords with it.
   */
  it('refuses to build on argon2 parameters below the OWASP floor', () => {
    expect(() =>
      buildContainer({ env: testEnv({ ARGON2_MEMORY_COST: 1024 }), logger: logger() }),
    ).toThrow(/memoryCost/);
  });
});

/**
 * The concurrency ceiling as a property of the assembled process (STORY-013-06, acceptance 3 and 4).
 *
 * ## Why these two live here and not beside the semaphore
 *
 * `argon2-semaphore.test.ts` and `limited-password-hasher.adapter.test.ts` both build their subject
 * themselves, so what they prove is that a `LimitedPasswordHasher` *someone constructed* holds a
 * ceiling. Neither says anything about the hasher the process hands to its use-cases, and the
 * difference is not academic: deleting the decorator from `container.factory.ts` outright — the
 * whole `new LimitedPasswordHasher(...)` reduced to its first argument — left the entire server
 * suite green. With it gone, sign-in's dummy verification no longer queues, and the
 * indistinguishability of a known and an unknown address goes with it.
 *
 * ## Why through `container.passwordHasher`
 *
 * The behavioural door was tried first and is shut: every use-case that reaches the hasher —
 * sign-in, registration, the reset, accepting an invitation — resolves an account before it hashes,
 * and a container built without `DATABASE_AUTH_URL` refuses at that step (`detachedAuthLookup`).
 * Driving one would mean standing up Postgres for a claim that has nothing to do with SQL. The
 * alternative, exporting `buildIdentity` and calling it with ten hand-built collaborators, rebuilds
 * the composition root in the test and so re-opens the same hole one level down. So the container
 * publishes the instance instead, with the reasoning recorded at the field itself.
 *
 * Both assertions are wired to real argon2id at the real cost: the ceiling is only interesting
 * because the computation is expensive, and a fake that returns immediately cannot hold a queue.
 */
describe('the argon2 ceiling the process actually hands out', () => {
  it('refuses a second computation when the process is configured for one at a time', async () => {
    const container = buildContainer({
      // A one-millisecond budget rather than fake timers: the queue is entered from inside a real
      // argon2id computation on the thread pool, and the wait has to expire while that computation
      // is still running. Any real hash at the OWASP floor is tens of milliseconds.
      env: testEnv({ AUTH_ARGON2_MAX_CONCURRENCY: 1, AUTH_ARGON2_QUEUE_TIMEOUT_MS: 1 }),
      logger: logger(),
    });

    const running = container.passwordHasher.hash('the first computation in the queue');
    const refused = await container.passwordHasher
      .hash('the second one, which never gets a slot')
      .then(
        () => undefined,
        (error: unknown) => error as AppError,
      );

    assert(refused !== undefined, 'the second computation must be refused, not admitted');
    expect(refused.code).toBe('service_unavailable');
    expect(refused.status).toBe(503);

    // POSITIVE CONTROL: the ceiling refuses the queue, not the hashing. The first one still
    // finished, and it finished through the same object.
    await expect(running).resolves.toMatch(/^\$argon2id\$/);
  });

  /**
   * The other half of the wiring, and the one line of the delta no test executed: the callback in
   * `container.factory.ts` that carries the semaphore's count to `setArgon2InFlight`. The adapter
   * was tested, the semaphore was tested, and the wire between them was not — so `argon2_inflight`
   * could sit flat at zero in production with the suite fully green.
   */
  it('publishes the in-flight count of that hasher as argon2_inflight', async () => {
    const container = buildContainer({
      env: testEnv({ METRICS_ENABLED: true, METRICS_TOKEN: 'm'.repeat(32) }),
      logger: logger(),
    });

    const metrics = container.http.metrics;

    assert(metrics !== undefined, 'metrics were enabled, so the port must be mounted');

    const before = await metrics.port.render();
    const running = container.passwordHasher.hash('a computation to be counted');
    // Sampled while the hash is on the thread pool: the gauge is set synchronously on admission.
    const during = await metrics.port.render();

    await running;

    const after = await metrics.port.render();

    expect(before).toContain('argon2_inflight 0');
    expect(during).toContain('argon2_inflight 1');
    expect(after).toContain('argon2_inflight 0');
  });

  /**
   * And the other wire, for the same reason: the depth gauge is only worth declaring if the process
   * feeds it. A ceiling of one makes the second computation a waiter, which is the whole state
   * `argon2_queued` exists to make visible — `argon2_inflight` reads `1` either way.
   */
  it('publishes the depth of that hasher queue as argon2_queued', async () => {
    const container = buildContainer({
      env: testEnv({
        METRICS_ENABLED: true,
        METRICS_TOKEN: 'm'.repeat(32),
        AUTH_ARGON2_MAX_CONCURRENCY: 1,
      }),
      logger: logger(),
    });

    const metrics = container.http.metrics;

    assert(metrics !== undefined, 'metrics were enabled, so the port must be mounted');

    const running = container.passwordHasher.hash('the computation holding the only slot');
    const waiting = container.passwordHasher.hash('the one that has to queue behind it');
    const during = await metrics.port.render();

    await Promise.all([running, waiting]);

    const after = await metrics.port.render();

    expect(during).toContain('argon2_queued 1');
    expect(after).toContain('argon2_queued 0');
  });
});
