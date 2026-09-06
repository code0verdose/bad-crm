import { expect, request, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { SEED_ORGANIZATION_A, SEED_PASSWORD } from '../../fixtures/seed-data.js';
import { explainProvisioningRefusal, testAccountEmail } from '../../fixtures/test-account.js';
import { currentTotpCode } from '../../fixtures/totp.util.js';
import { audit } from '../support/audit.util.js';

/**
 * STORY-013-01, the one happy path `rules/testing.mdc` §6 requires of EPIC-013 and the one the
 * story's own checklist lists as missing: turning TOTP on from `/settings/security`, all the way
 * through to the ten recovery codes and the screen refusing to show them a second time.
 *
 * **Why a freshly provisioned colleague, not `SEED_ORGANIZATION_A`'s owner.** Every other spec in
 * this suite treats the seed owner as read-only and mints a fresh session per test
 * (`fixtures/session.fixture.ts`) precisely because the account itself never changes. Enrolling 2FA
 * is different in kind: `totpEnabledAt` is a permanent column write, and this build has no way to
 * clear it again — STORY-013-04 (disable, admin reset) has not shipped, so once this scenario ran
 * against the shared seed owner, every later run would meet an already-enrolled account instead of
 * the blank one this test needs, and every *other* spec that signs in as that owner
 * (`smoke/sign-in.spec.ts`, `smoke/accessibility.spec.ts`, `tenancy/cross-tenant-api.spec.ts`, …)
 * would inherit a 2FA-on account whose consequences those files were never written to expect. A
 * colleague invited and accepted through the real API — the same construction
 * `rbac/admin-user-overrides.spec.ts` uses and for the same reason — is disposable: this test is the
 * only thing that ever touches it, so it can enroll 2FA and stay enrolled without leaving a mark
 * anywhere else.
 *
 * **Why the code is computed from the server's own answer, not read back off the screen.**
 * `fixtures/totp.util.ts` derives the six digits from the `secret` field of the `POST
 * /auth/2fa/setup` response, the same value the screen is asked to display next to its QR. Computing
 * the code from *that* — rather than, say, scraping whatever string the page happens to render where
 * the secret is expected — means a bug that displayed the wrong text in the right place could not
 * also make the confirmation "work" by coincidence; the two checks (the secret is shown correctly,
 * and the code derived from the real secret is accepted) stay independent of each other.
 *
 * **Why every assertion is the real sentence, not the i18n key.** `rules/testing.mdc`, "Тест,
 * который не видели красным" §4: an unanchored assertion against a key is satisfied by a namespace
 * that failed to load and rendered the key itself. Every string below is copied from
 * `packages/client/src/shared/i18n/locales/en/security.json` as it read on 2026-08-12; a client
 * change that only edits `ru/security.json`, or that renames a key without updating this file, is
 * exactly the drift this spec exists to catch and would be missed by matching on the key.
 */

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

interface ApiSession {
  readonly context: APIRequestContext;
  readonly headers: { readonly authorization: string; readonly origin: string };
}

/** Signs in over the API, the way `rbac/admin-user-overrides.spec.ts` does — a bearer token, not a browser. */
const signInApi = async (email: string, password: string): Promise<ApiSession> => {
  const context = await request.newContext({
    baseURL: apiURL(),
    extraHTTPHeaders: { origin: browserOrigin() },
  });

  const response = await context.post('/api/v1/auth/login', { data: { email, password } });

  expect(response.ok(), await response.text()).toBe(true);

  const body = (await response.json()) as { accessToken: string };

  return {
    context,
    headers: { authorization: `Bearer ${body.accessToken}`, origin: browserOrigin() },
  };
};

interface RoleEntry {
  readonly id: string;
  readonly key: string;
}

/**
 * The organization's `developer` system role, by id — provisioned for every organization on
 * bootstrap. 2FA enrolment is self-service and checks no permission (`totp-setup.widget.tsx`'s route
 * carries no `permission`), so which role the colleague holds does not matter to this scenario; a
 * role is needed only because `POST /invitations` requires one.
 */
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

/** Invites somebody and accepts on their behalf — through the same two endpoints onboarding uses. */
const provisionColleague = async (
  owner: ApiSession,
  roleId: string,
): Promise<{ email: string }> => {
  const email = testAccountEmail('enable-2fa');

  const invited = await owner.context.post('/api/v1/invitations', {
    headers: { ...owner.headers, 'Idempotency-Key': randomUUID() },
    data: { email, roleId, locale: 'en' },
  });

  expect(invited.ok(), await explainProvisioningRefusal(invited, 'create')).toBe(true);

  const { inviteUrl } = (await invited.json()) as { inviteUrl: string };
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

    expect(accepted.ok(), await explainProvisioningRefusal(accepted, 'accept')).toBe(true);

    return { email };
  } finally {
    await anonymous.dispose();
  }
};

