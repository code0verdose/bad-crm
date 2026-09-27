import { randomUUID } from 'node:crypto';

import { expect, test } from '../../fixtures/session.fixture.js';
import { roleAccountEmail } from '../../fixtures/role-account.js';
import { SEED_ORGANIZATION_A } from '../../fixtures/seed-data.js';
import { apiSessionFor, ownerApiSession, type ApiSession } from '../../fixtures/test-account.js';
import { audit } from '../support/audit.util.js';

/**
 * `/projects` (STORY-014-04, client half).
 *
 * Three properties, and each needs the running stack rather than a component test: whether the
 * filter the address bar carries survives a full document reload (acceptance 1 — a component test
 * remounts, it never reloads); whether a `PRIVATE` project is absent from a stranger's list and
 * present on the member's, on the **same screen**, which is the only way «absent» means something
 * rather than an empty or broken list (`rules/testing.mdc` §9.3); and the accessibility of the
 * screen once it has real rows to draw, which the component-level axe pass cannot see because it
 * never renders the page as a whole (`rules/a11y.mdc`).
 *
 * Data goes in through the product's own API — `POST /api/v1/projects` — never a direct insert, for
 * the same reason `test-account.ts` gives for accounts: a harness that reached past the contract
 * would be testing a path the product does not have.
 *
 * The two standing role accounts of `role-account.ts` play the two parts a visibility check needs:
 * `admin` is made the project's lead (and therefore its `LEAD` member — `CreateProjectUseCase`
 * seats the creator and the lead as the first two memberships), `developer` never is. Both hold
 * `project:read` (`SYSTEM_ROLE_PERMISSIONS`), so the difference measured below is the resource ACL,
 * not the capability — a stranger who could not even open `/projects` would pass this file for the
 * wrong reason.
 *
 * **Every mutating call signs in fresh, immediately before it.** Seating a membership bumps the
 * subject's `permissions_version` in the same transaction (`project-member.repository.ts`,
 * `bumpPermissionsVersionOf`), which is exactly what an already-issued access token carries a
 * snapshot of (`authenticate-session.query.ts`) — so the owner's own token goes stale the moment
 * the first `POST /projects` seats them as its lead, and a second call on that same token would be
 * refused `401 unauthenticated`, indistinguishable from a broken fixture. A fresh sign-in per call
 * is the same cost `session.fixture.ts` already pays for the same reason, applied to the API
 * session rather than the browser one.
 */

