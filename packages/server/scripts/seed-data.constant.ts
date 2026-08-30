/**
 * What `pnpm db:seed` creates. The declaration, separate from the runner that applies it.
 *
 * This is the fixture the end-to-end suite signs in as ([EPIC-010](../../../epics/epic-010-e2e-harness/epic.md)),
 * so the values here are part of a contract rather than sample content: `packages/e2e/fixtures/seed-data.ts`
 * carries the same table, and `test/e2e/seed-fixture-parity.test.ts` fails when the two disagree.
 * The duplication is deliberate — `packages/e2e` may not import product sources, or a scenario could
 * pass against code that is not deployed — and the gate is what keeps the copy honest.
 *
 * **Two organizations, and everything about them different.** An isolation scenario compares tenant
 * A against tenant B; a fixture whose two tenants share a name, a currency or a locale can only
 * prove that the comparison ran. The differing locale and currency also make a formatting defect
 * visible in the fixture itself rather than in a screenshot months later.
 *
 * **Roles are absent, and the reason has changed — corrected 2026-08-30.** This said roles «arrive
 * with EPIC-011»; EPIC-011 shipped (`prisma/migrations/20260805100000_roles`,
 * `20260805120000_user_roles`, model `UserRole`), so the obstacle is no longer the schema. What is
 * still missing is the fixture: seeding an `admin@` and a `lead@` means assigning them roles and
 * keeping those assignments in step with `SYSTEM_ROLE_PERMISSIONS`, which is STORY-010-03's work
 * and not a line in this file. The original reasoning holds unchanged — a fixture that names
 * accounts as if they differed in rights, while they do not, is worse than a small one
 */

/** The password every seeded account signs in with; refused outside development and test. */
export const SEED_PASSWORD = 'seed-only-not-a-real-password';

export interface SeedOwner {
  readonly email: string;
  readonly locale: string;
  readonly timezone: string;
}

export interface SeedOrganization {
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  /** ISO 4217. */
  readonly defaultCurrency: string;
  readonly owner: SeedOwner;
}

/**
 * Addresses live in `.local`, which RFC 6762 reserves for link-local names and which resolves
 * nowhere. A fixture address in a domain somebody owns is a mail server receiving password resets
 * for accounts it never asked for.
 */
export const SEED_ORGANIZATIONS: readonly SeedOrganization[] = [
  {
    slug: 'seed-org-a',
    name: 'Seed Organization A',
    timezone: 'Europe/Berlin',
    defaultCurrency: 'EUR',
    owner: { email: 'owner@org-a.local', locale: 'en', timezone: 'Europe/Berlin' },
  },
  {
    slug: 'seed-org-b',
    name: 'Seed Organization B',
    timezone: 'UTC',
    defaultCurrency: 'USD',
    owner: { email: 'owner@org-b.local', locale: 'ru', timezone: 'UTC' },
  },
];
