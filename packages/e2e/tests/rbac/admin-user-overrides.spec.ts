import { AxeBuilder } from '@axe-core/playwright';
import {
  expect,
  request,
  test as apiTest,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';

import {
  SEED_ORGANIZATION_A,
  SEED_ORGANIZATION_B,
  SEED_PASSWORD,
} from '../../fixtures/seed-data.js';
import { test } from '../../fixtures/session.fixture.js';

/**
 * The one scenario STORY-011-11 promises and the checklist never delivered: a full pass through the
 * exceptions screen, from an owner opening a colleague's card to the colleague's own next request
 * actually landing differently (`rules/testing.mdc` §6 — one full happy-path per epic).
 *
 * A component test already puts every row in its three positions
 * (`packages/client/test/widgets/user-permissions.test.tsx`) — this file does not repeat that. What
 * it adds is the thing only a running stack can answer: does denying a permission on this screen
 * change what the person can do, not only what the table says about them. That is «the test that
 * has not been seen red» from `rules/testing.mdc`, and step 6 below is the one assertion this file
 * would be dishonest without.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

const audit = async (page: Page): Promise<void> => {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();

  expect(
    violations.map((violation) => `${violation.id}: ${violation.help}`),
    JSON.stringify(violations, null, 2),
  ).toEqual([]);
};

interface ApiSession {
  readonly context: APIRequestContext;
  readonly headers: { readonly authorization: string; readonly origin: string };
  readonly userId: string;
}

/** Signs in over the API, the way `tenancy/cross-tenant-api.spec.ts` does — a bearer token, not a browser. */
const signInApi = async (email: string, password: string): Promise<ApiSession> => {
  const context = await request.newContext({
    baseURL: apiURL(),
    extraHTTPHeaders: { origin: browserOrigin() },
  });

  const response = await context.post('/api/v1/auth/login', { data: { email, password } });

  expect(response.ok(), await response.text()).toBe(true);

  const body = (await response.json()) as { accessToken: string; user: { id: string } };

  return {
    context,
    headers: { authorization: `Bearer ${body.accessToken}`, origin: browserOrigin() },
    userId: body.user.id,
  };
};

interface RoleEntry {
  readonly id: string;
  readonly key: string;
}

/** The organization's `developer` system role, by id — provisioned for every organization on bootstrap. */
const developerRoleId = async (owner: ApiSession): Promise<string> => {
  const response = await owner.context.get('/api/v1/roles', { headers: owner.headers });

  expect(response.ok(), await response.text()).toBe(true);

  const { items } = (await response.json()) as { items: readonly RoleEntry[] };
  const developer = items.find((role) => role.key === 'developer');

  if (developer === undefined) {
    throw new Error('the organization has no `developer` system role — has provisioning run?');
  }

  return developer.id;
};

/**
 * Invites somebody with the `developer` role and accepts on their behalf — through the same two
 * endpoints the product's own onboarding uses, never a direct insert.
 *
 * The seed ships only the two organization owners
 * (`packages/server/scripts/seed-data.constant.ts`: «Roles are absent, and that is the state of the
 * product rather than an omission… seeding an admin@ or a lead@ now would create accounts identical
 * in rights to the owner and name them as if they were not»), so a scenario about a role-holding,
 * non-owner colleague has to make one itself.
 */
const provisionDeveloperColleague = async (
  owner: ApiSession,
  roleId: string,
): Promise<{ userId: string; email: string }> => {
  const email = `override-target-${randomUUID()}@org-a.local`;

  const invited = await owner.context.post('/api/v1/invitations', {
    headers: { ...owner.headers, 'Idempotency-Key': randomUUID() },
    data: { email, roleId, locale: 'en' },
  });

  expect(invited.ok(), await invited.text()).toBe(true);

  const { inviteUrl } = (await invited.json()) as { inviteUrl: string };
  // The token is the last path segment of `/invite/$token`
  // (`packages/server/src/domain/iam/invitation-mail.util.ts`), never a query parameter.
  const token = new URL(inviteUrl).pathname.split('/').pop();

  if (token === undefined || token === '') {
    throw new Error(`could not read a token out of the invitation link ${inviteUrl}`);
  }

  const anonymous = await request.newContext({
    baseURL: apiURL(),
    extraHTTPHeaders: { origin: browserOrigin() },
  });

  try {
    const accepted = await anonymous.post('/api/v1/invitations/accept', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { token, password: SEED_PASSWORD, locale: 'en' },
    });

    expect(accepted.ok(), await accepted.text()).toBe(true);

    const { user } = (await accepted.json()) as { user: { id: string } };

    return { userId: user.id, email };
  } finally {
    await anonymous.dispose();
  }
};

