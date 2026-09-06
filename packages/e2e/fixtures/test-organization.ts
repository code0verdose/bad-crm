import { randomUUID } from 'node:crypto';

import { TEST_ACCOUNT_MARKER } from './test-account.js';

/**
 * The organization a registration scenario invents — and the honest account of what stays behind.
 *
 * ## Nothing takes this back, and that is a property of the product rather than an oversight
 *
 * `fixtures/test-account.ts` can promise that the colleagues a run invents leave the directory
 * again, because the product offers an operation that does it: offboarding. Registration has no
 * such counterpart, and every route to one is closed:
 *
 * - the owner cannot be offboarded — `last_owner_required` refuses the operation on the last owner
 *   of an organization, which is exactly what a freshly registered owner is;
 * - the organization cannot be removed — no endpoint in `docs/api/openapi.yaml` deletes one, and a
 *   teardown reaching past the API into PostgreSQL would need database credentials this package has
 *   no business holding, to do a thing the product deliberately does not offer;
 * - transferring ownership first would need a second account in the new organization, which means
 *   an invitation and an accept — two rate-limited operations spent per run to arrive at an
 *   offboarded owner and an *empty* organization still sitting in the table.
 *
 * So one registration run leaves one organization, one owner, that owner's session rows and the
 * audit lines of the registration, permanently. The growth is a row per run rather than the
 * seventy-eight-person directory that made the account sweep necessary, and it is confined to
 * tables no scenario reads — `GET /employees` is scoped to the caller's own organization, so these
 * organizations cannot slow another run's screen down the way the stray colleagues did.
 *
 * **What is bought with it is the one criterion of EPIC-010 that has no other proof**: that an
 * installation can be started from a browser at all. Every other scenario in this suite begins from
 * an organization the seed created, so a registration screen could break completely and the run
 * would stay green.
 *
 * ## What an operator does about it
 *
 * The slug and the address both carry `TEST_ACCOUNT_MARKER`, so the residue of every run this
 * harness ever made is one query away and can never be confused with a real tenant:
 *
 * ```sql
 * SELECT id, slug, created_at FROM organizations WHERE slug LIKE 'e2e-sweepable-%' ORDER BY created_at;
 * ```
 *
 * On a developer laptop the answer is `pnpm docker:reset`; on the CI runner the database is thrown
 * away with the container at the end of the job, so nothing accumulates there at all.
 */

/**
 * A slug no other run has used, inside what the contract accepts.
 *
 * `OrganizationSlug.pattern` is lower-case latin, digits and single hyphens, so a UUID's hyphens
 * are fine and its hex is already in range — the only thing removed is the length. Eight digits
 * against one organization per run is four billion to one.
 */
export const testOrganizationSlug = (): string =>
  `${TEST_ACCOUNT_MARKER}-${randomUUID().slice(0, 8)}`;

/**
 * The address of the owner this run invents, on its own organization's domain.
 *
 * Not `testAccountEmail`, which puts every colleague on `org-a.local`: this account is the owner of
 * a *different* organization, and an address claiming the seeded one would read, to anybody looking
 * at the table later, as a member of it. The marker is what the sweep and the query above match on,
 * and it is present in both halves.
 */
export const testOrganizationOwnerEmail = (slug: string): string =>
  `${TEST_ACCOUNT_MARKER}-owner@${slug}.local`;
