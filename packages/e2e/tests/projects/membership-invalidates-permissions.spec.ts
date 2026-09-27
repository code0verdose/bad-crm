import { randomUUID } from 'node:crypto';

import { request as apiRequestContext, type Browser, type Page } from '@playwright/test';

import { expect, test } from '../../fixtures/session.fixture.js';
import { SEED_ORGANIZATION_A, SEED_PASSWORD } from '../../fixtures/seed-data.js';
import {
  ownerApiSession,
  provisionColleague,
  systemRoleId,
  testAccountEmail,
  type ApiSession,
} from '../../fixtures/test-account.js';

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
 *
 * **The colleague is a one-off account this file provisions, not the standing `developer` role
 * account.** This scenario adds and removes a membership twice over — exactly the kind of mutation
 * that bumps its subject's `permissions_version` — and `project-overview.spec.ts` signs in as that
 * same standing account to read a project it is deliberately never added to. Sharing the account
 * would let this file's membership churn go stale under that file's already-open browser session in
 * whichever worker Playwright happens to schedule them into, which is a race between two files
 * rather than anything either one asserts. A colleague neither file otherwise touches removes the
 * neighbour instead of trying to out-time it.
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
 * A session minted just before its call still answered `401 unauthenticated` — the login and the
 * call it authorised were on either side of a *sibling worker's* own project creation, which seats
 * that worker's owner and bumps `permissions_version` in between. `expect`'s custom failure message
 * (the response body) is what carries the code this far.
 */
const isStaleSessionError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('"code":"unauthenticated"');

/** How many times a narrow cross-worker race is retried before it counts as a real failure. */
const MAX_SESSION_ATTEMPTS = 4;

/**
 * Runs one owner-authenticated call under its own, freshly minted session, retrying with another
 * fresh one if the previous session turns out already stale (see `isStaleSessionError`).
 *
 * Safe to retry: every caller below hands in exactly one mutating request, and a `401` means the
 * gate refused it before anything was written — never a request that partly succeeded.
 */
const withOwnerSession = async <T>(action: (owner: ApiSession) => Promise<T>): Promise<T> => {
  for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt += 1) {
    const owner = await ownerApiSession(SEED_ORGANIZATION_A);

    try {
      return await action(owner);
    } catch (error) {
      if (attempt === MAX_SESSION_ATTEMPTS || !isStaleSessionError(error)) throw error;
    } finally {
      await owner.context.dispose();
    }
  }

  // Unreachable: the loop above always either returns or throws on its last attempt.
  throw new Error('withOwnerSession: exhausted attempts without returning or throwing');
};

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

/**
 * A signed-in page for an account outside `session.fixture.ts`'s closed `FixtureRole` list — the
 * one-off colleague this file provisions. Mirrors that file's own `mintSession`/`signedInPage` (same
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

test.describe('project membership and live access', () => {
  // Serial: the project below and the single colleague added to and removed from it are state the
  // scenario builds on in order.
  test.describe.configure({ mode: 'serial' });

  let project: CreatedProject;
  let colleagueId: string;
  let colleagueEmail: string;

  test.beforeAll(async () => {
    project = await withOwnerSession((owner) =>
      createProject(owner, { label: 'Live-access', visibility: 'PRIVATE', leadId: owner.userId }),
    );

    // A one-off colleague — see the file doc on why this scenario does not sign in as the standing
    // `developer` role account.
    const colleague = await withOwnerSession(async (owner) => {
      const roleId = await systemRoleId(owner, 'developer');

      return provisionColleague(owner, {
        email: testAccountEmail('live-access'),
        roleId,
      });
    });

    colleagueId = colleague.userId;
    colleagueEmail = colleague.email;
  });

  test.afterAll(async () => {
    await withOwnerSession((owner) => removeProject(owner, project.id));
    // Belt beside the global teardown's braces: this run's own colleague swept immediately.
    await withOwnerSession(async (owner) => {
      const response = await owner.context.post(`/api/v1/users/${colleagueId}/deactivate`, {
        headers: { ...owner.headers, 'Idempotency-Key': randomUUID() },
        data: { reason: 'end-to-end run finished' },
      });

      // Best-effort: a project already removed above leaves this call nothing new to revoke.
      void response;
    });
  });

  test('a colleague gains and loses access on the very next request, with no sign-in in between', async ({
    browser,
  }) => {
    await withColleaguePage(browser, colleagueEmail, async (page) => {
      // Not on the project yet: the same closed-contour 404 as a project this person was never
      // told about.
      await page.goto(`/projects/${project.id}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeVisible();

      // The product's own endpoint, from a session that owns none of this scenario's assertions —
      // the owner is the project's lead (`MANAGER` on the chain), so a fresh owner session is what
      // `project-list.spec.ts` also uses to make a change to a project it just created.
      await withOwnerSession((owner) =>
        addProjectMember(owner, project.id, {
          userId: colleagueId,
          projectRole: 'MEMBER',
          allocationPct: 100,
        }),
      );

      // No new sign-in: the same browser context reloads, which is all a client keeping its access
      // token in memory ever does to resume a session — and it is enough, because there is no
      // server-side permission cache standing between the reload and the fresh grant.
      await page.reload();
      await expect(page.getByRole('heading', { level: 2, name: project.name })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Nothing here' })).toHaveCount(0);

      await withOwnerSession((owner) => removeProjectMember(owner, project.id, colleagueId));

      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: project.name })).toHaveCount(0);
    });
  });
});
