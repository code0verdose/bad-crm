import { randomUUID } from 'node:crypto';

import { request as apiRequestContext, type Browser, type Page } from '@playwright/test';

import { expect, test } from '../../fixtures/session.fixture.js';
import { roleAccountEmail } from '../../fixtures/role-account.js';
import { SEED_ORGANIZATION_A, SEED_PASSWORD } from '../../fixtures/seed-data.js';
import {
  apiSessionFor,
  ownerApiSession,
  provisionColleague,
  systemRoleId,
  testAccountEmail,
  type ApiSession,
} from '../../fixtures/test-account.js';
import { audit } from '../support/audit.util.js';

/**
 * `/projects/$projectId` (STORY-014-05, client half).
 *
 * Two properties a component test cannot see, because both are about what the **route tree**
 * decides before anything is drawn, and one that needs the real permission ladder rather than a
 * mocked DTO:
 *
 * - a project a caller may not see refuses `beforeLoad: requireProjectAccess` exactly like an id
 *   that never named a row — acceptance 2, and the reason the two are asserted **side by side**
 *   rather than each against its own expectation: a screen that merely looks like the generic 404
 *   would still pass a test that only checks one of them;
 * - the danger zone of `/projects/$projectId/settings` is drawn from the card's `permissions`
 *   block alone (acceptance 5) — which the server computes from the caller's resource ACL level on
 *   *this* project, not from their role. A `MEMBER` (`EDITOR` on the chain) and the project's `LEAD`
 *   (`MANAGER`) are the same organization, the same endpoint, the same component; only the level
 *   differs, which is what makes this a permission-model assertion and not a component prop test.
 *
 * Data goes in through the product's own API, as `project-list.spec.ts` explains: never a direct
 * insert, and every mutating call signs in fresh immediately before it — seating `admin` as a
 * project's `LEAD` bumps *their own* `permissions_version` (`CreateProjectUseCase` seats the
 * creator and the lead as the first two memberships), which would make a session reused from an
 * earlier call answer `401 unauthenticated` rather than the assertion under test.
 *
 * **The `MEMBER` in the danger-zone scenario is a one-off colleague, not the standing `developer`
 * role account.** Measured 2026-09-27: `membership-invalidates-permissions.spec.ts` seats and
 * removes the *standing* `developer` account on a project of its own, in whatever worker Playwright
 * happens to run it in; that bumps `developer`'s `permissions_version` at a moment this file cannot
 * predict, and a browser session already signed in as `developer` reads the bump as a stale access
 * token — a raw route error, not the assertion under test. A colleague this file provisions and
 * never touches again has no such neighbour. The stranger-project scenario keeps the standing
 * `developer` role, because it never becomes a member of anything and so is never bumped.
 */

