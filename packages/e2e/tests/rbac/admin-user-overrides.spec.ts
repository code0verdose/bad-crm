import { expect, test as apiTest } from '@playwright/test';

import { test } from '../../fixtures/account.fixture.js';
import { SEED_ORGANIZATION_A, SEED_ORGANIZATION_B } from '../../fixtures/seed-data.js';
import {
  apiSessionFor,
  directoryRow,
  ownerApiSession,
  type ApiSession,
} from '../../fixtures/test-account.js';
import { audit } from '../support/audit.util.js';

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

/**
 * What `GET /teams` answers this person with the access token they are holding right now.
 *
 * Two different facts are read through this one call below, and keeping them apart is the point of
 * splitting it from `reauthenticate`. Writing or removing a personal exception bumps
 * `users.permissions_version` (`write-permission-override.use-case.ts:79`,
 * `remove-permission-override.use-case.ts:58`), an access token carries that number as its `pv`
 * claim, and `AuthenticateSessionQuery` compares the two and refuses a token left behind — with
 * **401**, not 403. So the first answer after either operation is 401, and that 401 *is* the bump:
 * it is what stops a token minted a second ago from spending rights it no longer has. Absorbing it
 * silently would make this file pass with the bump deleted — the case `rules/testing.mdc` names as
 * «побочный эффект без ассерта — это отсутствующий тест», and measured: with
 * `bumpPermissionsVersion` commented out the absorbing version of this helper stayed green.
 */
const teamsStatus = async (session: ApiSession): Promise<number> => {
  const response = await session.context.get('/api/v1/teams', { headers: session.headers });

  return response.status();
};

/**
 * The exchange a browser performs for itself on 401: the refresh cookie for a fresh access token
 * carrying the current `pv`. After it, the status of `teamsStatus` is an answer about the
 * **permission** rather than about the age of the token — which is what «applies on the next
 * request… without a re-login» means, and it is not the same as «without re-authenticating».
 */
const reauthenticate = async (session: ApiSession): Promise<void> => {
  const refreshed = await session.context.post('/api/v1/auth/refresh');

  expect(refreshed.ok(), await refreshed.text()).toBe(true);

  const { accessToken } = (await refreshed.json()) as { accessToken: string };

  session.headers.authorization = `Bearer ${accessToken}`;
};

/**
 * The address of the colleague this file invented, carried out of the scenario so that `afterAll`
 * can hold the fixture to the second half of its promise — see the hook at the end of the describe.
 */
let provisionedEmail: string | undefined;

