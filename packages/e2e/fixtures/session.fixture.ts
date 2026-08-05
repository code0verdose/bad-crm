import { test as base, request, type Page } from '@playwright/test';

import { SEED_ORGANIZATION_A, SEED_PASSWORD, type SeedOrganization } from './seed-data.js';

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

export interface SessionFixtures {
  /** Which seeded organization's owner this test runs as. Override with `test.use`. */
  seedOrganization: SeedOrganization;
  /** A page whose context carries a session freshly minted for this test. */
  ownerPage: Page;
}

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

type StorageState = Awaited<ReturnType<Awaited<ReturnType<typeof request.newContext>>['storageState']>>;

/** Signs in over the API and returns the cookie jar a browser context can start from. */
const mintSession = async (organization: SeedOrganization): Promise<StorageState> => {
  const context = await request.newContext({
    baseURL: apiURL(),
    extraHTTPHeaders: { origin: browserOrigin() },
  });

  try {
    const response = await context.post('/api/v1/auth/login', {
      data: { email: organization.owner.email, password: SEED_PASSWORD },
    });

    if (!response.ok()) {
      throw new Error(
        [
          `Could not sign in ${organization.owner.email}: HTTP ${String(response.status())}.`,
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

export const test = base.extend<SessionFixtures>({
  seedOrganization: [SEED_ORGANIZATION_A, { option: true }],

  ownerPage: async ({ browser, seedOrganization }, use) => {
    const context = await browser.newContext({ storageState: await mintSession(seedOrganization) });
    const page = await context.newPage();

    await use(page);

    await context.close();
  },
});

export { expect } from '@playwright/test';