test.describe('an owner writes and lifts a personal exception', () => {
  /**
   * **Why `team:read`, not `task:read`.** The story's acceptance table and the component tests both
   * reach for `task:read`, but the task domain is M3+ — nothing under `task:*` answers an HTTP
   * request in this installation today. `GET /teams` is gated by `team:read` and is live now; the
   * key is not dangerous, is not the owner's, and `developer` holds it while nobody outside a role
   * or an exception does — so denying it and then calling the endpoint *as the colleague* is an
   * assertion about the running system, not about a row's label.
   *
   * **Why the colleague is provisioned through the API rather than the seed.** See
   * `provisionDeveloperColleague` above.
   *
   * **Why the browser session and the API session are two separate sign-ins for the owner.**
   * `ownerPage` (from `fixtures/session.fixture.ts`) carries the cookie a real administrator would
   * use to click through the screen; the calls that set up the fixture and read the colleague's own
   * access need a bearer token, which is a different credential for the same person. Reusing one for
   * the other would mean either driving the whole setup through the browser — slow, and it retests
   * the invitation screen this file is not about — or fetching from inside `ownerPage`, which would
   * make the assertions about the colleague's access indistinguishable from a same-origin fetch the
   * shell itself might be making.
   */
  test('denying a role-granted permission takes it away for real, and lifting the exception gives it back', async ({
    ownerPage,
  }) => {
    const owner = await signInApi(SEED_ORGANIZATION_A.owner.email, SEED_PASSWORD);
    const roleId = await developerRoleId(owner);
    const { userId, email } = await provisionDeveloperColleague(owner, roleId);
    const colleague = await signInApi(email, SEED_PASSWORD);

    try {
      // POSITIVE CONTROL, taken before anything is denied: the role really does grant this
      // permission today. Without it, «the colleague loses team:read» would hold trivially for an
      // account that never had it — the same shape of control `tenancy/cross-tenant-api.spec.ts`
      // insists on for its own 404s (`rules/testing.mdc`, «негатив без парного позитива»).
      const before = await colleague.context.get('/api/v1/teams', { headers: colleague.headers });

      expect(before.ok(), await before.text()).toBe(true);

      // 1. The owner opens the directory, finds the new colleague by e-mail, and opens their card.
      await ownerPage.goto('/admin/members');
      await ownerPage.getByRole('searchbox', { name: 'Search' }).fill(email);

      const personLink = ownerPage.getByRole('link', { name: email, exact: true });

      await expect(personLink).toBeVisible();
      await personLink.click();
      await expect(ownerPage).toHaveURL(new RegExp(`/admin/members/${userId}(?:[/?]|$)`));

      // 2. The Rights tab: every permission, and the layer of the model that decided it.
      await ownerPage.getByRole('tab', { name: 'Rights' }).click();
      await expect(ownerPage.getByText('developer', { exact: true })).toBeVisible();

      const row = ownerPage
        .getByRole('row')
        .filter({ has: ownerPage.getByRole('rowheader', { name: 'team:read', exact: true }) });

      await expect(row).toBeVisible();
      await expect(row.getByRole('radio', { name: 'Inherited' })).toBeChecked();
      await expect(row.getByText('Role', { exact: true })).toBeVisible();
      await expect(row.getByText('Inherited from developer', { exact: true })).toBeVisible();

      await audit(ownerPage);

      // 3. The owner sets a personal deny, with a reason and no expiry.
      const control = row.getByRole('radiogroup', { name: 'Personal exception for team:read' });

      await control.getByText('Deny', { exact: true }).click();

      const dialog = ownerPage.getByRole('dialog', { name: 'Take away what the roles grant' });

      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText('This person will not hold team:read even though a role grants it.'),
      ).toBeVisible();

      // The dialog is its own accessibility surface — a focus trap and a form Mantine assembles
      // fresh on every open (`ui/permission-override-dialog.component.tsx`) — worth auditing on its
      // own rather than only as part of the page behind it.
      await audit(ownerPage);

      await dialog
        .getByRole('textbox', { name: 'Reason' })
        .fill('Off the incident-review roster until the audit closes.');
      await dialog.getByRole('checkbox', { name: 'Until somebody removes it' }).check();
      await dialog.getByRole('button', { name: 'Write the exception' }).click();
      await expect(dialog).toBeHidden();

      // 4. The row now says so: a personal deny, with the role it overrides still named — the same
      // sentence that lets «back to inherited» state a consequence instead of implying one.
      await expect(row.getByRole('radio', { name: 'Deny' })).toBeChecked();
      await expect(row.getByText('Personal deny', { exact: true })).toBeVisible();
      await expect(
        row.getByText('Reason: Off the incident-review roster until the audit closes.'),
      ).toBeVisible();
      await expect(row.getByText('Inherited from developer', { exact: true })).toBeVisible();

      // 6. THE REASON THIS SCREEN EXISTS, and the one assertion a component test cannot make: the
      // colleague really did lose the permission, not just the row's label. `expect.poll` rather
      // than one call — nothing in this operation's contract promises the change is synchronous,
      // only that it needs no re-login (the documented case next to it, `assignRole`: «applies on
      // the next request… without a re-login»).
      await expect
        .poll(async () => {
          const response = await colleague.context.get('/api/v1/teams', {
            headers: colleague.headers,
          });

          return response.status();
        })
        .toBe(403);

      // 5. The owner lifts the exception; the row returns to what the role says.
      await control.getByText('Inherited', { exact: true }).click();
      await expect(row.getByRole('radio', { name: 'Inherited' })).toBeChecked();
      await expect(row.getByText('Role', { exact: true })).toBeVisible();

      // And access is really back, not just the label — the pair to step 6's control.
      await expect
        .poll(async () => {
          const response = await colleague.context.get('/api/v1/teams', {
            headers: colleague.headers,
          });

          return response.status();
        })
        .toBe(200);
    } finally {
      await Promise.all([owner.context.dispose(), colleague.context.dispose()]);
    }
  });
});

