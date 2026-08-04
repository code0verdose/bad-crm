/**
 * The installation `pnpm db:seed` creates, as the end-to-end suite knows it.
 *
 * A copy of `packages/server/scripts/seed-data.constant.ts`, and deliberately a copy: this package
 * drives the running stack over HTTP and the browser and may not import product sources — a
 * scenario that imported them could pass against code that is not deployed. What keeps the copy
 * honest is `test/e2e/seed-fixture-parity.test.ts` in the repository suite: it reads both files and
 * fails when they disagree, so the duplication cannot rot into two different fixtures.
 *
 * Sign-in through the form belongs to the scenario that tests the form; everything else reuses a
 * saved session (STORY-010-03).
 */

/** The password every seeded account signs in with. The seed refuses to run outside dev and test. */
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

/** The two tenants an isolation scenario compares; named so the assertion reads as the property. */
export const [SEED_ORGANIZATION_A, SEED_ORGANIZATION_B] = SEED_ORGANIZATIONS;
