import { test as base, request, type Browser, type Page } from '@playwright/test';

import { roleAccountEmail, type E2ERoleKey } from './role-account.js';
import { SEED_ORGANIZATION_A, SEED_PASSWORD, type SeedOrganization } from './seed-data.js';
import { apiSessionFor, type ApiSession } from './test-account.js';

/**
 * A signed-in page, with a session minted for this test and for nothing else.
 *
 * The first version of this harness saved one session per organization to a file and shared it
 * across scenarios (`storageState`). It worked once and then stopped, and the reason is a property
 * of the product rather than of the suite: the client exchanges the refresh cookie on load, and
 * **rotation with reuse detection makes a saved cookie a one-shot credential**. The second context
 * to present it — a retry, a parallel worker — is indistinguishable from a stolen token, so the
 * family is revoked and every scenario after it meets a sign-in form. Measured in CI on 2026-08-05:
 * the first attempt reached `/dashboard`, the retry was redirected to `/login`.
 *
 * So each test gets its own family. The cost is one API sign-in per test — tens of milliseconds,
 * against the seconds a form costs, and without making every scenario depend on the sign-in screen.
 * The form is still exercised exactly once, by the scenario that tests it.
 */

/**
 * Whose session a scenario runs under. `owner` is the seeded owner; the rest are the standing role
 * accounts of `role-account.ts`, which also explains why the list stops where it does.
 */
export type FixtureRole = 'owner' | E2ERoleKey;

export interface SessionFixtures {
  /** Which seeded organization this test runs in. Override with `test.use`. */
  seedOrganization: SeedOrganization;
  /** Which role this test runs as. Override with `test.use({ role: 'developer' })`. */
  role: FixtureRole;
  /**
   * A page signed in as the organization's owner.
   *
   * The same thing as `rolePage` with the default role, and kept as its own name because most
   * scenarios are about a product behaviour rather than about a role: making every one of them
   * declare `role: 'owner'` would put an irrelevant word in front of the relevant ones, and the
   * point of `rolePage` is that naming a role means something.
   */
  ownerPage: Page;
  /** A page signed in as `role` — the browser half of «this scenario runs as an administrator». */
  rolePage: Page;
  /**
   * A bearer-token API session for the same person `rolePage` is signed in as.
   *
   * Both halves are needed and neither substitutes for the other: the page is what a person clicks,
   * and the token is what answers «what does the API say to this role», which is the only place a
   * 403 can be told apart from a screen that merely renders nothing.
   */
  roleApi: ApiSession;
}

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

type StorageState = Awaited<
  ReturnType<Awaited<ReturnType<typeof request.newContext>>['storageState']>
>;

/**
 * Which account a role names in an organization.
 *
 * The owner comes from the seed; every other role is a standing account with a deterministic
 * address, which is why nothing has to be handed from `globalSetup` to the workers.
 */
export const accountEmailFor = (organization: SeedOrganization, role: FixtureRole): string =>
  role === 'owner' ? organization.owner.email : roleAccountEmail(organization, role);

/** Signs in over the API and returns the cookie jar a browser context can start from. */
const mintSession = async (email: string): Promise<StorageState> => {
  const context = await request.newContext({
    baseURL: apiURL(),
    extraHTTPHeaders: { origin: browserOrigin() },
  });

  try {
    const response = await context.post('/api/v1/auth/login', {
      data: { email, password: SEED_PASSWORD },
    });

    if (!response.ok()) {
      throw new Error(
        [
          `Could not sign in ${email}: HTTP ${String(response.status())}.`,
          await response.text(),
          'Run `pnpm db:seed` against the stack this run points at.',
        ].join('\n'),
      );
    }

    // The same exchange the browser makes on load, from the **browser's** origin — and the reason
    // it is here rather than left to the first assertion.
    //
    // `POST /auth/refresh` is guarded by a same-origin check: it is the one endpoint a cookie alone
    // authorises. A run whose client is served from a port the installation was not configured with
    // therefore produces a perfectly valid session that the application refuses to resume, and the
    // symptom is a redirect to the sign-in form — which reads as «the guard is broken» or «the
    // fixture did not load». Measured 2026-08-05: `Origin: http://localhost:5174` against an
    // installation whose `APP_URL` is `http://localhost:5173` answers 401.
    //
    // It also leaves the cookie in the jar **fresh**: refresh rotates the token, so a state captured
    // before this call would carry a spent one.
    const resumed = await context.post('/api/v1/auth/refresh');

    if (!resumed.ok()) {
      throw new Error(
        [
          `The API refuses to resume a session for origin ${browserOrigin()} (HTTP ${String(resumed.status())}).`,
          'The session is valid; what the installation rejects is where the browser is served from.',
          `Serve the client on the origin of APP_URL, or add ${browserOrigin()} to CORS_EXTRA_ORIGINS and restart the API.`,
        ].join('\n'),
      );
    }

    return await context.storageState();
  } finally {
    await context.dispose();
  }
};

/**
 * A browser context of its own, carrying a session minted for this test and no other.
 *
 * Its own context rather than a shared one, and that is what keeps two roles running in parallel
 * from becoming one: cookies live in the context, so a scenario running as a developer cannot end
 * up holding the administrator's session no matter what order the workers happen to run in.
 */
const signedInPage = async (
  browser: Browser,
  email: string,
  body: (page: Page) => Promise<void>,
): Promise<void> => {
  const context = await browser.newContext({ storageState: await mintSession(email) });
  const page = await context.newPage();

  try {
    await body(page);
  } finally {
    await context.close();
  }
};

export const test = base.extend<SessionFixtures>({
  seedOrganization: [SEED_ORGANIZATION_A, { option: true }],
  role: ['owner', { option: true }],

  ownerPage: async ({ browser, seedOrganization }, use) => {
    await signedInPage(browser, seedOrganization.owner.email, use);
  },

  rolePage: async ({ browser, seedOrganization, role }, use) => {
    await signedInPage(browser, accountEmailFor(seedOrganization, role), use);
  },

  roleApi: async ({ seedOrganization, role }, use) => {
    const session = await apiSessionFor(accountEmailFor(seedOrganization, role));

    try {
      await use(session);
    } finally {
      await session.context.dispose();
    }
  },
});

export { expect } from '@playwright/test';