/**
 * Signs in over the API and hands back a cookie jar a browser context can start from — the same
 * exchange `fixtures/session.fixture.ts` performs for the seeded owners, repeated here because that
 * fixture is parameterised over `SeedOrganization` and this colleague is neither seeded nor an
 * owner.
 */
const mintBrowserStorageState = async (
  email: string,
  password: string,
): ReturnType<APIRequestContext['storageState']> => {
  const context = await request.newContext({
    baseURL: apiURL(),
    extraHTTPHeaders: { origin: browserOrigin() },
  });

  try {
    const response = await context.post('/api/v1/auth/login', { data: { email, password } });

    expect(response.ok(), await response.text()).toBe(true);

    // From the browser's own origin, and fresh afterwards — `session.fixture.ts` explains why in
    // full: the refresh endpoint is guarded by a same-origin check, and this call also rotates the
    // token so the cookie captured below is not a spent one.
    const resumed = await context.post('/api/v1/auth/refresh');

    expect(resumed.ok(), await resumed.text()).toBe(true);

    return await context.storageState();
  } finally {
    await context.dispose();
  }
};

test.describe('enabling two-factor authentication with a TOTP app', () => {
  test('warns first, then confirms with a real code and the password, and shows ten recovery codes exactly once', async ({
    browser,
  }) => {
    const owner = await signInApi(SEED_ORGANIZATION_A.owner.email, SEED_PASSWORD);
    const roleId = await developerRoleId(owner);
    const { email } = await provisionColleague(owner, roleId);

    const context = await browser.newContext({
      storageState: await mintBrowserStorageState(email, SEED_PASSWORD),
    });
    const page = await context.newPage();

    try {
      // 1. The employee opens the screen.
      await page.goto('/settings/security');
      await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();

      const enableButton = page.getByRole('button', { name: 'Turn on two-factor authentication' });

      await expect(enableButton).toBeVisible();

      // 5. Both warnings the story asks for, read before the button that makes them true — plus the
      // third this build carries alongside them. All three, or the case that would slip through
      // asserting only two: the widget renders them from one shared list
      // (`totp-lockout-warnings.component.tsx`), and a regression there is as likely to drop the
      // third as either of the two named in the acceptance criteria.
      //
      // The first sentence is the one STORY-013-04 rewrote: while the way out did not exist this
      // read «there is no way to turn it off yet», and the day disabling shipped the widget's own
      // docstring recorded that the old wording «stopped being true». It is still a warning — the
      // cost of the feature is that leaving needs both proofs — so it stays asserted here, in the
      // words the build actually ships.
      await expect(
        page.getByText(
          'Turning it off later needs the same two things signing in will: your current password and a code — from the app, or an unused recovery code. A stolen browser session cannot do it; neither can you, without one of the two.',
        ),
      ).toBeVisible();
      await expect(
        page.getByText(
          'The recovery codes you get next are the only way back in if the phone is lost. They are stored as hashes, so nobody can look them up for you — not support, not whoever runs this server.',
        ),
      ).toBeVisible();
      await expect(
        page.getByText(
          'The codes are shown once, in the answer to the confirmation. If that answer never arrives — the connection drops, the tab closes — two-factor authentication is on and the codes are gone. A new set can still be issued from this page with your password and a code from the app.',
        ),
      ).toBeVisible();

      await audit(page);

      // 2. Starting enrolment. The secret comes from the network response, not from the DOM: the
      // code confirmed below is derived from what the server actually issued, so a bug that rendered
      // the wrong text in the right place could not also make confirmation succeed by coincidence.
      const [setupResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes('/2fa/setup') && response.request().method() === 'POST',
        ),
        enableButton.click(),
      ]);

      expect(setupResponse.ok(), await setupResponse.text()).toBe(true);
      const { secret } = (await setupResponse.json()) as { secret: string };

      await expect(
        page.getByRole('img', {
          name: 'QR code for pairing an authenticator app. The same secret is written out below as text.',
        }),
      ).toBeVisible();
      // Acceptance 10: the secret is available as text for manual entry, not only as the QR — for
      // the desktop browser with no camera to scan its own screen, among others named in the widget.
      await expect(page.getByText(secret, { exact: true })).toBeVisible();

      // 3. Confirm: a code computed from the secret just shown, plus the account's current password
      // — the operation requires both (acceptance 2).
      const code = currentTotpCode(secret);

      // Scoped to the region rather than the page. Four fields on this screen are labelled «Your
      // current password» — enrolment, disabling, regenerating codes and the change-password form —
      // and that is correct: each sits in a `section` with its own `aria-labelledby` heading, so a
      // reader navigating by region is never in doubt about which password is being asked for. The
      // page-wide locator was unambiguous only for as long as the change-password form did not
      // exist; it landed 2026-09-05 and this step began failing on strict mode, which is Playwright
      // reporting the same fact from the other side.
      const enrolment = page.getByRole('region', { name: 'Two-factor authentication' });

      await enrolment.getByRole('textbox', { name: 'Code from the app' }).fill(code);
      await enrolment.getByRole('textbox', { name: 'Your current password' }).fill(SEED_PASSWORD);

      const [confirmResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes('/2fa/confirm') && response.request().method() === 'POST',
        ),
        page.getByRole('button', { name: 'Confirm and turn on' }).click(),
      ]);

      expect(confirmResponse.ok(), await confirmResponse.text()).toBe(true);
      const { codes: issuedCodes } = (await confirmResponse.json()) as { codes: readonly string[] };

      expect(issuedCodes).toHaveLength(10);

      // 4. Ten codes, shown exactly once — and what is on screen is exactly what the server issued,
      // not merely ten strings of the right shape.
      const dialog = page.getByRole('dialog', { name: 'Your recovery codes' });

      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Shown once')).toBeVisible();
      await expect(
        dialog.getByText(
          'This is the only time these codes can be read. After this window closes they cannot be shown again — only hashes of them are kept. Download or print them now.',
        ),
      ).toBeVisible();

      const listedCodes = await dialog
        .getByRole('list', { name: 'Recovery codes' })
        .locator('li')
        .allTextContents();

      expect(listedCodes).toEqual([...issuedCodes]);

      // The dialog is its own accessibility surface — a focus trap over content assembled fresh on
      // every enrolment — worth auditing on its own rather than only as part of the page behind it.
      await audit(page);

      const doneButton = dialog.getByRole('button', { name: 'Done' });

      // CONTROL: the one screen in the product where closing the window destroys something
      // irreplaceable does not close until the person says they have the codes.
      await expect(doneButton).toBeDisabled();
      await dialog.getByRole('checkbox', { name: 'I have saved these codes' }).check();
      await expect(doneButton).toBeEnabled();
      await doneButton.click();
      await expect(dialog).toBeHidden();

      await expect(
        page.getByText('On. Signing in asks for a code from your authenticator app.'),
      ).toBeVisible();
      await expect(page.getByText('Unused: 10 of 10.')).toBeVisible();
      await expect(enableButton).toBeHidden();

      // None of the ten plaintext codes survive on screen once the dialog that showed them is gone.
      for (const issuedCode of issuedCodes) {
        await expect(page.getByText(issuedCode, { exact: true })).toHaveCount(0);
      }

      // 4, the case the story names explicitly: reopening the screen offers only the counter, never
      // the plaintext again. `GET /auth/2fa/recovery-codes` is the only read this build has, and
      // STORY-013-02 acceptance 2 says it answers `{ total, remaining }` and nothing else — this is
      // that contract, read back from a real reload rather than assumed from it.
      await page.reload();

      await expect(
        page.getByText('On. Signing in asks for a code from your authenticator app.'),
      ).toBeVisible();
      await expect(page.getByText('Unused: 10 of 10.')).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      for (const issuedCode of issuedCodes) {
        await expect(page.getByText(issuedCode, { exact: true })).toHaveCount(0);
      }

      await audit(page);
    } finally {
      await context.close();
      await owner.context.dispose();
    }
  });
});
