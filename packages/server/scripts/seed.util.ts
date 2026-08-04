import { type BootstrapOrganizationUseCase } from '../src/application/organization/use-cases/bootstrap-organization.use-case.js';
import { ConflictError } from '../src/domain/shared/errors/app.errors.js';

import { SEED_ORGANIZATIONS, SEED_PASSWORD } from './seed-data.constant.js';

/**
 * The seeding itself: what it writes, how it stays idempotent, and where it refuses to run.
 *
 * Separated from `seed.ts` so both halves are testable — the runner builds a database connection
 * from the environment and prints, this decides.
 */

export interface SeedEnvironment {
  readonly nodeEnv: string | undefined;
  readonly allowProduction: boolean;
}

/**
 * Environments where creating accounts with a published password is the point rather than a breach.
 *
 * An allow-list, not a deny-list of `production`: `staging`, `preview` and an unset `NODE_ENV` — the
 * value of a container started without one — must be refused too, and a deny-list refuses only the
 * names somebody thought of.
 */
const SEEDABLE = new Set(['development', 'test']);

/**
 * Why the seed must not run here, or `null` when it may.
 *
 * A reason rather than a boolean, and the reason names the environment: «seeding refused» on a
 * console tells an operator nothing about what to change.
 */
export const seedRefusalReason = (environment: SeedEnvironment): string | null => {
  if (environment.allowProduction) return null;
  if (environment.nodeEnv !== undefined && SEEDABLE.has(environment.nodeEnv)) return null;

  return `NODE_ENV=${String(environment.nodeEnv)} is not a seedable environment (development, test). The seed creates accounts whose password is published in this repository; set SEED_ALLOW_PRODUCTION=true to override deliberately.`;
};

export interface SeedDependencies {
  readonly bootstrap: BootstrapOrganizationUseCase;
  readonly hashPassword: (plain: string) => Promise<string>;
}

export interface SeededOrganization {
  readonly slug: string;
  readonly ownerEmail: string;
  /** `false` when the organization was already there — the second run of an idempotent command. */
  readonly created: boolean;
  /** Known only when this run created it: an existing tenant is not readable from outside its scope. */
  readonly organizationId: string | null;
}

export interface SeedSummary {
  readonly organizations: readonly SeededOrganization[];
}

/**
 * Creates the declared organizations, skipping the ones that already exist.
 *
 * **Idempotency is read from the conflict, not from a lookup**, and that is a property of the schema
 * rather than a shortcut. `slug` is globally unique, but `SELECT ... WHERE slug = $1` runs under
 * row-level security: outside the tenant's own scope it returns nothing whether the organization
 * exists or not, so «already seeded» is indistinguishable from «free to create» on the read path.
 * The unique index is the only place that knows, and `organization_already_exists` is how it says so
 * (`infrastructure/persistence/prisma/organization.repository.ts`).
 *
 * Everything goes through the same use-case registration uses, so the rows are written inside
 * `withTenant` and are subject to the same policies. A seed that inserted rows directly would be a
 * second way into the database — the one place where «it is only a fixture» turns into a fixture
 * that is not subject to the rules the product is tested against.
 */
export const seedInstallation = async (deps: SeedDependencies): Promise<SeedSummary> => {
  const passwordHash = await deps.hashPassword(SEED_PASSWORD);
  const organizations: SeededOrganization[] = [];

  for (const declared of SEED_ORGANIZATIONS) {
    try {
      const { organizationId } = await deps.bootstrap.execute({
        organization: {
          name: declared.name,
          slug: declared.slug,
          timezone: declared.timezone,
          defaultCurrency: declared.defaultCurrency,
        },
        owner: {
          email: declared.owner.email,
          passwordHash,
          locale: declared.owner.locale,
          timezone: declared.owner.timezone,
        },
      });

      organizations.push({
        slug: declared.slug,
        ownerEmail: declared.owner.email,
        created: true,
        organizationId,
      });
    } catch (error) {
      // Only this conflict. Any other failure — an unreachable database, a missing migration, a
      // refused policy — is a reason to stop, and swallowing it here would report a successful seed
      // over an installation with nothing in it.
      if (!(error instanceof ConflictError) || error.code !== 'organization_already_exists')
        throw error;

      organizations.push({
        slug: declared.slug,
        ownerEmail: declared.owner.email,
        created: false,
        organizationId: null,
      });
    }
  }

  return { organizations };
};

/** The summary an operator reads: what exists now, and which half of it this run wrote. */
export const renderSeedSummary = (summary: SeedSummary): string => {
  const lines = summary.organizations.map(
    (organization) =>
      `  ${organization.created ? 'created' : 'present'}  ${organization.slug.padEnd(12)} owner ${organization.ownerEmail}`,
  );
  const created = summary.organizations.filter((organization) => organization.created).length;

  return [
    `seed: ${String(summary.organizations.length)} organizations, ${String(created)} created by this run`,
    ...lines,
    `  sign in with the password from scripts/seed-data.constant.ts`,
  ].join('\n');
};