const projectKey = (): string => `E2E${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
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

/** Seats a colleague on a project through the product's own endpoint — never a direct insert. */
const addProjectMember = async (
  actor: ApiSession,
  projectId: string,
  options: {
    readonly userId: string;
    readonly projectRole: 'MEMBER';
    readonly allocationPct: number;
  },
): Promise<void> => {
  const response = await actor.context.post(`/api/v1/projects/${projectId}/members`, {
    headers: { ...actor.headers, 'Idempotency-Key': randomUUID() },
    data: options,
  });

  expect(response.ok(), await response.text()).toBe(true);
};

/**
 * A session minted just before its call still answered `401 unauthenticated` — the login and the
 * call it authorised were on either side of a *sibling worker's* own project creation, which seats
 * that worker's owner or lead and bumps their `permissions_version` in between. `expect`'s custom
 * failure message (the response body) is what carries the code this far.
 */
const isStaleSessionError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('"code":"unauthenticated"');

/** How many times a narrow cross-worker race is retried before it counts as a real failure. */
const MAX_SESSION_ATTEMPTS = 4;

/**
 * Runs one call under its own, freshly minted session of the kind `mint` produces, retrying with
 * another fresh session if the previous one turns out already stale (see `isStaleSessionError`).
 *
 * Safe to retry: every caller below hands in exactly one mutating request, and a `401` means the
 * gate refused it before anything was written — never a request that partly succeeded.
 */
const withRetriedSession = async <T>(
  mint: () => Promise<ApiSession>,
  action: (session: ApiSession) => Promise<T>,
): Promise<T> => {
  for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt += 1) {
    const session = await mint();

    try {
      return await action(session);
    } catch (error) {
      if (attempt === MAX_SESSION_ATTEMPTS || !isStaleSessionError(error)) throw error;
    } finally {
      await session.context.dispose();
    }
  }

  // Unreachable: the loop above always either returns or throws on its last attempt.
  throw new Error('withRetriedSession: exhausted attempts without returning or throwing');
};

/**
 * Runs one owner-authenticated call — see the file doc on why a reused token goes stale after the
 * first seat, and `isStaleSessionError` above for the cross-worker version of the same staleness.
 */
const withOwnerSession = async <T>(action: (owner: ApiSession) => Promise<T>): Promise<T> =>
  withRetriedSession(() => ownerApiSession(SEED_ORGANIZATION_A), action);

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

/**
 * A signed-in page for an account outside `session.fixture.ts`'s closed `FixtureRole` list — the
 * one-off colleague this file provisions for the `MEMBER` scenario. Mirrors that file's own
 * `mintSession`/`signedInPage` (same login, same same-origin `/auth/refresh` exchange, same reason
 * for both), duplicated here because those two are not exported and take only a `FixtureRole`.
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

test.describe('the project card', () => {
  // Serial for the same reason `project-list.spec.ts` is: the fixtures below race a sibling
  // worker's own fresh login of the same seeded owner and standing role accounts otherwise.
  test.describe.configure({ mode: 'serial' });

  let strangerProject: CreatedProject;
  let memberProject: CreatedProject;
  let memberColleagueEmail: string;

  test.beforeAll(async () => {
    const admin = await apiSessionFor(roleAccountEmail(SEED_ORGANIZATION_A, 'admin'));

    try {
      // Nobody but its own creator (the owner) is ever seated on this one.
      strangerProject = await withOwnerSession((owner) =>
        createProject(owner, { label: 'Stranger', visibility: 'PRIVATE', leadId: owner.userId }),
      );

      // `admin` becomes its LEAD (MANAGER on the chain) at creation.
      memberProject = await withOwnerSession((owner) =>
        createProject(owner, { label: 'Member', visibility: 'PRIVATE', leadId: admin.userId }),
      );
    } finally {
      await admin.context.dispose();
    }

    // A one-off colleague — see the file doc on why the `MEMBER` scenario does not use the
    // standing `developer` role account. `developer`'s own system role is reused for it only as a
    // convenient, already-minimal capability set (`project:read` and nothing project-shaped
    // beyond it) — this is a fresh person, not that account.
    const colleague = await withOwnerSession(async (owner) => {
      const roleId = await systemRoleId(owner, 'developer');

      return provisionColleague(owner, {
        email: testAccountEmail('project-member'),
        roleId,
      });
    });

    memberColleagueEmail = colleague.email;

    await withOwnerSession((owner) =>
      addProjectMember(owner, memberProject.id, {
        userId: colleague.userId,
        projectRole: 'MEMBER',
        allocationPct: 100,
      }),
    );
  });

  test.afterAll(async () => {
    await withOwnerSession((owner) => removeProject(owner, strangerProject.id));
    await withOwnerSession((owner) => removeProject(owner, memberProject.id));
    // Belt beside the global teardown's braces: this run's own colleague swept immediately,
    // rather than waiting for the suite-wide sweep by marker.
    await withOwnerSession(async (owner) => {
      const response = await owner.context.get(
        `/api/v1/employees?${new URLSearchParams({ q: memberColleagueEmail, perPage: '10' }).toString()}`,
        { headers: owner.headers },
      );

      if (!response.ok()) return;

      const { items } = (await response.json()) as { items: readonly { userId: string }[] };
      const [row] = items;

      if (row === undefined) return;

      await owner.context.post(`/api/v1/users/${row.userId}/deactivate`, {
        headers: { ...owner.headers, 'Idempotency-Key': randomUUID() },
        data: { reason: 'end-to-end run finished' },
      });
    });
  });

  test.describe('a project the caller may not see', () => {
    test.use({ role: 'developer' });

    test('is the same screen, with the same way out, as one that never existed', async ({
      rolePage,
    }) => {
      await rolePage.goto(`/projects/${strangerProject.id}`);

      const heading = rolePage.getByRole('heading', { level: 1 });

      await expect(heading).toBeVisible();
      const strangerHeadingText = await heading.textContent();

      const backLink = rolePage.getByRole('link', { name: 'Back to projects' });

      await expect(backLink).toBeVisible();
      // CONTROL: the generic 404's own way out is not offered beside it — one action, the
      // project's, so «leads to the list» below is not tripping over a second, unrelated link.
      await expect(rolePage.getByRole('link', { name: 'Back to the dashboard' })).toHaveCount(0);

      await rolePage.goto(`/projects/${randomUUID()}`);

      await expect(rolePage.getByRole('heading', { level: 1 })).toHaveText(
        strangerHeadingText ?? '',
      );
      await expect(rolePage.getByRole('link', { name: 'Back to projects' })).toBeVisible();

      await rolePage.getByRole('link', { name: 'Back to projects' }).click();
      // The list carries its own default query (view, sort, pagination) — matched on the path
      // alone, the way `project-list.spec.ts` reads a filter back out of the address.
      await expect(rolePage).toHaveURL(/^http:\/\/[^/]+\/projects(?:\?.*)?$/);
    });
  });

  test.describe('the settings danger zone', () => {
    test('a MEMBER sees neither the archive nor the delete action', async ({ browser }) => {
      await withColleaguePage(browser, memberColleagueEmail, async (page) => {
        await page.goto(`/projects/${memberProject.id}/settings`);

        await expect(
          page.getByText('There is nothing on this project you can change.'),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'Archive project' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Delete project' })).toHaveCount(0);
      });
    });

    test.describe('the project’s LEAD', () => {
      test.use({ role: 'admin' });

      test('sees both, and neither is disabled', async ({ rolePage }) => {
        await rolePage.goto(`/projects/${memberProject.id}/settings`);

        await expect(rolePage.getByRole('button', { name: 'Archive project' })).toBeEnabled();
        await expect(rolePage.getByRole('button', { name: 'Delete project' })).toBeEnabled();
      });
    });
  });

  test('the card has no A or AA accessibility violation', async ({ ownerPage }) => {
    await ownerPage.goto(`/projects/${memberProject.id}`);
    await expect(
      ownerPage.getByRole('heading', { level: 2, name: memberProject.name }),
    ).toBeVisible();

    await audit(ownerPage);
  });
});
