import { randomUUID } from 'node:crypto';

import { type SeedOrganization } from './seed-data.js';
import {
  directoryRow,
  ownerApiSession,
  provisionColleague,
  systemRoleId,
  type ApiSession,
} from './test-account.js';

/**
 * A session minted just before its call still answered `401 unauthenticated` — the login and the
 * call it authorised were on either side of a *sibling worker's* own mutation, which seats or moves
 * somebody and bumps their `permissions_version` in between. `expect`'s custom failure message (the
 * response body, passed as the second argument the way every `createProject`/`addProjectMember`
 * helper in `tests/projects/**` does) is what carries the code this far.
 *
 * Measured 2026-09-27: `tests/projects/project-list.spec.ts`, `project-overview.spec.ts` and
 * `membership-invalidates-permissions.spec.ts` all mint an owner session for `SEED_ORGANIZATION_A`
 * and use it to create or change a project within a few milliseconds of logging in. Any one of
 * them creating a project seats the owner as a member of it (`CreateProjectUseCase` seats the
 * creator and the lead), which bumps the *owner's own* `permissions_version` — so at Playwright's
 * default parallelism, three files' worth of these calls interleave across workers closely enough
 * that a session minted by one file is regularly spent by the time it is used, by a bump from
 * another. This is a property of the product's own token model (`session.fixture.ts`'s doc explains
 * the same staleness for a token reused *within* one file), not a defect in any of these tests, and
 * retrying with another fresh session is the same self-healing a browser session gets for free from
 * a page reload.
 */
export const isStaleSessionError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('"code":"unauthenticated"');

/** How many times a narrow cross-worker race is retried before it counts as a real failure. */
export const MAX_SESSION_ATTEMPTS = 4;

/**
 * Runs one call under its own, freshly minted session of the kind `mint` produces, retrying with
 * another fresh session if the previous one turns out already stale (see `isStaleSessionError`).
 *
 * Safe to retry only when `action` performs exactly one mutating request: a `401` means the gate
 * refused it before anything was written, never a request that partly succeeded. Every caller in
 * `tests/projects/**` holds to that.
 */
export const withRetriedSession = async <T>(
  mint: () => Promise<ApiSession>,
  action: (session: ApiSession) => Promise<T>,
): Promise<T> => {
  for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt += 1) {
    const session = await mint();

    try {
      return await action(session);
    } catch (error) {
      if (attempt === MAX_SESSION_ATTEMPTS || !isStaleSessionError(error)) throw error;
    } finally {
      await session.context.dispose();
    }
  }

  // Unreachable: the loop above always either returns or throws on its last attempt.
  throw new Error('withRetriedSession: exhausted attempts without returning or throwing');
};

/**
 * Runs one owner-authenticated call under its own, freshly minted session — never a session another
 * call already spent (`project-list.spec.ts`'s file doc explains why a reused token goes stale after
 * the first seat), and retried across a cross-worker race the same way (`isStaleSessionError` above).
 */
export const withOwnerSession = async <T>(
  organization: SeedOrganization,
  action: (owner: ApiSession) => Promise<T>,
): Promise<T> => withRetriedSession(() => ownerApiSession(organization), action);

export interface ScenarioColleague {
  readonly userId: string;
  readonly email: string;
}

/** Deterministic, for the same reason `role-account.ts` gives for the standing role accounts. */
export const scenarioColleagueEmail = (organization: SeedOrganization, key: string): string =>
  `e2e-scenario-${key}@${organization.slug}.local`;

/**
 * A colleague one `tests/projects/**` file reuses across every run, rather than inviting and
 * accepting a fresh one every time.
 *
 * `provisionColleague` (`test-account.ts`) is what the sweepable one-off accounts of most e2e
 * scenarios use, and it costs one `invitation_create` and one `invitation_accept` — the latter
 * capped at **10 per 15 minutes, keyed on this machine's address**, shared by every scenario that
 * calls it. Three `tests/projects/**` files each provisioning their own one-off subject, run three
 * times in a row the way this suite's own gate does, spend nine of those ten within the first two
 * runs and refuse the third outright — measured 2026-09-27. `role-account.ts` solves the identical
 * problem for `admin`/`developer` with a deterministic address, invited once and reused forever;
 * this is the same solution for a colleague that must not be `admin` or `developer` themselves (see
 * `withOwnerSession`'s doc on why: those two are read by other files' browser sessions and must
 * never be seated on anything).
 *
 * Not swept by the global teardown: the address deliberately carries no `TEST_ACCOUNT_MARKER`, for
 * the reason `role-account.ts` gives for its own accounts — a sweep that took it would make the next
 * run spend the invitation budget putting it back. A caller therefore never offboards this account
 * itself either.
 */
export const ensureScenarioColleague = async (
  owner: ApiSession,
  organization: SeedOrganization,
  key: string,
  systemRole: string,
): Promise<ScenarioColleague> => {
  const email = scenarioColleagueEmail(organization, key);
  const existing = await directoryRow(owner, email);

  if (existing !== undefined) {
    if (existing.status === 'SUSPENDED') {
      const restored = await owner.context.post(`/api/v1/users/${existing.userId}/reactivate`, {
        headers: { ...owner.headers, 'Idempotency-Key': randomUUID() },
      });

      if (!restored.ok()) {
        throw new Error(
          `Could not reactivate the scenario colleague ${email}: HTTP ${String(restored.status())}.\n${await restored.text()}`,
        );
      }
    }

    return { userId: existing.userId, email };
  }

  const roleId = await systemRoleId(owner, systemRole);

  return provisionColleague(owner, { email, roleId });
};
