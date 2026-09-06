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
 * **Roles are absent here, and they are not coming — settled 2026-09-06 by STORY-010-03.** The
 * accounts a role scenario signs in as now exist, and they are provisioned by the end-to-end run's
 * `globalSetup` rather than by this file: an account can only be created by an invitation and its
 * acceptance, which are HTTP operations, so a script writing to the database directly is the wrong
 * place for them. See `packages/e2e/fixtures/role-account.ts`, which also records why there are two
 * of them and not four. The original reasoning survives in that file unchanged — a fixture that
 * names accounts as if they differed in rights, while they do not, is worse than a small one
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