apiTest.describe('reading a person’s rights is scoped to the reader’s own organization', () => {
  /**
   * `GET /users/{userId}/permissions` is the endpoint STORY-011-11 adds, and CLAUDE.md's invariant
   * #2 is unconditional: a resource of another organization is **404**, never 403 — a 403 would
   * confirm the account exists to somebody who has no business asking. The two seeded owners are
   * enough for this; provisioning a colleague, as the scenario above does, would be setup this
   * assertion does not need.
   *
   * A plain `apiTest`, not `ownerPage`: this is a question about the API, and a browser buys nothing
   * here that a bearer token does not already answer, the same reasoning
   * `tenancy/cross-tenant-api.spec.ts` uses throughout.
   */
  apiTest(
    'an owner of another organization gets 404, not 403; their own owner gets 200',
    async () => {
      const [ownerA, ownerB] = await Promise.all([
        signInApi(SEED_ORGANIZATION_A.owner.email, SEED_PASSWORD),
        signInApi(SEED_ORGANIZATION_B.owner.email, SEED_PASSWORD),
      ]);

      try {
        const foreign = await ownerB.context.get(`/api/v1/users/${ownerA.userId}/permissions`, {
          headers: ownerB.headers,
        });

        expect(foreign.status()).toBe(404);

        // CONTROL: the identical call against one's own organization succeeds — without it, 404 for
        // everybody would pass this too.
        const own = await ownerA.context.get(`/api/v1/users/${ownerA.userId}/permissions`, {
          headers: ownerA.headers,
        });

        expect(own.ok(), await own.text()).toBe(true);
      } finally {
        await Promise.all([ownerA.context.dispose(), ownerB.context.dispose()]);
      }
    },
  );
});
