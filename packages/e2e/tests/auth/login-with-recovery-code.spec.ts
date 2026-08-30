import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { SEED_ORGANIZATION_A, SEED_PASSWORD } from '../../fixtures/seed-data.js';
import { currentTotpCode } from '../../fixtures/totp.util.js';
import { audit } from '../support/audit.util.js';

/**
 * STORY-013-03 acceptance 7 — the way in for the person whose authenticator is gone.
 *
 * `login-with-2fa.spec.ts` stops one step short of this: it asserts that «Use a recovery code
 * instead» is *offered* on the second step, and nothing beyond the offer. Everything behind the
 * button — the screen the toggle draws, a code being spent, the same code refused afterwards — was
 * covered only by `packages/server/test/unit/application/consume-recovery-code.use-case.test.ts`
 * and by the Postgres race in
 * `packages/server/test/integration/db/mfa-recovery-code-race.test.ts`. Neither can answer whether
 * a person holding a printed sheet can actually get in, which is the entire point of the feature:
 * a recovery code exists precisely for the moment when nothing else works.
 *
 * **Why the round trip rather than one successful sign-in.** «Код гасится атомарно» is the promise,
 * and a build that accepted recovery codes and never consumed them would pass every assertion up to
 * step 3 — while quietly turning ten one-time codes into ten permanent passwords that survive a
 * stolen sheet forever. So the code is spent, and then presented again, and step 4's refusal is the
 * assertion this file exists for.
 *
 * **Why the second code at the end.** Refusing the spent code would also be satisfied by a build
 * where the recovery path stopped working altogether after the first sign-in — the same shape of
 * false pass `tenancy/cross-tenant-api.spec.ts` guards with its own CONTROL. A different, unused
 * code presented on that same screen separates «this code is spent» from «this screen is broken».
 * It is offered without re-entering the password on purpose: that also shows the intermediate token
 * survives a refusal, which acceptance 5 promises for anything short of five failures.
 *
 * **Why three verify attempts and not four.** `mfa_recovery_consume_attempt` allows five per
 * fifteen minutes on the pair of IP address and account
 * (`packages/server/src/infrastructure/rate-limit/rate-limit-policy.constant.ts`, keyed in
 * `consume-recovery-code.use-case.ts` — the budget is spent before the code is compared, so a
 * successful attempt costs a point too). The scenario spends three: the code, the same code again,
 * and the second code. A fourth — a bogus code, to watch the refusal render — was written and then
 * removed: step 4 already renders that refusal with a code whose rejection *means* something, and a
 * fourth would sit one attempt short of the limit, where the next thing to fail is the limiter
 * rather than the feature.
 *
 * **Why a freshly provisioned colleague.** `totpEnabledAt` is a permanent column write, and every
 * other spec signing in as `SEED_ORGANIZATION_A`'s owner expects a password to be enough — the
 * reasoning `login-with-2fa.spec.ts` sets out at length for the same construction.
 *
 * **Why every assertion is the sentence rather than the key.** The client suite runs i18next in
 * `cimode`, where a component that forgot `t()` renders identically to one that remembers. Every
 * string below is copied from `packages/client/src/shared/i18n/locales/en/auth.json` and
 * `.../errors.json` as they read on 2026-08-30.
 */

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
  const email = `recovery-login-${randomUUID()}@org-a.local`;

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
 * Turns the second factor on and answers with the sheet of recovery codes it issued.
 *
 * The codes come from the server's own answer, which is the only place they ever exist in the
 * clear — `GET /auth/2fa/recovery-codes` answers `{ total, remaining }` afterwards and the rows are
 * stored as Argon2id digests. A test that wanted them from anywhere else could not have them.
 */
const enrolSecondFactor = async (session: ApiSession): Promise<readonly string[]> => {
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

  return codes;
};

const codeField = (page: Page) => page.getByRole('textbox', { name: 'Code' });

/**
 * Walks from the sign-in form to the recovery-code field.
 *
 * Twice in one scenario, and the second time is not a repetition: it is what a person does after
 * signing out, and the assertions differ on the far side of it.
 */
