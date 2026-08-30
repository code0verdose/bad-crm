import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadEnv } from '../src/infrastructure/bootstrap/load-env.util.js';
import { createPrismaClient } from '../src/infrastructure/persistence/prisma/prisma.client.js';
import { PrismaRoleRepository } from '../src/infrastructure/persistence/prisma/role.repository.js';
import { ProvisionSystemRolesUseCase } from '../src/application/iam/use-cases/provision-system-roles.use-case.js';
import { withTenant } from '../src/infrastructure/persistence/prisma/tenant.context.js';
import { type LoggerPort } from '../src/application/platform/ports/logger.port.js';
import { HmacAddressHasher } from '../src/infrastructure/crypto/address-hasher.adapter.js';
import { PrismaAuditLogger } from '../src/infrastructure/persistence/prisma/audit-log.adapter.js';
import { AsyncRequestContextAdapter } from '../src/infrastructure/logging/async-request-context.adapter.js';
import { pinoAuditLogger } from '../src/infrastructure/logging/pino-audit.adapter.js';

/**
 * `pnpm db:provision-roles` — re-applies system roles to every organization.
 *
 * Called as part of the upgrade procedure (see `docs/runbooks/upgrade.md`). The composition of a system
 * role is **code**, so a key added to the matrix must reach installations that already exist. This
 * script is the upgrade path for organizations that were bootstrapped before a matrix change.
 *
 * Idempotent: a second run changes nothing (tested in
 * `test/integration/db/system-roles-provisioning.test.ts`).
 *
 * Runs sequentially: fetches all organizations, then opens a transaction for each one to provision
 * its roles using the standard `withTenant` pattern. Each organization is provisioned independently.
 *
 * **A run that moves rights leaves a record in the organization it moved them in** (STORY-011-02,
 * acceptance 7). The entries are written by the use-case, inside the same transaction as the change,
 * as `actorType = SYSTEM` — there is no person here, only an operator at a shell. An organization
 * this run did not actually change gets no entry at all, which is what keeps the trail of an
 * installation with hundreds of tenants worth reading after an upgrade.
 */

try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // No file: a container passes the environment directly.
}

const silent: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silent,
};

const env = loadEnv(process.env);

/**
 * One identifier for the whole run, shared by every entry it writes.
 *
 * `request_id` is `NOT NULL` and there is no request here; the alternative the writer falls back to
 * is an empty string, which would leave the entries of one upgrade with no way to be grouped — and
 * «show me everything that release did» is the question this record exists to answer.
 */
const runId = randomUUID();
const requestContext = new AsyncRequestContextAdapter();
const clock = { now: () => new Date() };
const audit = new PrismaAuditLogger({
  addressHasher: new HmacAddressHasher(env.APP_ENCRYPTION_KEY),
  requestContext,
  // Unreachable for the actions this script writes — both name an organization — but the writer
  // takes no optional dependency, and a sink that threw would be a worse answer than a log line.
  unscoped: pinoAuditLogger(silent, clock),
});

/**
 * Two connections, because the two halves of this script need different privileges — and the
 * elevated one is given the smaller job.
 *
 * `maintenance` is `app_migrator`, and it is used for **one statement**: listing the organizations.
 * That is a read across tenants, which nothing else in the product is allowed to do.
 *
 * `runtime` is `app_user`, the ordinary application role, and it performs every **write**. Roles
 * could have been written under `app_migrator` with the maintenance switch held open — one
 * connection, less code — and that was rejected: the switch turns the tenant predicate off, so the
 * upgrade would exercise a write path that exists nowhere in production and would keep working if
 * the policy on `roles` were broken. Writing as `app_user` inside `withTenant` means these rows go
 * in through the identical `WITH CHECK` a request goes through, and a policy this script satisfies
 * is a policy the running product satisfies too.
 */
const maintenance = createPrismaClient({
  url: env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL,
  logger: silent,
});

const runtime = createPrismaClient({ url: env.DATABASE_URL, logger: silent });

interface OrganizationId {
  id: string;
}

try {
  const startTime = Date.now();

  // Enumerating organizations is a read *across* tenants, and the only sanctioned way to make one
  // is the maintenance switch of `app_migrator` — the single non-tenant predicate the canonical
  // policy has (`docs/security/rls-design.md`; `rls-catalog.util.ts`, `maintenance_access`).
  //
  // **`USING` governs reads.** Without the switch this SELECT is not "unfiltered because we are
  // only reading" — it returns **zero rows**, the loop below provisions nothing, and the script
  // still prints a success line and exits 0. That is not a hypothetical: the first version of this
  // file omitted the switch on exactly that reasoning and reported
  // «✓ system roles provisioned for 0 organizations» against a database that had four.
  //
  // `set_config(..., true)` is **transaction-local**: the switch reverts when this transaction
  // ends, by commit or by throw. That is why the enumeration is a transaction of its own rather
  // than a session-level `SET` somebody has to remember to unset on the error path.
  const organizations = await maintenance.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.maintenance', 'on', true)`;

    // The positive control, and the reason it is inside the transaction: an empty result is
    // ambiguous — a fresh installation legitimately has no organizations, and a switch that failed
    // to apply looks identical. Asserting the switch separates the two, so "nothing to do" can
    // never be the disguise of "nothing visible".
    const [applied] = await tx.$queryRaw<{ maintenance: string | null }[]>`
      SELECT current_setting('app.maintenance', true) AS maintenance
    `;

    if (applied?.maintenance !== 'on') {
      throw new Error(
        'the maintenance switch did not apply — every organization would read as invisible and this run would silently provision nothing',
      );
    }

    return tx.$queryRaw<OrganizationId[]>`SELECT id FROM organizations`;
  });

  // Provision roles for each organization using the standard withTenant pattern.
  // This is idempotent: a second run changes nothing.
  const roleRepository = new PrismaRoleRepository();
  const provisionUseCase = new ProvisionSystemRolesUseCase(roleRepository, audit);

  let provisioned = 0;
  const failed: string[] = [];

  for (const org of organizations) {
    // One transaction per organization, on the runtime connection: `withTenant` pins
    // `app.organization_id` to it, and the tenant policy — the same one every request is judged by
    // — decides whether these rows may be written. An organization that fails does not take the
    // others down with it; the failures are counted and reported at the end, because an upgrade
    // that stops on the first bad tenant leaves the rest unprovisioned with no record of which.
    try {
      await requestContext.run({ requestId: runId, organizationId: org.id, userId: null }, () =>
        withTenant(runtime, { organizationId: org.id, userId: null }, () =>
          provisionUseCase.execute({ organizationId: org.id }),
        ),
      );

      provisioned++;
    } catch (error) {
      failed.push(org.id);
      process.stderr.write(
        `  ! ${org.id}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  const elapsedMs = Date.now() - startTime;

  process.stdout.write(
    `✓ system roles provisioned for ${provisioned} of ${organizations.length} organization${organizations.length === 1 ? '' : 's'} in ${elapsedMs}ms\n`,
  );

  // A partial run is not a success. Reported as its own status so the upgrade procedure stops here
  // rather than continuing with some tenants holding no roles — the state that produces
  // «the organization has no `developer` role» at the first request, long after the operator has
  // stopped watching this output.
  if (failed.length > 0) {
    process.stderr.write(
      `db:provision-roles left ${failed.length} organization(s) unprovisioned: ${failed.join(', ')}\n`,
    );
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    `db:provision-roles could not run: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
} finally {
  await Promise.all([maintenance.$disconnect(), runtime.$disconnect()]);
}
