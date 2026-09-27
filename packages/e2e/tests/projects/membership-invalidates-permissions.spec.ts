import { randomUUID } from 'node:crypto';

import { expect, test } from '../../fixtures/session.fixture.js';
import { roleAccountEmail } from '../../fixtures/role-account.js';
import { SEED_ORGANIZATION_A } from '../../fixtures/seed-data.js';
import { apiSessionFor, ownerApiSession, type ApiSession } from '../../fixtures/test-account.js';

/**
 * Membership as access, live (STORY-014-02, acceptance 4; STORY-014-05, acceptance 2).
 *
 * The story's own note explains why this is worth an end-to-end scenario rather than a unit test on
 * the use-case: `permissionsVersion` exists and is bumped in the same transaction as the roster
 * change, but there is **no server-side permission cache for it to invalidate** — the actor is
 * rebuilt from scratch on every request (`application/iam/use-cases/build-actor.query.ts`). So «acts
 * from the next request, without signing in again» is not a cache-eviction path that could be
 * mocked; it is a property of there being nothing to evict, and the only way to see it is to ask the
 * running server twice, before and after, through the same browser session.
 *
 * The browser half matters as much as the server half: the client keeps its access token **in
 * memory only** (`CLAUDE.md` → EPIC-006), so a full page reload always re-establishes the session
 * through the httpOnly refresh cookie rather than reusing a cached token — which is what makes a
 * plain `page.reload()` the right way to ask «what can this person do now», with nothing about the
 * sign-in form exercised a second time.
 *
 * The project is `PRIVATE`: a stranger's `404` and a member's `200` on the same address is the
 * clearest version of «this row grants nothing to organization membership alone» — the same
 * closed-contour behaviour `project-overview.spec.ts` checks for a project the caller is never
 * added to.
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

/** Ends a membership — `leftAt`, not a row removed (STORY-014-02, acceptance 5). */
const removeProjectMember = async (
  actor: ApiSession,
  projectId: string,
  userId: string,
): Promise<void> => {
  const response = await actor.context.delete(`/api/v1/projects/${projectId}/members/${userId}`, {
    headers: actor.headers,
  });

  expect(response.ok(), await response.text()).toBe(true);
};

/**
 * Runs one owner-authenticated call under its own, freshly minted session — `project-list.spec.ts`
 * explains why a reused token goes stale after the first seat.
 */
const withOwnerSession = async <T>(action: (owner: ApiSession) => Promise<T>): Promise<T> => {
  const owner = await ownerApiSession(SEED_ORGANIZATION_A);

  try {
    return await action(owner);
  } finally {
    await owner.context.dispose();
  }
};

/**
 * Runs one admin-authenticated call under its own, freshly minted session.
 *
 * Never the same admin session twice in this file: seating admin as the project's own `LEAD` at
 * creation, and every roster change after it, bumps `admin`'s or the target's `permissions_version`
 * in ways that would make a session opened before the change answer `401 unauthenticated` to a call
 * made after it — indistinguishable from a broken fixture.
 */
const withAdminSession = async <T>(action: (admin: ApiSession) => Promise<T>): Promise<T> => {
  const admin = await apiSessionFor(roleAccountEmail(SEED_ORGANIZATION_A, 'admin'));

  try {
    return await action(admin);
  } finally {
    await admin.context.dispose();
  }
};

test.describe('project membership and live access', () => {
  // Serial: this file's project and its membership are shared state the two mutations below build
  // on in order, on the same seeded organization and role accounts every other e2e file also uses.
  test.describe.configure({ mode: 'serial' });

  let project: CreatedProject;
  let developerId: string;

  test.beforeAll(async () => {
    const developer = await apiSessionFor(roleAccountEmail(SEED_ORGANIZATION_A, 'developer'));

    try {
      developerId = developer.userId;
    } finally {
      await developer.context.dispose();
    }

    project = await withOwnerSession((owner) =>
      createProject(owner, { label: 'Live-access', visibility: 'PRIVATE', leadId: owner.userId }),
    );
  });

  test.afterAll(async () => {
    await withOwnerSession((owner) => removeProject(owner, project.id));
  });

  test.describe('a colleague seated on and removed from a private project', () => {
    test.use({ role: 'developer' });

    test('gains and loses access on the very next request, with no sign-in in between', async ({
      rolePage,
    }) => {
      // Not on the project yet: the same closed-contour 404 as a project this person was never
      // told about.
      await rolePage.goto(`/projects/${project.id}`);
      await expect(rolePage.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeVisible();

      // The product's own endpoint, from a session that owns none of this scenario's assertions.
      await withAdminSession((admin) =>
        addProjectMember(admin, project.id, {
          userId: developerId,
          projectRole: 'MEMBER',
          allocationPct: 100,
        }),
      );

      // No new sign-in: the same browser context reloads, which is all a client keeping its access
      // token in memory ever does to resume a session — and it is enough, because there is no
      // server-side permission cache standing between the reload and the fresh grant.
      await rolePage.reload();
      await expect(rolePage.getByRole('heading', { level: 2, name: project.name })).toBeVisible();
      await expect(rolePage.getByRole('heading', { level: 1, name: 'Nothing here' })).toHaveCount(
        0,
      );

      await withAdminSession((admin) => removeProjectMember(admin, project.id, developerId));

      await rolePage.reload();
      await expect(rolePage.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeVisible();
      await expect(rolePage.getByRole('heading', { level: 2, name: project.name })).toHaveCount(0);
    });
  });
});
