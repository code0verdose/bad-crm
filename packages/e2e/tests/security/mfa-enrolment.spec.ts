import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';

import { SEED_ORGANIZATION_A, SEED_PASSWORD } from '../../fixtures/seed-data.js';
import {
  ownerApiSession,
  provisionColleague,
  systemRoleId,
  testAccountEmail,
  type ApiSession,
} from '../../fixtures/test-account.js';
import { audit } from '../support/audit.util.js';

/**
 * The forced enrolment against a running stack — the client half of STORY-013-05 acceptance 3 and
 * of STORY-013-04 acceptance 8.
 *
 * **What only a running stack can answer.** `packages/client/test/routes/mfa-enrolment-flow.test.tsx`
 * already drives the whole client through this — guard, wizard, rotation, landing — but every
 * `mfaEnrollment` in it is a field a fixture wrote onto a response. Here the scope is minted where
 * it really is: `evaluateMfaRequirement` over a real policy row, a real role grant and a real
 * `totpEnabledAt`, carried in a real `scope` claim. If the client and the server ever disagreed
 * about what «scoped» looks like on the wire, this is the only file in the repository that would
 * notice.
 *
 * **Grace zero, not «expired».** The gate fires when the grace period is over, and the shortest
 * honest way to be over is to have had none: a policy applied with `mfaGracePeriodDays: 0` scopes
 * every covered account without a second factor on its very next session. Nothing here waits for a
 * clock.
 *
 * **Why a freshly provisioned colleague on `manager`, and not the standing `admin` account.** This
 * file's whole point is a policy that *scopes somebody*, and a scoped account cannot use the
 * application at all. `playwright.config.ts` sets `fullyParallel: true`, so
 * `test.describe.configure({ mode: 'serial' })` orders the cases **inside this file** and nothing
 * else: run beside `tests/rbac/role-fixtures.spec.ts` or `tests/rbac/admin-user-overrides.spec.ts`,
 * a policy naming `admin` would scope the account those files sign in as and fail them with a
 * redirect their authors never wrote. `manager` is held by no standing account — `role-account.ts`
 * provisions `admin` and `developer` and explains why the list stops there — so the policy this file
 * switches on can cover exactly one account: the disposable one below. The seeded owner is not a
 * candidate either, and for a reason worth knowing: ownership lives in `organizations.owner_id`
 * rather than in a `UserRole` row, so a policy naming `owner` covers nobody at all.
 *
 * The colleague costs one `invitation_create` and one `invitation_accept` per run, the second
 * bounded at ten per fifteen minutes for this machine's address — the arithmetic in
 * `test-account.ts` → `explainProvisioningRefusal`. `tests/auth/enable-2fa.spec.ts` spends the same
 * budget for the same reason: an account this file is allowed to leave in any state.
 *
 * **Nothing here enrols anything, all the same.** The scenario stops at the wizard and at the door
 * out of it. Enrolling would need the confirmation, and `tests/auth/enable-2fa.spec.ts` already owns
 * that path end to end; what is unique here is the gate around it.
 *
 * **The policy row is still shared**, so this file reads what it found and writes it back — and
 * writes back **nothing** if the read failed, because restoring a default over an installation whose
 * policy could not be read would silently switch somebody's mandatory 2FA off.
 */

test.describe.configure({ mode: 'serial' });

interface StoredPolicy {
  readonly mfaRequiredForRoles: readonly string[];
  readonly mfaGracePeriodDays: number;
}

/** The disabled policy, exactly as a fresh installation has it. */
const DISABLED: StoredPolicy = { mfaRequiredForRoles: [], mfaGracePeriodDays: 0 };

/**
 * What the installation had before this file touched it.
 *
 * `undefined` until the read succeeds, and that is the whole point of the type: initialised to
 * `DISABLED`, a failed read would make `afterAll` write «off» over a policy nobody here ever saw.
 */
let found: StoredPolicy | undefined;

/** The one account this file's policy can possibly cover. */
let colleague = '';

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

const asOwner = async (body: (session: ApiSession) => Promise<void>): Promise<void> => {
  const session = await ownerApiSession(SEED_ORGANIZATION_A);

  try {
    await body(session);
  } finally {
    await session.context.dispose();
  }
};

const writePolicy = async (policy: StoredPolicy): Promise<void> => {
  await asOwner(async (session) => {
    const response = await session.context.patch('/api/v1/organization/security-policy', {
      headers: { ...session.headers, 'Idempotency-Key': crypto.randomUUID() },
      data: policy,
    });

    expect(response.ok(), await response.text()).toBe(true);
  });
};

/**
 * Signs in over the API and hands back a cookie jar a browser context can start from.
 *
 * The same exchange `fixtures/session.fixture.ts` performs for the seeded owners, repeated here for
 * the same reason `tests/auth/enable-2fa.spec.ts` repeats it: that fixture is parameterised over the
 * seeded organizations and their roles, and this colleague is neither seeded nor one of them.
 */
