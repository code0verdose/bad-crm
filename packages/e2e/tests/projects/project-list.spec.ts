import { randomUUID } from 'node:crypto';

import { request as apiRequestContext, type Browser, type Page } from '@playwright/test';

import { ensureScenarioColleague, withOwnerSession } from '../../fixtures/fresh-session.util.js';
import { SEED_ORGANIZATION_A, SEED_PASSWORD } from '../../fixtures/seed-data.js';
import { expect, test } from '../../fixtures/session.fixture.js';
import { type ApiSession } from '../../fixtures/test-account.js';
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
 * The stranger side of the visibility check is the standing `developer` role account of
 * `role-account.ts` — read-only here (never seated on anything this file creates), so nothing in
 * this file bumps its `permissions_version` and a sibling file signed in as the same account races
 * nothing. It holds `project:read` (`SYSTEM_ROLE_PERMISSIONS`), so the difference measured below is
 * the resource ACL, not the capability — a stranger who could not even open `/projects` would pass
 * this file for the wrong reason.
 *
 * **The member/lead side is a reusable scenario colleague (`ensureScenarioColleague`), not the
 * standing `admin` role account.** Measured 2026-09-27: `project-overview.spec.ts` also makes
 * `admin` the `LEAD` of a project of its own, in whatever worker Playwright happens to run it in —
 * that bumps `admin`'s `permissions_version` at a moment this file cannot predict, and a browser
 * session already signed in as `admin` reads the bump as a stale access token rather than the list
 * this test asks about. A colleague neither this file nor any other seats on anything but its own
 * scenario's project has no such neighbour — and reused rather than reinvited every run, because a
 * one-off colleague per run would spend this machine's `invitation_accept` budget three times over
 * across the three files in this directory, run back to back (`fresh-session.util.ts`).
 *
 * **Every mutating API call signs in fresh, immediately before it**, and retries once more with
 * another fresh session if that one turns out to have gone stale between minting and use — the same
 * cross-worker race `fresh-session.util.ts` explains: seating a membership bumps the subject's
 * `permissions_version` in the same transaction (`project-member.repository.ts`,
 * `bumpPermissionsVersionOf`), which is exactly what an already-issued access token carries a
 * snapshot of (`authenticate-session.query.ts`).
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

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

/**
 * A signed-in page for an account outside `session.fixture.ts`'s closed `FixtureRole` list — the
 * reusable, deterministic scenario colleague (`ensureScenarioColleague`) this file signs in as for
 * the member/lead side of the visibility check. Mirrors that file's own `mintSession`/`signedInPage`
 * (same login, same same-origin `/auth/refresh` exchange, same reason for both), duplicated here
 * because those two are not exported and take only a `FixtureRole`.
 */
const withColleaguePage = async (
  browser: Browser,
  email: string,
  body: (page: Page) => Promise<void>,
): Promise<void> => {
  const login = await apiRequestContext.newContext({
    baseURL: apiURL(),
    extraHTTPHeaders: { origin: browserOrigin() },
  });

  let storageState: Awaited<ReturnType<typeof login.storageState>>;

  try {
    const signedIn = await login.post('/api/v1/auth/login', {
      data: { email, password: SEED_PASSWORD },
    });

    expect(signedIn.ok(), await signedIn.text()).toBe(true);

    const resumed = await login.post('/api/v1/auth/refresh');

    expect(resumed.ok(), await resumed.text()).toBe(true);

    storageState = await login.storageState();
  } finally {
    await login.dispose();
  }

  const context = await browser.newContext({ storageState });
  const page = await context.newPage();

  try {
    await body(page);
  } finally {
    await context.close();
  }
};

test.describe('the projects screen', () => {
  // Serial, deliberately: every scenario below reads the two projects `beforeAll` seats, and seating
  // a membership bumps the *subject's* `permissions_version` for every session of theirs, anywhere —
  // not only the one that made the call. Running this file's tests across parallel workers races
  // that bump against a sibling worker's own fresh owner login (same organization, same owner
  // account) and answers `401 unauthenticated` to whichever call loses — a fixture problem the
  // product's own token model creates, not a defect in it. Serial keeps the whole file, seed
  // included, on one worker and off that race. Cross-*file* races of the same shape are handled by
  // `withOwnerSession`'s retry (`fresh-session.util.ts`) and by never seating the standing `admin`
  // role account on anything (see the file doc).
  test.describe.configure({ mode: 'serial' });

  let publicProject: CreatedProject;
  let privateProject: CreatedProject;
  let leadColleagueEmail: string;

  test.beforeAll(async () => {
    publicProject = await withOwnerSession(SEED_ORGANIZATION_A, (owner) =>
      createProject(owner, { label: 'Public', visibility: 'PUBLIC_ORG', leadId: owner.userId }),
    );

    // A reusable scenario colleague — see the file doc on why the member/lead side does not use
    // the standing `admin` role account. `developer`'s own system role is reused for it only as a
    // convenient, already-minimal capability set (`project:read` and nothing project-shaped beyond
    // it) — this is a fresh person, not that account.
    const colleague = await withOwnerSession(SEED_ORGANIZATION_A, (owner) =>
      ensureScenarioColleague(owner, SEED_ORGANIZATION_A, 'project-list-lead', 'developer'),
    );

    leadColleagueEmail = colleague.email;

    privateProject = await withOwnerSession(SEED_ORGANIZATION_A, (owner) =>
      createProject(owner, { label: 'Private', visibility: 'PRIVATE', leadId: colleague.userId }),
    );
  });

  test.afterAll(async () => {
    await withOwnerSession(SEED_ORGANIZATION_A, (owner) => removeProject(owner, publicProject.id));
    await withOwnerSession(SEED_ORGANIZATION_A, (owner) => removeProject(owner, privateProject.id));
    // The scenario colleague is not deactivated here — `ensureScenarioColleague`'s doc explains why
    // it is meant to outlive the run, the same as the standing role accounts.
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

  test('a private project’s lead sees it in their own list', async ({ browser }) => {
    await withColleaguePage(browser, leadColleagueEmail, async (page) => {
      await page.goto(`/projects?view=table&q=${encodeURIComponent(privateProject.name)}`);

      const table = page.getByRole('table');

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
