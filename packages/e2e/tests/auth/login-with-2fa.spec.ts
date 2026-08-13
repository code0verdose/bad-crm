import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { SEED_ORGANIZATION_A, SEED_PASSWORD } from '../../fixtures/seed-data.js';
import { currentTotpCode } from '../../fixtures/totp.util.js';
import { audit } from '../support/audit.util.js';

/**
 * STORY-013-03, the happy path `rules/testing.mdc` §6 requires of the second factor: a password is
 * no longer a sign-in.
 *
 * The scenario is the whole loop — enrol, sign out of everything, sign in with the password, meet
 * the step, spend a live code, land in the shell — because every shorter version proves something
 * weaker. Checking only that the step appears would pass on a build that never accepts a code;
 * checking only `POST /auth/2fa/verify` would pass on a screen that never shows the field.
 *
 * **Why a freshly provisioned colleague, not `SEED_ORGANIZATION_A`'s owner.** `totpEnabledAt` is a
 * permanent column write, and every other spec in this suite signs in as that owner
 * (`smoke/sign-in.spec.ts`, `smoke/accessibility.spec.ts`, `tenancy/cross-tenant-api.spec.ts`, …)
 * expecting a password to be enough. Enrolling the shared account would hand all of them a second
 * factor they were never written to expect. A colleague invited and accepted through the real API
 * — the construction `enable-2fa.spec.ts` and `rbac/admin-user-overrides.spec.ts` both use — is
 * disposable: this test is the only thing that ever touches it.
 *
 * **Why the enrolment happens over the API and the sign-in in the browser.** Turning 2FA on is
 * already covered end-to-end through the UI by `enable-2fa.spec.ts`; repeating it here would double
 * the runtime of the slowest spec in the suite to re-assert somebody else's scenario. What this
 * file is about starts at `/login`.
 *
 * **Why the run waits for the next 30-second step.** The code that confirmed the enrolment is
 * recorded as `totp_last_counter`, and the same counter presented again is refused as
 * `mfa_code_replayed` (acceptance 6) — correctly, and it would look exactly like a broken sign-in.
 * The wait is bounded by one TOTP period.
 *
 * **Why every assertion is the sentence rather than the key.** `rules/testing.mdc`, «Тест, который
 * не видели красным» §4: the client suite runs i18next in `cimode`, where a component that forgot
 * `t()` renders identically to one that remembers — so a key would be satisfied by a namespace that
 * failed to load. Every string below is copied from
 * `packages/client/src/shared/i18n/locales/en/auth.json` and `.../errors.json` as they read on
 * 2026-08-13.
 */

/** One TOTP period, the value this installation issues in its `otpauth://` URI. */
const TOTP_PERIOD_SECONDS = 30;

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

interface ApiSession {
  readonly context: APIRequestContext;
  readonly headers: { readonly authorization: string; readonly origin: string };
}

/** Signs in over the API — a bearer token, not a browser. Only used before 2FA is switched on. */
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

/** The organization's `developer` system role, by id — 2FA is self-service, so any role will do. */
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
const provisionColleague = async (owner: ApiSession, roleId: string): Promise<string> => {
  const email = `login-2fa-${randomUUID()}@org-a.local`;

  const invited = await owner.context.post('/api/v1/invitations', {
    headers: { ...owner.headers, 'Idempotency-Key': randomUUID() },
    data: { email, roleId, locale: 'en' },
  });

  expect(invited.ok(), await invited.text()).toBe(true);

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

    expect(accepted.ok(), await accepted.text()).toBe(true);

    return email;
  } finally {
    await anonymous.dispose();
  }
};

/**
 * Turns the second factor on for an account, and answers with the secret its codes come from.
 *
 * The secret is taken from the server's own answer rather than from anything on a screen, so a code
 * computed from it is a code the server would compute too — the two halves of the assertion stay
 * independent (`enable-2fa.spec.ts` makes the same choice for the same reason).
 */
const enrolSecondFactor = async (session: ApiSession): Promise<string> => {
  const drafted = await session.context.post('/api/v1/auth/2fa/setup', {
    headers: session.headers,
  });

  expect(drafted.ok(), await drafted.text()).toBe(true);

  const { secret } = (await drafted.json()) as { secret: string };

  const confirmed = await session.context.post('/api/v1/auth/2fa/confirm', {
    headers: { ...session.headers, 'Idempotency-Key': randomUUID() },
    data: { code: currentTotpCode(secret), currentPassword: SEED_PASSWORD },
  });

  expect(confirmed.ok(), await confirmed.text()).toBe(true);

  const { codes } = (await confirmed.json()) as { codes: readonly string[] };

  expect(codes).toHaveLength(10);

  return secret;
};