const mintBrowserStorageState = async (
  email: string,
): ReturnType<APIRequestContext['storageState']> => {
  const context = await request.newContext({
    baseURL: apiURL(),
    extraHTTPHeaders: { origin: browserOrigin() },
  });

  try {
    const response = await context.post('/api/v1/auth/login', {
      data: { email, password: SEED_PASSWORD },
    });

    expect(response.ok(), await response.text()).toBe(true);

    // From the browser's own origin, and fresh afterwards — the refresh endpoint is guarded by a
    // same-origin check, and this call rotates the token so the captured cookie is not a spent one.
    const resumed = await context.post('/api/v1/auth/refresh');

    expect(resumed.ok(), await resumed.text()).toBe(true);

    return await context.storageState();
  } finally {
    await context.dispose();
  }
};

/**
 * A page signed in as the colleague, minted per case.
 *
 * Per case rather than once, because rotation with reuse detection makes a saved cookie a one-shot
 * credential — the finding `session.fixture.ts` records in full.
 */
const colleaguePage = async (browser: Browser, body: (page: Page) => Promise<void>) => {
  const context = await browser.newContext({
    storageState: await mintBrowserStorageState(colleague),
  });

  try {
    await body(await context.newPage());
  } finally {
    await context.close();
  }
};

test.beforeAll(async () => {
  await asOwner(async (session) => {
    const response = await session.context.get('/api/v1/organization/security-policy', {
      headers: session.headers,
    });

    expect(response.ok(), await response.text()).toBe(true);

    const policy = (await response.json()) as StoredPolicy;

    found = {
      mfaRequiredForRoles: policy.mfaRequiredForRoles,
      mfaGracePeriodDays: policy.mfaGracePeriodDays,
    };

    colleague = testAccountEmail('mfa-enrolment');
    await provisionColleague(session, {
      email: colleague,
      roleId: await systemRoleId(session, 'manager'),
    });
  });
});

test.afterAll(async () => {
  // Nothing is written back if nothing was read: see `found`.
  if (found !== undefined) await writePolicy(found);
});

test.describe('a session the policy holds to enrolment', () => {
  test.beforeEach(async () => {
    await writePolicy({ mfaRequiredForRoles: ['manager'], mfaGracePeriodDays: 0 });
  });

  test.afterEach(async () => {
    await writePolicy(DISABLED);
  });

  test('is taken to the wizard from wherever it tries to go, and told why', async ({ browser }) => {
    await colleaguePage(browser, async (page) => {
      await page.goto('/dashboard');

      await expect(page).toHaveURL(/\/mfa-enrolment/);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Set up two-factor authentication' }),
      ).toBeVisible();
      await expect(
        page.getByText('Your organization requires two-factor authentication for your role'),
      ).toBeVisible();

      // The shell is what the scope makes a lie: every entry in it opens a route the server answers
      // with 403. Typing an address does not get around it — the guard is on the branch, not on a
      // list of routes.
      await expect(page.getByRole('navigation')).toBeHidden();

      await page.goto('/settings/security');
      await expect(page).toHaveURL(/\/mfa-enrolment/);
    });
  });

  /**
   * The one door out. `POST /auth/logout` is on the server's three-entry whitelist precisely so that
   * «not now» is an available answer, and this is the assertion that the screen offers it — a
   * session that could not sign out would leave somebody with nothing to do but close the tab.
   */
  test('can sign out, and lands on the sign-in screen', async ({ browser }) => {
    await colleaguePage(browser, async (page) => {
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/mfa-enrolment/);

      await page.getByRole('button', { name: 'Sign out instead' }).click();

      await expect(page).toHaveURL(/\/login/);
    });
  });

  /** The wizard opens from a button, so the QR and the two fields are scanned as well as the intro. */
  test('has no accessibility violations, closed or drafting', async ({ browser }) => {
    await colleaguePage(browser, async (page) => {
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/mfa-enrolment/);
      await audit(page);

      await page.getByRole('button', { name: 'Turn on two-factor authentication' }).click();
      await expect(page.getByLabel('Code from the app')).toBeVisible();

      await audit(page);
    });
  });
});

/**
 * The mirror, and the reason the wizard is a room rather than a trap: without the policy the same
 * address carries the same person straight back into the application.
 *
 * It is also the only check available here that the *exit* guard works, since finishing an enrolment
 * is out of bounds for this file — see the header.
 */
test.describe('the wizard for a session the policy does not hold', () => {
  test.beforeEach(async () => {
    await writePolicy(DISABLED);
  });

  test('carries an ordinary session back into the application', async ({ browser }) => {
    await colleaguePage(browser, async (page) => {
      await page.goto('/mfa-enrolment');

      await expect(page).toHaveURL(/\/dashboard/);
    });
  });
});