const reachRecoveryStep = async (page: Page, email: string): Promise<void> => {
  await page.getByRole('textbox', { name: 'Email address' }).fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Two-step sign-in' })).toBeVisible();

  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();

  await expect(
    page.getByText(
      'Enter one of the recovery codes you saved when you turned two-factor authentication on. Each code works once.',
    ),
  ).toBeVisible();
};

test.describe('signing in with a recovery code', () => {
  // Enrolling over the API, then two full passes through the sign-in — password, step, code — does
  // not fit the suite's default thirty seconds, and a timeout there would read as a hung
  // application rather than as a test that budgeted badly. The same allowance
  // `login-with-2fa.spec.ts` makes, for the same shape of scenario.
  test.setTimeout(120_000);

  // Anonymous, deliberately: `storageState` here would test the fixture rather than the screen.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('spends a recovery code to get in, and refuses that same code afterwards', async ({
    page,
  }) => {
    const owner = await signInApi(SEED_ORGANIZATION_A.owner.email, SEED_PASSWORD);

    try {
      const email = await provisionColleague(owner, await developerRoleId(owner));
      const colleague = await signInApi(email, SEED_PASSWORD);

      let codes: readonly string[];

      try {
        codes = await enrolSecondFactor(colleague);
      } finally {
        await colleague.context.dispose();
      }

      const [firstCode, secondCode] = codes;

      if (firstCode === undefined || secondCode === undefined) {
        throw new Error('the enrolment issued fewer than two recovery codes');
      }

      // 1. Password, second step, and the way out of it for somebody with no authenticator.
      await page.goto('/login');
      await reachRecoveryStep(page, email);

      // The field keeps the attribute that lets a phone offer the code, in this mode too — the
      // screen swaps the sentence and the bound, not the affordance
      // (`two-factor-form.component.tsx`, «`autoComplete="one-time-code"` in both modes»).
      await expect(codeField(page)).toHaveAttribute('autocomplete', 'one-time-code');
      await expect(
        page.getByRole('button', { name: 'Use a code from the app instead' }),
      ).toBeVisible();

      // The recovery step is its own accessibility surface: a different description, a different
      // field bound and a toggle that now says the opposite thing.
      await audit(page);

      // CONTROL: the password bought nothing. Without it every assertion below would also pass on a
      // build that signed the person in and drew a second step over the top of a live session.
      expect((await page.context().cookies()).map((cookie) => cookie.name)).not.toContain(
        'bad_crm_refresh',
      );

      // 2. A real code from the sheet, and the door opens.
      await codeField(page).fill(firstCode);
      await page.getByRole('button', { name: 'Continue' }).click();

      await expect(page).toHaveURL(/\/dashboard/);
      await expect(page.getByRole('main')).toBeVisible();

      // 3. Out again, the way the shell offers.
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page).toHaveURL(/\/login/);

      // 4. THE ASSERTION THIS FILE EXISTS FOR: the code was spent, not merely accepted. A sheet
      // recovered from a bin must not be a sheet of ten passwords.
      await reachRecoveryStep(page, email);
      await codeField(page).fill(firstCode);
      await page.getByRole('button', { name: 'Continue' }).click();

      const refusal = page.getByRole('alert');

      await expect(refusal).toContainText('That did not sign you in');
      await expect(refusal).toContainText('That recovery code is not usable.');
      await expect(page).toHaveURL(/\/login/);

      await audit(page);

      // 5. POSITIVE CONTROL, on the very same step and without entering the password again: a
      // different unused code still works. This is what makes step 4 a statement about the code
      // rather than about the screen — and it shows the intermediate token outliving one refusal.
      await codeField(page).fill(secondCode);
      await page.getByRole('button', { name: 'Continue' }).click();

      await expect(page).toHaveURL(/\/dashboard/);
      await expect(page.getByRole('main')).toBeVisible();

      await audit(page);
    } finally {
      await owner.context.dispose();
    }
  });
});
