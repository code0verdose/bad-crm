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
 * Safe to retry only when `action` performs no more than one mutating request under the session
 * `mint` hands it: a `401` means the gate refused that request before anything was written, never
 * one that partly succeeded — so retrying with a fresh session cannot double a write. `action` may
 * still make several *idempotent* calls under the one session (`ensureScenarioColleague` looks up
 * before it ever creates, so calling it twice under two different retried sessions costs nothing);
 * what it must not do is depend on an earlier call's side effect surviving into a later attempt.
 * Every caller in `tests/projects/**` holds to that.
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
 * problem for `admin`/`developer` with a deterministic address, invited once and reused forever.
 *
 * This is the same solution for a subject that must not be `admin` or `developer` themselves: both
 * of those are also read as **browser sessions** by other suites (`tests/rbac/role-fixtures.spec.ts`,
 * `tests/security/org-2fa-policy.spec.ts`), and seating either of them on a project bumps their own
 * `permissions_version` at a moment those files cannot predict, turning an already-open session of
 * theirs into a stale one — measured 2026-09-27 in `project-overview.spec.ts`'s own file doc, which
 * moved its project `LEAD` off `admin` for exactly this reason. A scenario colleague is never read by
 * anything but the one file that provisioned it, so seating it on that file's own project has no such
 * neighbour to surprise.
 *
 * **`systemRole` almost always stays `developer`, even for a colleague that needs more than
 * `developer` holds.** `tests/security/org-2fa-policy.spec.ts` asserts an exact headcount of who
 * holds the `admin` **role** in this organization (`«of 3 covered people»`) — measured 2026-09-27:
 * giving a scenario colleague the `admin` system role, to reach `project:archive`/`project:delete`,
 * inflated that headcount to four and turned a green, unrelated file red. A colleague that needs a
 * capability beyond `developer`'s gets it through `grantPermissionOverride` below instead — layer 3
 * of the permission model, additive to one person, invisible to any report that counts role holders.
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

/**
 * Widens one scenario colleague's capability by one key, through the product's own layer-3
 * mechanism (`PUT /users/{userId}/permission-overrides/{permission}`) rather than a stronger system
 * role — see `ensureScenarioColleague`'s doc on why a role that carries more than `developer` risks
 * inflating some *other* file's exact headcount of who holds it.
 *
 * `ALLOW` may only hand out a permission the caller already holds — the owner holds every key, so
 * `owner` is always the right caller here. Idempotent by the endpoint's own contract (`PUT` on the
 * pair identifies the row), which is what lets this run again on every reuse of the colleague
 * without growing anything; no `expiresAt`, because a scenario colleague that outlives the run needs
 * the grant to outlive it too.
 */
export const grantPermissionOverride = async (
  owner: ApiSession,
  userId: string,
  permission: string,
  reason: string,
): Promise<void> => {
  const response = await owner.context.put(
    `/api/v1/users/${userId}/permission-overrides/${encodeURIComponent(permission)}`,
    {
      headers: owner.headers,
      data: { effect: 'ALLOW', reason },
    },
  );

  if (!response.ok()) {
    throw new Error(
      `Could not grant ${permission} to ${userId}: HTTP ${String(response.status())}.\n${await response.text()}`,
    );
  }
};
