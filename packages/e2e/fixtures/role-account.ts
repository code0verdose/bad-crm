import { randomUUID } from 'node:crypto';

import type { SeedOrganization } from './seed-data.js';
import {
  directoryRow,
  provisionColleague,
  systemRoleId,
  type ApiSession,
  type DirectoryRow,
} from './test-account.js';

/**
 * The non-owner accounts a scenario can run as, and why there are two of them rather than four.
 *
 * ## What these buy
 *
 * The permission model is the product's second invariant, and a suite that signs in as the owner
 * everywhere cannot see it: the owner holds all 331 keys, so every assertion any role would make
 * passes. Naming the role in `test.use({ role: 'developer' })` makes «under which role does this run»
 * a property of the scenario rather than a consequence of who happened to be signed in.
 *
 * ## Why `admin` and `developer`, and not `lead`
 *
 * `lead` and `developer` differ by sixty-four permission keys, and **not one of them is reachable
 * over an endpoint this installation mounts today**: of the twenty-four permissions guarding a live
 * route, the two roles hold exactly the same four (`team:read`, `employee:read`,
 * `employee:view_org_chart` — checked against `SYSTEM_ROLE_PERMISSIONS` and
 * `route-registry.factory.ts`). Their difference is entirely in `task:*`, `project:*`, `doc:*` and
 * the rest of M3+.
 *
 * So a `leadPage` today would be a fixture whose name asserts a distinction no assertion can check,
 * which is the failure `seed-data.constant.ts` refuses in as many words for the seed itself. It
 * arrives with the first domain that separates the two — the project (EPIC-014) — and it is one
 * entry in the list below, not a new mechanism.
 *
 * `admin` against `developer`, by contrast, is a live separation: `role:read`,
 * `permission:override_read`, `user:suspend` and fifteen others answer differently today, which is
 * what `tests/rbac/role-fixtures.spec.ts` holds them to.
 *
 * ## Why these accounts outlive the run
 *
 * Making them fresh each run would cost one `invitation_create` and one `invitation_accept` per role
 * per run, and the second of those is **10 per fifteen minutes keyed on this machine's address**
 * (`test-account.ts` → `explainProvisioningRefusal`): three or four consecutive runs would start
 * failing in provisioning, on a green product. So the addresses below are deterministic, the
 * accounts are created once per database and reused, and provisioning is a lookup on every run
 * after the first.
 *
 * That is also why these addresses deliberately **do not** carry `TEST_ACCOUNT_MARKER`: the sweep
 * that offboards the colleagues a run invents would otherwise take these with it, and the next run
 * would spend the invitation budget putting them back.
 *
 * ## What is left behind
 *
 * Two accounts per database, permanently — the same standing furniture as the two seeded owners,
 * and bounded by the length of this list rather than by the number of runs. Unlike the seeded
 * owners they *can* be removed: they are not the last owner of anything, so
 * `POST /users/{id}/deactivate` accepts them, and `ensureRoleAccounts` brings them back on the next
 * run. On a laptop the wholesale answer is `pnpm docker:reset`; on CI the database dies with the
 * container.
 */
export const E2E_ROLE_KEYS = ['admin', 'developer'] as const;

export type E2ERoleKey = (typeof E2E_ROLE_KEYS)[number];

/** Deterministic, and therefore needing no file, no environment variable and no hand-off to workers. */
export const roleAccountEmail = (organization: SeedOrganization, role: E2ERoleKey): string =>
  `e2e-role-${role}@${organization.slug}.local`;

const holdsRole = (row: DirectoryRow, role: E2ERoleKey): boolean =>
  row.roles.some((held) => held.key === role);

/**
 * Makes sure the organization has an account holding this role, and answers with its address.
 *
 * Idempotent by construction: the address is derived from the organization and the role, so the
 * lookup that decides whether to invite is the same one on every machine and every run.
 */
export const ensureRoleAccount = async (
  owner: ApiSession,
  organization: SeedOrganization,
  role: E2ERoleKey,
): Promise<string> => {
  const email = roleAccountEmail(organization, role);
  const existing = await directoryRow(owner, email);

  if (existing === undefined) {
    await provisionColleague(owner, { email, roleId: await systemRoleId(owner, role) });

    return email;
  }

  if (existing.status === 'SUSPENDED') {
    // Somebody swept the database by hand, or by a wider pattern than the marker. Reactivation is
    // the operation for it, and it keeps the role assignment — which the check below then proves
    // rather than assumes.
    const restored = await owner.context.post(`/api/v1/users/${existing.userId}/reactivate`, {
      headers: { ...owner.headers, 'Idempotency-Key': randomUUID() },
    });

    if (!restored.ok()) {
      throw new Error(
        [
          `The role account ${email} is suspended and could not be brought back:`,
          `HTTP ${String(restored.status())}. ${await restored.text()}`,
        ].join('\n'),
      );
    }
  }

  if (!holdsRole(existing, role)) {
    throw new Error(
      [
        `The account ${email} exists but does not hold the \`${role}\` role, so a scenario using it`,
        'would silently be running as somebody else. Give it the role back, or offboard the account',
        'and let the next run provision a new one.',
      ].join('\n'),
    );
  }

  return email;
};

/** Every role account of one organization, provisioned once before the first scenario runs. */
export const ensureRoleAccounts = async (
  owner: ApiSession,
  organization: SeedOrganization,
): Promise<void> => {
  // Sequential: both branches spend the same two rate-limited operations, and a parallel first run
  // would also race two invitations for one address if the list ever grew a duplicate.
  for (const role of E2E_ROLE_KEYS) {
    await ensureRoleAccount(owner, organization, role);
  }
};