test.describe('an owner writes and lifts a personal exception', () => {
  /**
   * **Why `team:read`, not `task:read`.** The story's acceptance table and the component tests both
   * reach for `task:read`, but the task domain is M3+ — nothing under `task:*` answers an HTTP
   * request in this installation today. `GET /teams` is gated by `team:read` and is live now; the
   * key is not dangerous, is not the owner's, and `developer` holds it while nobody outside a role
   * or an exception does — so denying it and then calling the endpoint *as the colleague* is an
   * assertion about the running system, not about a row's label.
   *
   * **Why `temporaryColleague` and not the standing `developer` role account.** This scenario
   * writes a personal exception on the person it is given and lifts it again, so running it against
   * the shared account of `fixtures/role-account.ts` would leave every other developer-role scenario
   * depending on whether this one reached its last line. The fixture invents somebody, and takes
   * them back out of the directory afterwards — which the hook at the end of this describe holds it
   * to, because a fixture that provisions and quietly never cleans up passes every test that uses
   * it.
   *
   * **Why the browser session and the API session are two separate sign-ins for the owner.**
   * `ownerPage` (from `fixtures/session.fixture.ts`) carries the cookie a real administrator would
   * use to click through the screen; the calls that set up the fixture and read the colleague's own
   * access need a bearer token, which is a different credential for the same person. Reusing one for
   * the other would mean either driving the whole setup through the browser — slow, and it retests
   * the invitation screen this file is not about — or fetching from inside `ownerPage`, which would
   * make the assertions about the colleague's access indistinguishable from a same-origin fetch the
   * shell itself might be making.
   *
   * **Why it is marked slow.** Measured, not guessed: against the built client this scenario takes
   * about 42 s, and the suite's per-test budget is 30 s — so it could never have passed, on any
   * machine, from the day it was written. Most of that is the two `audit()` calls, and neither is
   * optional: the row and the dialog are separate accessibility surfaces, and the dialog is a focus
   * trap Mantine assembles fresh on every open. Splitting the scenario would cost more than it
   * saves, because the assertion *is* the round trip — «takes it away» and «gives it back» stop
   * meaning anything once they are two tests that can pass independently. So the budget is tripled
   * for this one test rather than raised for the suite, which would hide the next slow screen.
   */
  test('denying a role-granted permission takes it away for real, and lifting the exception gives it back', async ({
    ownerPage,
    temporaryColleague,
  }) => {
    test.slow();

    const owner = await apiSessionFor(SEED_ORGANIZATION_A.owner.email);
    const { userId, email } = temporaryColleague;
    const colleague = await apiSessionFor(email);

    provisionedEmail = email;

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
      // colleague really did lose the permission, not just the row's label. Two answers, because
      // two mechanisms carry it and either one alone can be broken while the other still looks
      // right (see `teamsStatus`).
      //
      // 6a. The token they were already holding stops being believed. `expect.poll` rather than one
      // call — nothing in this operation's contract promises the change is synchronous, only that it
      // needs no re-login (the documented case next to it, `assignRole`: «applies on the next
      // request… without a re-login»).
      await expect.poll(async () => teamsStatus(colleague)).toBe(401);

      // 6b. And with a token minted after the write — the one a browser fetches for itself, without
      // anybody signing in again — the permission itself is gone.
      await reauthenticate(colleague);
      expect(await teamsStatus(colleague)).toBe(403);

      // 5. The owner lifts the exception; the row returns to what the role says.
      await control.getByText('Inherited', { exact: true }).click();
      await expect(row.getByRole('radio', { name: 'Inherited' })).toBeChecked();
      await expect(row.getByText('Role', { exact: true })).toBeVisible();

      // And access is really back, not just the label — the pair to step 6's control, read the same
      // way: lifting an exception bumps the version too, so the token minted at 6b is refused first
      // and the one after it succeeds.
      await expect.poll(async () => teamsStatus(colleague)).toBe(401);
      await reauthenticate(colleague);
      expect(await teamsStatus(colleague)).toBe(200);
    } finally {
      await Promise.all([owner.context.dispose(), colleague.context.dispose()]);
    }
  });

  /**
   * The other half of `temporaryColleague`, and the half that is easy to leave unwritten: the
   * account is gone once the scenario is over. Playwright tears test-scoped fixtures down before
   * `afterAll`, so this hook runs after the offboarding the fixture performs.
   *
   * «Gone» is what it can mean in a product that deliberately deletes nobody: out of the directory's
   * working set — `GET /employees` defaults to `status=ACTIVE&status=INVITED` — with every session
   * revoked in the same transaction (`fixtures/test-account.ts`).
   */
  test.afterAll(async () => {
    expect(
      provisionedEmail,
      'the scenario above did not run, so there is nothing to prove was cleaned up',
    ).toBeDefined();

    const owner = await ownerApiSession(SEED_ORGANIZATION_A);

    try {
      const working = await directoryRow(owner, provisionedEmail ?? '', {
        statuses: ['ACTIVE', 'INVITED'],
      });

      expect(working, 'the temporary colleague is still in the directory').toBeUndefined();

      // CONTROL: the row did not vanish because the lookup is broken — the same query, widened by
      // one status, still finds the account. Without it the assertion above would pass just as well
      // for a fixture that provisioned nobody at all.
      const suspended = await directoryRow(owner, provisionedEmail ?? '', {
        statuses: ['SUSPENDED'],
      });

      expect(suspended?.status).toBe('SUSPENDED');
    } finally {
      await owner.context.dispose();
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
        apiSessionFor(SEED_ORGANIZATION_A.owner.email),
        apiSessionFor(SEED_ORGANIZATION_B.owner.email),
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
