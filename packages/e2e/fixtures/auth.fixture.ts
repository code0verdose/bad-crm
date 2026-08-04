import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { request } from '@playwright/test';

import { SEED_ORGANIZATIONS, SEED_PASSWORD, type SeedOrganization } from './seed-data.js';

export { SEED_ORGANIZATIONS, SEED_ORGANIZATION_A, SEED_ORGANIZATION_B } from './seed-data.js';

/**
 * Sessions established once, over the API, and reused by every scenario as `storageState`.
 *
 * Signing in through the form in each test costs three seconds a test for a screen the test is not
 * about — and makes every failure of that screen a failure of the whole suite. The form is
 * exercised in exactly one place, the scenario that tests it, and it uses an anonymous context.
 *
 * **The state files live in the run's temporary directory, never in the repository.** What they
 * carry is a live refresh cookie: a credential, valid for weeks, for an account that can administer
 * an organization. A file like that in the working tree is one `git add -A` away from being
 * published, and in a CI artifact it is a credential handed to whoever can read the build.
 */

/**
 * Where this run keeps its sessions, handed from the setup process to the workers by environment.
 *
 * The first version keyed the directory on `process.pid`, which is wrong in a way that is invisible
 * until it runs: `globalSetup` and each worker are **different processes**, so the workers computed
 * a different path and found nothing. The variable is the handshake Playwright documents for
 * exactly this, and it is set before the first worker is spawned, so every worker inherits it.
 */
const STATE_DIRECTORY_VARIABLE = 'E2E_STATE_DIRECTORY';

/** Creates the directory for this run and publishes it. Called once, from `global-setup.ts`. */
export const openStateDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'bad-crm-e2e-'));

  process.env[STATE_DIRECTORY_VARIABLE] = directory;

  return directory;
};

/**
 * Why no session could be established, when that is the case.
 *
 * Set by the setup process and read by the workers, like the directory above. It exists so the
 * failure lands **where it matters**: a suite whose sessions could not be created still contains
 * scenarios that need none — the sign-in form, the anonymous guard, the accessibility audit — and
 * aborting the whole run would hide their result behind an environment problem they do not have.
 * A scenario that does ask for a session fails immediately, with this reason instead of a redirect.
 */
const UNAVAILABLE_VARIABLE = 'E2E_SESSIONS_UNAVAILABLE';

const stateDirectory = (): string => {
  const unavailable = process.env[UNAVAILABLE_VARIABLE];

  if (unavailable !== undefined && unavailable !== '') throw new Error(unavailable);

  const directory = process.env[STATE_DIRECTORY_VARIABLE];

  if (directory === undefined) {
    throw new Error(
      `${STATE_DIRECTORY_VARIABLE} is not set: the run started without global-setup.ts, so no session was established.`,
    );
  }

  return directory;
};

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';

/** Where the browser will be served from — the origin the API has to be willing to accept. */
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

/** Where the saved session of one organization's owner lives. */
export const sessionOf = (organization: SeedOrganization): string =>
  join(stateDirectory(), `${organization.slug}.json`);

/**
 * Signs in every seeded owner and writes their session to disk.
 *
 * Called from `global-setup.ts`, once per run, after readiness. Playwright's request context keeps
 * the cookie jar, so `storageState({ path })` writes exactly what a browser context needs — the
 * refresh cookie. The access token is deliberately **not** in it: it lives in the memory of one tab
 * for fifteen minutes, and the client exchanges the cookie for a new one on load. Saving it would
 * mean saving a credential that is stale before the second scenario starts.
 */
export const createSessions = async (): Promise<void> => {
  try {
    await establishSessions();
  } catch (error) {
    // Recorded rather than thrown: see `UNAVAILABLE_VARIABLE`. The message is the one the scenario
    // that needs a session will fail with, and it is printed here too so a run that has no such
    // scenario still says out loud what did not happen.
    const reason = error instanceof Error ? error.message : String(error);

    process.env[UNAVAILABLE_VARIABLE] = reason;
    process.stderr.write(`\ne2e: no session was established.\n${reason}\n\n`);
  }
};

const establishSessions = async (): Promise<void> => {
  openStateDirectory();

  for (const organization of SEED_ORGANIZATIONS) {
    const context = await request.newContext({ baseURL: apiURL() });

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

      // The same exchange the browser makes on load, with the **browser's** origin — and the reason
      // it is here rather than left to the first scenario.
      //
      // `POST /auth/refresh` is guarded by a same-origin check: it is the one endpoint a cookie
      // alone authorises, so an `Origin` that is present and not the installation's is refused.
      // A run whose client is served from a port the API was not configured with therefore produces
      // a perfectly valid saved session that the application refuses to resume — and the symptom is
      // a redirect to the sign-in form, which reads as «the guard is broken» or «the fixture did not
      // load». Measured on 2026-08-05: `Origin: http://localhost:5174` against an installation whose
      // `APP_URL` is `http://localhost:5173` answers 401 `unauthenticated`.
      //
      // It also leaves the saved cookie **fresh**: refresh rotates the token, so checking after
      // saving would store a spent one, and the first scenario to use it would trip reuse detection
      // and revoke the whole family.
      const resumed = await context.post('/api/v1/auth/refresh', {
        headers: { origin: browserOrigin() },
      });

      if (!resumed.ok()) {
        throw new Error(
          [
            `The API refuses to resume a session for origin ${browserOrigin()} (HTTP ${String(resumed.status())}).`,
            'The saved session is valid; what the installation rejects is where the browser is served from.',
            `Serve the client on the origin of APP_URL, or add ${browserOrigin()} to CORS_EXTRA_ORIGINS and restart the API.`,
          ].join('\n'),
        );
      }

      await context.storageState({ path: sessionOf(organization) });
    } finally {
      await context.dispose();
    }
  }
};
