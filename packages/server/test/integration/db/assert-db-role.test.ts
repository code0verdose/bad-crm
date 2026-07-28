import { type PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import {
  OWNER_DB_ROLE,
  RUNTIME_DB_ROLE,
  UnsafeDatabaseRoleError,
  assertRuntimeDbRole,
} from '@/infrastructure/persistence/prisma/assert-db-role.util.js';
import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';

/**
 * The startup check against the four roles this installation really has.
 *
 * The unit suite next door covers the decision table; what it cannot cover is whether the SQL says
 * about a live database what the decision table assumes. `rolbypassrls`, the owner of schema
 * `public` and `pg_has_role(..., 'MEMBER')` are three catalog questions that are easy to get subtly
 * wrong — `USAGE` instead of `MEMBER` answers false for a NOINHERIT role that can still `SET ROLE`
 * — and each wrong answer turns this check into a check that always passes.
 *
 * So every assertion here is made through a connection actually made as that role, and the refusals
 * matter more than the acceptance: a guard that has never refused anything is indistinguishable
 * from a guard that cannot.
 */

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silentLogger,
};

const clients: PrismaClient[] = [];

const clientFor = (url: string): PrismaClient => {
  const client = createPrismaClient({ url, logger: silentLogger });

  clients.push(client);

  return client;
};

afterAll(async () => {
  await Promise.all(clients.map((client) => client.$disconnect()));
});

const reasonsOf = async (url: string): Promise<string> => {
  const error = await assertRuntimeDbRole(clientFor(url)).catch((caught: unknown) => caught);

  expect(error, 'the role was accepted where a refusal was expected').toBeInstanceOf(
    UnsafeDatabaseRoleError,
  );

  return (error as UnsafeDatabaseRoleError).reasons.join('\n');
};

describe('assertRuntimeDbRole against the real roles', () => {
  it('CONTROL: accepts the runtime role, so the refusals below mean something', async () => {
    await expect(assertRuntimeDbRole(clientFor(inject('databaseUrls').appUser))).resolves.toEqual({
      role: RUNTIME_DB_ROLE,
      isSuperuser: false,
      bypassesRls: false,
      ownsSchema: false,
      canBecomeOwner: false,
    });
  });

  /**
   * The likeliest misconfiguration of all: `DATABASE_MIGRATION_URL` copied into `DATABASE_URL`.
   * The application works perfectly — right up to the first table that ships without FORCE.
   */
  it('refuses the migration role, naming both the role and the schema it owns', async () => {
    const reasons = await reasonsOf(inject('databaseUrls').migrator);

    expect(reasons).toContain(OWNER_DB_ROLE);
    expect(reasons).toContain(RUNTIME_DB_ROLE);
    expect(reasons).toContain('owns schema public');
  });

  it('refuses a BYPASSRLS role, for which no policy is ever evaluated', async () => {
    expect(await reasonsOf(inject('databaseUrls').backup)).toContain('BYPASSRLS');
  });

  it('refuses a superuser, which is every one of these problems at once', async () => {
    const reasons = await reasonsOf(inject('databaseUrls').superuser);

    expect(reasons).toContain('superuser');
    expect(reasons).toContain('BYPASSRLS');
  });

  /**
   * The one branch the four fixed roles of this installation cannot reach.
   *
   * None of them is a member of another, so `canBecomeOwner` is false in every spec above and the
   * SQL behind it has never been asked a question with a true answer — the branch was proved by the
   * decision table next door and by nothing else. That is the shape of a check that cannot refuse:
   * `pg_has_role(..., 'USAGE')` in place of `'MEMBER'` leaves this whole file green, because with
   * NOINHERIT — which all four roles are — `USAGE` answers false for a role that can still
   * `SET ROLE`.
   *
   * The misconfiguration is not hypothetical either. `GRANT app_migrator TO app_user`, so that
   * "migrations and the app go under one role", is a documented way to lose tenant isolation
   * entirely: one `SET ROLE app_migrator` and the connection owns the schema of every organization
   * (docs/security/rls-design.md, «`SET ROLE` против отдельных соединений»).
   */
  it('refuses a runtime role that was granted membership in the owner', async () => {
    const admin = new Pool({ connectionString: inject('databaseUrls').superuser, max: 1 });

    try {
      await admin.query(`GRANT ${OWNER_DB_ROLE} TO ${RUNTIME_DB_ROLE}`);

      const reasons = await reasonsOf(inject('databaseUrls').appUser);

      // The role, the schema owner and BYPASSRLS are all still correct here, so this is the only
      // reason there can be — which is what makes the assertion about this branch and not about
      // the check in general.
      expect(reasons).toBe(
        `the role may SET ROLE ${OWNER_DB_ROLE}, so its isolation lasts exactly until one statement says otherwise`,
      );
    } finally {
      await admin.query(`REVOKE ${OWNER_DB_ROLE} FROM ${RUNTIME_DB_ROLE}`);
      await admin.end();
    }
  });

  /**
   * The positive control of the spec above: the membership is really gone, so a later file in the
   * run is not judging a database this one left broken.
   */
  it('CONTROL: accepts the runtime role again once the membership is revoked', async () => {
    await expect(
      assertRuntimeDbRole(clientFor(inject('databaseUrls').appUser)),
    ).resolves.toMatchObject({ canBecomeOwner: false });
  });
});