/** A key this suite invented owns — `PROJECT_KEY_PATTERN`: a letter, then up to nine `[A-Z0-9]`. */
const projectKey = (): string => `E2E${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;

/** A name carrying the same run-local marker the key does, so a row is found by either. */
const projectName = (label: string, key: string): string => `E2E ${label} ${key}`;

interface CreatedProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

const createProject = async (
  owner: ApiSession,
  options: {
    readonly label: string;
    readonly visibility: 'PUBLIC_ORG' | 'PRIVATE';
    readonly leadId: string;
  },
): Promise<CreatedProject> => {
  const key = projectKey();
  const name = projectName(options.label, key);

  const response = await owner.context.post('/api/v1/projects', {
    headers: { ...owner.headers, 'Idempotency-Key': randomUUID() },
    data: {
      key,
      name,
      leadId: options.leadId,
      color: 'blue',
      visibility: options.visibility,
    },
  });

  expect(response.ok(), await response.text()).toBe(true);

  const body = (await response.json()) as { id: string };

  return { id: body.id, key, name };
};

/** Soft-deletes a project this suite created. Best-effort: a run that fails should not fail twice. */
const removeProject = async (owner: ApiSession, id: string): Promise<void> => {
  await owner.context.delete(`/api/v1/projects/${id}`, {
    headers: { ...owner.headers, 'Idempotency-Key': randomUUID() },
  });
};

/**
 * Runs one owner-authenticated call under its own, freshly minted session — never a session another
 * call already spent (see the file doc on why a reused token goes stale after the first seat).
 */
const withOwnerSession = async <T>(action: (owner: ApiSession) => Promise<T>): Promise<T> => {
  const owner = await ownerApiSession(SEED_ORGANIZATION_A);

  try {
    return await action(owner);
  } finally {
    await owner.context.dispose();
  }
};

test.describe('the projects screen', () => {
  // Serial, deliberately: every scenario below reads the two projects `beforeAll` seats, and seating
  // a membership bumps the *subject's* `permissions_version` for every session of theirs, anywhere —
  // not only the one that made the call. Running this file's tests across parallel workers races
  // that bump against a sibling worker's own fresh owner login (same organization, same owner
  // account) and answers `401 unauthenticated` to whichever call loses — a fixture problem the
  // product's own token model creates, not a defect in it. Serial keeps the whole file, seed
  // included, on one worker and off that race.
  test.describe.configure({ mode: 'serial' });

  let publicProject: CreatedProject;
  let privateProject: CreatedProject;

  test.beforeAll(async () => {
    const admin = await apiSessionFor(roleAccountEmail(SEED_ORGANIZATION_A, 'admin'));

    try {
      publicProject = await withOwnerSession((owner) =>
        createProject(owner, { label: 'Public', visibility: 'PUBLIC_ORG', leadId: owner.userId }),
      );
      privateProject = await withOwnerSession((owner) =>
        createProject(owner, { label: 'Private', visibility: 'PRIVATE', leadId: admin.userId }),
      );
    } finally {
      await admin.context.dispose();
    }
  });

  test.afterAll(async () => {
    await withOwnerSession((owner) => removeProject(owner, publicProject.id));
    await withOwnerSession((owner) => removeProject(owner, privateProject.id));
  });

  test('a search query and a status filter survive a full page reload', async ({ ownerPage }) => {
    await ownerPage.goto('/projects?view=table');

    const table = ownerPage.getByRole('table');
    const search = ownerPage.getByRole('searchbox', { name: 'Search' });
    const activeChip = ownerPage.getByRole('group', { name: 'Status' }).getByText('Active');

    await expect(table).toBeVisible();

    // Narrows to the one row this run owns — the control that the query actually reached the URL
    // and the list, rather than being typed and forgotten.
    await search.fill(publicProject.name);
    await expect(table).toContainText(publicProject.name);
    await expect(table.getByRole('row')).toHaveCount(2); // header row + the one match

    // Every project this suite creates is ACTIVE (the column's own default — there is no `status`
    // in the creation body), so adding the filter must not drop the row the query already narrowed
    // to; it would, if this filter and that one were somehow exclusive of each other.
    await activeChip.click();
    await expect(table).toContainText(publicProject.name);

    // Read back through `URLSearchParams` rather than matched as a literal substring: the router
    // encodes a repeated filter as a JSON array (`status=%5B%22ACTIVE%22%5D`) and a space in `q` as
    // `+`, and asserting the query's *meaning* rather than its exact bytes keeps this from being
    // rewritten the day that encoding choice changes for a reason that has nothing to do with §1.
    const paramsOf = (url: string): URLSearchParams => new URL(url).searchParams;

    expect(paramsOf(ownerPage.url()).get('q')).toBe(publicProject.name);
    expect(paramsOf(ownerPage.url()).get('status') ?? '').toContain('ACTIVE');

    const urlBeforeReload = ownerPage.url();

    await ownerPage.reload();

    // The address did not move — nothing on load rewrote or stripped the query the URL carried.
    await expect(ownerPage).toHaveURL(urlBeforeReload);

    // And the screen actually rehydrated from it: the search box shows the typed text again (state
    // read back out of the URL, not a value a fresh mount would leave empty) and the same row is
    // still the one drawn — the positive control against a reload that silently reset the filter to
    // its default and happened to show nothing wrong.
    await expect(ownerPage.getByRole('searchbox', { name: 'Search' })).toHaveValue(
      publicProject.name,
    );
    await expect(ownerPage.getByRole('table')).toContainText(publicProject.name);
    await expect(ownerPage.getByRole('table').getByRole('row')).toHaveCount(2);
  });

  test.describe('a private project', () => {
    test.use({ role: 'developer' });

    test('is absent from a stranger’s list, and present on its member’s', async ({ rolePage }) => {
      // Unfiltered first — the private project's own name would filter straight to the empty
      // state (correctly, for a stranger), which is indistinguishable from a table that never
      // rendered at all if that is the first thing asked of the screen.
      await rolePage.goto('/projects?view=table');

      const table = rolePage.getByRole('table');

      await expect(table).toBeVisible();

      // CONTROL first: the same query, for the project everybody in the organization may see, so
      // an empty result below is known to mean «not on this project» rather than «the list, or the
      // query, is broken for this account».
      await rolePage.getByRole('searchbox', { name: 'Search' }).fill(publicProject.name);
      await expect(table).toContainText(publicProject.name);

      await rolePage.getByRole('searchbox', { name: 'Search' }).fill(privateProject.name);
      // `DataState` draws its empty state **in place of** the table on no match — there is no row
      // to count, the table itself is gone — so the absence is asserted on the screen as a whole.
      await expect(rolePage.getByText('No projects match the filters')).toBeVisible();
      await expect(table).toHaveCount(0);
      await expect(rolePage.getByRole('main')).not.toContainText(privateProject.name);
    });
  });

  test.describe('a private project, the member’s side', () => {
    test.use({ role: 'admin' });

    test('the project’s lead sees it in their own list', async ({ rolePage }) => {
      await rolePage.goto(`/projects?view=table&q=${encodeURIComponent(privateProject.name)}`);

      const table = rolePage.getByRole('table');

      await expect(table).toBeVisible();
      await expect(table).toContainText(privateProject.name);
      await expect(table.getByRole('row')).toHaveCount(2);
    });
  });

  test('the populated list has no A or AA accessibility violation', async ({ ownerPage }) => {
    await ownerPage.goto('/projects?view=table');
    await expect(ownerPage.getByRole('table')).toContainText(publicProject.name);

    await audit(ownerPage);
  });
});
