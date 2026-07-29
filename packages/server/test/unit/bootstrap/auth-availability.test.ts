import { describe, expect, it } from 'vitest';

import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';
import {
  AUTH_DB_ROLE,
  assertAuthDatabaseRole,
  authDatabaseReadinessProbe,
  authDatabaseRoleViolations,
  type AuthDbRoleFacts,
} from '@/infrastructure/bootstrap/auth-database.util.js';
import { buildContainer } from '@/infrastructure/bootstrap/container.factory.js';
import {
  blockingDegradationWarnings,
  describeDegradations,
} from '@/infrastructure/bootstrap/env-features.util.js';
import { createRootLogger } from '@/infrastructure/logging/pino-logger.adapter.js';
import {
  UnsafeDatabaseRoleError,
  type DbRoleProbeClient,
} from '@/infrastructure/persistence/prisma/assert-db-role.util.js';
import { detachedAuthLookup } from '@/infrastructure/persistence/prisma/detached-database.adapter.js';
import { type DatabaseConnection } from '@/infrastructure/persistence/prisma/database.factory.js';

import { testEnv } from '../../support/test-app.util.js';

/**
 * What an installation that forgot `DATABASE_AUTH_URL` says about itself, and what one that set it
 * to the wrong role is told.
 *
 * Both are the same class of defect and neither has a functional symptom: the container starts, the
 * probes are green, every route answers, and the first person to sign in gets a 500 — or, in the
 * second case, signs in successfully over a connection with full write privileges on every
 * organization's tables. So the assertions here are about *saying so*: a line at startup, a field in
 * `/ready`, a stable error code instead of a bare `Error`, and a refusal to open the port when the
 * second pool connected as a role it must not be.
 */

const AUTH_URL = 'postgres://app_auth:secret@localhost:5432/bad_crm';

const logger = (): ReturnType<typeof createRootLogger> =>
  createRootLogger({ level: 'silent', version: '0.0.0' }, { write: () => undefined });

const fakeDatabase = (): DatabaseConnection =>
  ({
    base: {} as DatabaseConnection['base'],
    guarded: {} as DatabaseConnection['guarded'],
    close: (): Promise<void> => Promise.resolve(),
  }) as DatabaseConnection;

/**
 * The one method of `PrismaClient` these checks use, with the answer under the test's control.
 *
 * `$queryRaw` is declared as returning a `PrismaPromise`, which a plain promise does not satisfy;
 * the cast is confined here rather than repeated at every call site.
 */
const probeClient = (answer: () => Promise<unknown[]>): DbRoleProbeClient =>
  ({ $queryRaw: answer }) as unknown as DbRoleProbeClient;

const facts = (overrides: Partial<AuthDbRoleFacts> = {}): AuthDbRoleFacts => ({
  role: AUTH_DB_ROLE,
  isSuperuser: false,
  ownsSchema: false,
  canBecomeOwner: false,
  canBecomeRuntime: false,
  bypassesRowLevelSecurity: false,
  readsAccountsDirectly: false,
  ...overrides,
});

describe('an installation without DATABASE_AUTH_URL', () => {
  it('names authentication in the startup summary, so a green container is not silent', () => {
    expect(describeDegradations(testEnv())).toContainEqual({
      feature: 'authentication',
      fallback: 'unavailable',
      blocking: true,
      remedy: expect.stringContaining('DATABASE_AUTH_URL') as string,
    });
  });

  it('says what to do about it on a line of its own, at warn level', () => {
    expect(blockingDegradationWarnings(testEnv()).join('\n')).toContain('DATABASE_AUTH_URL');
    expect(blockingDegradationWarnings(testEnv({ DATABASE_AUTH_URL: AUTH_URL }))).toEqual([]);
  });

  it('stops naming it once the second pool is configured', () => {
    const features = describeDegradations(testEnv({ DATABASE_AUTH_URL: AUTH_URL })).map(
      (degradation) => degradation.feature,
    );

    expect(features).not.toContain('authentication');
  });

  /**
   * A bare `Error` reaches the handler as "not one of ours" and is answered `500 internal_error`
   * with no detail — indistinguishable from a bug, and nothing an operator can key an alert on.
   * `service_unavailable` is 503 with a stable code, which is what a missing dependency is.
   *
   * The variable travels in `details`, never in `message`: `message` becomes the `detail` line of
   * the problem document, and naming an environment variable there would answer a question an
   * anonymous caller did not ask. `details` goes to the log and nowhere else.
   */
  it.each([
    ['findUsersByEmail', (): unknown => detachedAuthLookup().findUsersByEmail('ada@example.com')],
    [
      'findUserByEmailAndSlug',
      (): unknown => detachedAuthLookup().findUserByEmailAndSlug('a', 'b'),
    ],
    [
      'findSessionByRefreshHash',
      (): unknown => detachedAuthLookup().findSessionByRefreshHash(new Uint8Array(1)),
    ],
  ])('refuses %s with a stable code rather than a bare Error', (_case, run) => {
    expect(run).toThrow(ServiceUnavailableError);

    const thrown = (() => {
      try {
        run();
      } catch (error) {
        return error as ServiceUnavailableError;
      }

      throw new Error('the detached lookup answered instead of refusing');
    })();

    expect(thrown.code).toBe('service_unavailable');
    expect(thrown.status).toBe(503);
    expect(thrown.details).toMatchObject({ variable: 'DATABASE_AUTH_URL' });
    expect(thrown.message).not.toContain('DATABASE_AUTH_URL');
  });
});

