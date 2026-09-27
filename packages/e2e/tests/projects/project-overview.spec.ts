import { randomUUID } from 'node:crypto';

import { expect, test } from '../../fixtures/session.fixture.js';
import { roleAccountEmail } from '../../fixtures/role-account.js';
import { SEED_ORGANIZATION_A } from '../../fixtures/seed-data.js';
import { apiSessionFor, ownerApiSession, type ApiSession } from '../../fixtures/test-account.js';
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
 * Runs one owner-authenticated call under its own, freshly minted session — see the file doc on why
 * a reused token goes stale after the first seat.
 */
const withOwnerSession = async <T>(action: (owner: ApiSession) => Promise<T>): Promise<T> => {
  const owner = await ownerApiSession(SEED_ORGANIZATION_A);

  try {
    return await action(owner);
  } finally {
    await owner.context.dispose();
  }
};

test.describe('the project card', () => {
  // Serial for the same reason `project-list.spec.ts` is: the fixtures below race a sibling
  // worker's own fresh login of the same seeded owner and standing role accounts otherwise.
  test.describe.configure({ mode: 'serial' });

  let strangerProject: CreatedProject;
  let memberProject: CreatedProject;

  test.beforeAll(async () => {
    const admin = await apiSessionFor(roleAccountEmail(SEED_ORGANIZATION_A, 'admin'));
    const developer = await apiSessionFor(roleAccountEmail(SEED_ORGANIZATION_A, 'developer'));

    try {
      // Nobody but its own creator (the owner) is ever seated on this one.
      strangerProject = await withOwnerSession((owner) =>
        createProject(owner, { label: 'Stranger', visibility: 'PRIVATE', leadId: owner.userId }),
      );

      // `admin` becomes its LEAD (MANAGER on the chain) at creation.
      memberProject = await withOwnerSession((owner) =>
        createProject(owner, { label: 'Member', visibility: 'PRIVATE', leadId: admin.userId }),
      );

      // A fresh session: the seat above just bumped `admin`'s own `permissions_version`.
      const freshAdmin = await apiSessionFor(roleAccountEmail(SEED_ORGANIZATION_A, 'admin'));

      try {
        await addProjectMember(freshAdmin, memberProject.id, {
          userId: developer.userId,
          projectRole: 'MEMBER',
          allocationPct: 100,
        });
      } finally {
        await freshAdmin.context.dispose();
      }
    } finally {
      await admin.context.dispose();
      await developer.context.dispose();
    }
  });

  test.afterAll(async () => {
    await withOwnerSession((owner) => removeProject(owner, strangerProject.id));
    await withOwnerSession((owner) => removeProject(owner, memberProject.id));
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
      await expect(rolePage).toHaveURL(/\/projects$/);
    });
  });

  test.describe('the settings danger zone', () => {
    test.describe('a MEMBER', () => {
      test.use({ role: 'developer' });

      test('sees neither the archive nor the delete action', async ({ rolePage }) => {
        await rolePage.goto(`/projects/${memberProject.id}/settings`);

        await expect(
          rolePage.getByText('There is nothing on this project you can change.'),
        ).toBeVisible();
        await expect(rolePage.getByRole('button', { name: 'Archive project' })).toHaveCount(0);
        await expect(rolePage.getByRole('button', { name: 'Delete project' })).toHaveCount(0);
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