const totpStepIndex = (): number => Math.floor(Date.now() / 1_000 / TOTP_PERIOD_SECONDS);

/**
 * Waits until the authenticator would show a different six digits.
 *
 * The enrolment spent a code, and `totp_last_counter` refuses that counter for good. Signing in
 * inside the same window would therefore be answered `401 mfa_code_replayed` — the product working
 * exactly as acceptance 6 says it should, reported as a failed sign-in.
 */
const waitForNextTotpStep = async (): Promise<void> => {
  const current = totpStepIndex();

  while (totpStepIndex() === current) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const codeField = (page: Page) => page.getByRole('textbox', { name: 'Code' });

test.describe('signing in with a second factor', () => {
  // Enrolling over the API, waiting out a TOTP period and driving two screens does not fit the
  // suite's default thirty seconds — and a timeout there reads as a hung application rather than as
  // a test that budgeted badly.
  test.setTimeout(120_000);

  // Anonymous, deliberately: `storageState` here would test the fixture rather than the screen.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('asks for a code after the password, refuses a wrong one, and takes a live one into the shell', async ({
    page,
  }) => {
    const owner = await signInApi(SEED_ORGANIZATION_A.owner.email, SEED_PASSWORD);

    try {
      const email = await provisionColleague(owner, await developerRoleId(owner));
      const colleague = await signInApi(email, SEED_PASSWORD);

      try {
        const secret = await enrolSecondFactor(colleague);

        // 1. The password alone. The account now has a second factor, so this must not be a session.
        await page.goto('/login');
        await page.getByRole('textbox', { name: 'Email address' }).fill(email);
        await page.getByRole('textbox', { name: 'Password' }).fill(SEED_PASSWORD);
        await page.getByRole('button', { name: 'Sign in' }).click();

        // 2. The step, in place of the form and under its own heading.
        await expect(
          page.getByRole('heading', { level: 1, name: 'Two-step sign-in' }),
        ).toBeVisible();
        await expect(
          page.getByText(
            'Open your authenticator app and enter the six-digit code it shows for this account.',
          ),
        ).toBeVisible();
        await expect(page).toHaveURL(/\/login/);

        // Acceptance 11, named attribute by named attribute: the field a phone can fill from its
        // notification, the way out for whoever has no phone, and the life of the intermediate
        // token.
        await expect(codeField(page)).toHaveAttribute('autocomplete', 'one-time-code');
        await expect(
          page.getByRole('button', { name: 'Use a recovery code instead' }),
        ).toBeVisible();
        await expect(page.getByText(/This step is valid for another \d:\d\d\./)).toBeVisible();

        await audit(page);

        // CONTROL: the password bought nothing (acceptance 1). Without it, everything above would
        // also pass on a build that signed the person in and drew a second step over the top of a
        // live session — the screen would look identical and the account would already be open.
        //
        // Asserted on the cookie jar rather than by navigating to `/dashboard`: the guard is
        // somebody else's scenario (`smoke/sign-in.spec.ts`), and a navigation would end this one —
        // the step is held together by an intermediate token that lives in memory, which is the
        // property this file exists to protect.
        expect((await page.context().cookies()).map((cookie) => cookie.name)).not.toContain(
          'bad_crm_refresh',
        );

        // 3. A wrong code is refused, said in words, and leaves the step standing.
        await codeField(page).fill('000000');
        await page.getByRole('button', { name: 'Continue' }).click();

        const refusal = page.getByRole('alert');

        await expect(refusal).toContainText('That did not sign you in');
        await expect(refusal).toContainText(
          'That code did not work. Check your authenticator app and try again.',
        );
        await expect(page).toHaveURL(/\/login/);

        await audit(page);

        // 4. A live code, computed from the secret the server issued, in a window the enrolment has
        // not already spent.
        await waitForNextTotpStep();

        await codeField(page).fill(currentTotpCode(secret));
        await page.getByRole('button', { name: 'Continue' }).click();

        // 5. Inside — and by the same door every other sign-in uses: the guard on `/login` carries
        // the session to `/dashboard`, the screen never navigates by itself.
        await expect(page).toHaveURL(/\/dashboard/);
        await expect(page.getByRole('main')).toBeVisible();

        await audit(page);
      } finally {
        await colleague.context.dispose();
      }
    } finally {
      await owner.context.dispose();
    }
  });
});