describe('the second pool is verified before the port opens', () => {
  it('registers a startup check when the authentication URL is configured', () => {
    const container = buildContainer({
      env: testEnv({ DATABASE_AUTH_URL: AUTH_URL }),
      logger: logger(),
      database: fakeDatabase(),
    });

    expect(container.startupChecks.map((check) => check.name)).toEqual(['auth-database-role']);
  });

  it('registers none when there is no second pool to verify', () => {
    const container = buildContainer({
      env: testEnv(),
      logger: logger(),
      database: fakeDatabase(),
    });

    expect(container.startupChecks).toEqual([]);
  });
});

describe('the role behind DATABASE_AUTH_URL', () => {
  it('accepts the narrow credential the design describes', () => {
    expect(authDatabaseRoleViolations(facts())).toEqual([]);
  });

  it.each([
    ['a different role entirely', facts({ role: 'app_migrator' }), /app_migrator/],
    ['a superuser', facts({ role: 'postgres', isSuperuser: true }), /superuser/],
    ['the owner of the schema', facts({ ownsSchema: true }), /owns schema/],
    ['a member of the owner role', facts({ canBecomeOwner: true }), /SET ROLE app_migrator/],
    ['a member of the runtime role', facts({ canBecomeRuntime: true }), /SET ROLE app_user/],
    ['a role that can read accounts', facts({ readsAccountsDirectly: true }), /directly/],
    // The attribute belongs to the NOLOGIN owner the resolvers execute as, never to the role that
    // connects. Worth its own case because of one concrete path: an installation upgraded without
    // the role bootstrap step keeps whatever it had before, and nothing else in the process notices.
    [
      'a role that bypasses row-level security',
      facts({ bypassesRowLevelSecurity: true }),
      /BYPASSRLS/,
    ],
  ])('refuses %s', (_case, given, expected) => {
    expect(authDatabaseRoleViolations(given).join('\n')).toMatch(expected);
  });

  it('reads the facts out of the catalog and returns them on a healthy connection', async () => {
    const client = probeClient(() =>
      Promise.resolve([
        {
          role: AUTH_DB_ROLE,
          is_superuser: false,
          owns_schema: false,
          can_become_owner: false,
          can_become_runtime: false,
          reads_accounts_directly: false,
        },
      ]),
    );

    await expect(assertAuthDatabaseRole(client)).resolves.toMatchObject({ role: AUTH_DB_ROLE });
  });

  it('refuses a connection the catalog reports as privileged', async () => {
    const client = probeClient(() =>
      Promise.resolve([
        {
          role: 'app_migrator',
          is_superuser: false,
          owns_schema: true,
          can_become_owner: true,
          can_become_runtime: false,
          reads_accounts_directly: true,
        },
      ]),
    );

    await expect(assertAuthDatabaseRole(client)).rejects.toThrow(UnsafeDatabaseRoleError);
  });

  /** No row is not a pass: "nothing could be verified" must never read as "nothing is wrong". */
  it('refuses a connection the catalog says nothing about', async () => {
    const client = probeClient(() => Promise.resolve([]));

    await expect(assertAuthDatabaseRole(client)).rejects.toThrow(UnsafeDatabaseRoleError);
  });
});

describe('the /ready probe of the second pool', () => {
  it('reports it up when the pool answers', async () => {
    const probe = authDatabaseReadinessProbe(probeClient(() => Promise.resolve([{ ok: 1 }])));

    expect(probe.dependency).toBe('authentication');
    await expect(probe.check()).resolves.toEqual({ status: 'up' });
  });

  /**
   * The failure is left to `CheckReadinessUseCase`, which answers `down`, logs the exception and
   * puts none of it in the body — `/ready` is unauthenticated, and a driver error quotes the
   * connection string, which quotes the password. Catching it here would lose the operator's only
   * copy of the reason.
   */
  it('lets a driver failure reach the aggregator instead of swallowing it', async () => {
    const failure = new Error('connect ECONNREFUSED postgres://app_auth:secret@db:5432'); // scan-secrets:allow gitleaks:allow
    const probe = authDatabaseReadinessProbe(probeClient(() => Promise.reject(failure)));

    await expect(probe.check()).rejects.toBe(failure);
  });
});
