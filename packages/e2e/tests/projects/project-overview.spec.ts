import { randomUUID } from 'node:crypto';

import { request as apiRequestContext, type Browser, type Page } from '@playwright/test';

import {
  ensureScenarioColleague,
  grantPermissionOverride,
  withOwnerSession,
} from '../../fixtures/fresh-session.util.js';
import { SEED_ORGANIZATION_A, SEED_PASSWORD } from '../../fixtures/seed-data.js';
import { expect, test } from '../../fixtures/session.fixture.js';
import { type ApiSession } from '../../fixtures/test-account.js';
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
 * insert, and every mutating call signs in fresh immediately before it — seating somebody as a
 * project's `LEAD` bumps *their own* `permissions_version` (`CreateProjectUseCase` seats the
 * creator and the lead as the first two memberships), which would make a session reused from an
 * earlier call answer `401 unauthenticated` rather than the assertion under test.
 *
 * **Both the `MEMBER` and the `LEAD` of the danger-zone scenario are reusable scenario colleagues
 * (`ensureScenarioColleague`, `fresh-session.util.ts`), never the standing `admin`/`developer` role
 * accounts.** Measured 2026-09-27: `tests/rbac/role-fixtures.spec.ts` and
 * `tests/security/org-2fa-policy.spec.ts` both sign in as the standing `admin` account and keep a
 * browser session of it open; seating that same account as a project's `LEAD` here bumps `admin`'s
 * `permissions_version` at a moment neither of those files can predict, and their already-open
 * session reads the bump as a stale access token — a raw route error, not the assertion under test.
 * `project-list.spec.ts` closed exactly this race for its own lead by moving off `admin`; a colleague
 * neither file seats on anything but its own scenario's project has no such neighbour, whichever role
 * it is given. **Both colleagues stay on the `developer` system role** — `MANAGER` on the resource
 * chain is not enough on its own for the lead: `project:archive`/`project:delete`/
 * `project:manage_members` are capabilities the caller must also hold
 * (`docs/security/permission-model.md` §7 (е)), and the obvious fix, a stronger system role, was
 * measured 2026-09-27 to break a *different* file: `tests/security/org-2fa-policy.spec.ts` asserts an
 * exact headcount of who holds the `admin` role in this organization, and a fourth `admin` here turned
 * that count, and that file, red. `grantPermissionOverride` (`fresh-session.util.ts`) grants the three
 * capabilities to this one person instead — layer 3 of the permission model, invisible to a report
 * that counts role holders. Every scenario colleague here is reused across runs rather than
 * reinvited, because a one-off colleague per run would spend this machine's `invitation_accept`
 * budget three times over across the three files in `tests/projects/`, run back to back. The
 * stranger-project scenario keeps the standing `developer` role for its browser session, because it
 * is never seated on anything and so is never bumped.
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

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

/**
 * A signed-in page for an account outside `session.fixture.ts`'s closed `FixtureRole` list — the
 * reusable, deterministic scenario colleagues this file signs in as for the `MEMBER` and `LEAD`
 * halves of the danger-zone scenario. Mirrors that file's own `mintSession`/`signedInPage` (same
 * login, same same-origin `/auth/refresh` exchange, same reason for both), duplicated here because
 * those two are not exported and take only a `FixtureRole`.
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
  let leadColleagueEmail: string;
  let memberColleagueEmail: string;

  test.beforeAll(async () => {
    // Nobody but its own creator (the owner) is ever seated on this one.
    strangerProject = await withOwnerSession(SEED_ORGANIZATION_A, (owner) =>
      createProject(owner, { label: 'Stranger', visibility: 'PRIVATE', leadId: owner.userId }),
    );

    // Reusable scenario colleagues — see the file doc on why the `LEAD` and `MEMBER` halves of the
    // danger-zone scenario never use the standing `admin`/`developer` role accounts, and why the
    // lead stays on the `developer` system role rather than a stronger one.
    const [lead, member] = await withOwnerSession(SEED_ORGANIZATION_A, (owner) =>
      Promise.all([
        ensureScenarioColleague(owner, SEED_ORGANIZATION_A, 'project-overview-lead', 'developer'),
        ensureScenarioColleague(owner, SEED_ORGANIZATION_A, 'project-overview-member', 'developer'),
      ]),
    );

    leadColleagueEmail = lead.email;
    memberColleagueEmail = member.email;

    // The lead needs the danger-zone capabilities beyond what `developer` holds — granted to this
    // one person, additively, rather than by a stronger system role (see the file doc and
    // `ensureScenarioColleague`'s in `fresh-session.util.ts`).
    await withOwnerSession(SEED_ORGANIZATION_A, (owner) =>
      Promise.all(
        (['project:archive', 'project:delete', 'project:manage_members'] as const).map(
          (permission) =>
            grantPermissionOverride(
              owner,
              lead.userId,
              permission,
              'e2e project-overview.spec.ts danger-zone scenario',
            ),
        ),
      ),
    );

    // The lead colleague becomes MANAGER on the chain at creation.
    memberProject = await withOwnerSession(SEED_ORGANIZATION_A, (owner) =>
      createProject(owner, { label: 'Member', visibility: 'PRIVATE', leadId: lead.userId }),
    );

    await withOwnerSession(SEED_ORGANIZATION_A, (owner) =>
      addProjectMember(owner, memberProject.id, {
        userId: member.userId,
        projectRole: 'MEMBER',
        allocationPct: 100,
      }),
    );
  });

  test.afterAll(async () => {
    await withOwnerSession(SEED_ORGANIZATION_A, (owner) =>
      removeProject(owner, strangerProject.id),
    );
    await withOwnerSession(SEED_ORGANIZATION_A, (owner) => removeProject(owner, memberProject.id));
    // Neither scenario colleague is deactivated here — `ensureScenarioColleague`'s doc explains why
    // both are meant to outlive the run, the same as the standing role accounts.
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

    test('the project’s LEAD sees both, and neither is disabled', async ({ browser }) => {
      await withColleaguePage(browser, leadColleagueEmail, async (page) => {
        await page.goto(`/projects/${memberProject.id}/settings`);

        await expect(page.getByRole('button', { name: 'Archive project' })).toBeEnabled();
        await expect(page.getByRole('button', { name: 'Delete project' })).toBeEnabled();
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
