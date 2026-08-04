import { fileURLToPath } from 'node:url';

import { BootstrapOrganizationUseCase } from '../src/application/organization/use-cases/bootstrap-organization.use-case.js';
import { loadEnv } from '../src/infrastructure/bootstrap/load-env.util.js';
import { Argon2PasswordHasher } from '../src/infrastructure/crypto/argon2-password-hasher.adapter.js';
import { PrismaOrganizationRepository } from '../src/infrastructure/persistence/prisma/organization.repository.js';
import { createPrismaClient } from '../src/infrastructure/persistence/prisma/prisma.client.js';
import { PrismaUnitOfWork } from '../src/infrastructure/persistence/prisma/unit-of-work.adapter.js';
import { SystemIdGeneratorAdapter } from '../src/infrastructure/platform/system-id-generator.adapter.js';
import { type LoggerPort } from '../src/application/platform/ports/logger.port.js';

import { renderSeedSummary, seedInstallation, seedRefusalReason } from './seed.util.js';

/**
 * `pnpm db:seed` — the demo installation an end-to-end run signs in to.
 *
 * What it writes and why it is exactly that much: `seed-data.constant.ts`. How it stays idempotent
 * and where it refuses to run: `seed.util.ts`. This file is the wiring — environment in, summary
 * out — and it deliberately builds the same use-case the registration endpoint builds, rather than
 * a shortcut into the database.
 *
 * Exit codes are three, because the answers are three: 0 seeded (or already seeded), 1 refused by
 * the environment guard, 2 could not run. A wrapper that reads «refused because this is production»
 * as a database failure would retry it.
 */

/**
 * The repository `.env`, the same file `pnpm dev` reads.
 *
 * Without this the documented command does not work on a developer machine: nothing loads the file
 * into the environment of a `tsx` process, so `loadEnv` refuses on a missing `DATABASE_URL` and the
 * runbook's first step fails on a stack that is running perfectly. `loadEnvFile` leaves variables
 * that are already set alone, so the shell still wins over the file — the precedence
 * `scripts/lib/check-env.util.ts` documents.
 */
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // No file: a container run passes the environment directly, and that is the normal case there.
}

/** `scripts/**` is tooling, not the app runtime: the ban on reading `process.env` guards
 * `src/**`, where a stray read would bypass the schema and `.env.example`. */
const rawEnv = process.env;

const refusal = seedRefusalReason({
  nodeEnv: rawEnv['NODE_ENV'],
  allowProduction: rawEnv['SEED_ALLOW_PRODUCTION'] === 'true',
});

if (refusal !== null) {
  process.stderr.write(`db:seed refused: ${refusal}\n`);
  process.exit(1);
}

/** Quiet by default: the summary is the output, and query logs would bury it. */
const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: (): LoggerPort => silentLogger,
};

const env = loadEnv(rawEnv);
const prisma = createPrismaClient({ url: env.DATABASE_URL, logger: silentLogger });

try {
  const summary = await seedInstallation({
    bootstrap: new BootstrapOrganizationUseCase(
      new PrismaUnitOfWork(prisma),
      new PrismaOrganizationRepository(),
      new SystemIdGeneratorAdapter(),
    ),
    hashPassword: (plain) =>
      new Argon2PasswordHasher({
        memoryCost: env.ARGON2_MEMORY_COST,
        timeCost: env.ARGON2_TIME_COST,
        parallelism: env.ARGON2_PARALLELISM,
      }).hash(plain),
  });

  process.stdout.write(`${renderSeedSummary(summary)}\n`);
} catch (error) {
  process.stderr.write(
    `db:seed could not run: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}
