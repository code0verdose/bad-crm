import { test as sessionTest } from './session.fixture.js';
import {
  offboardAccount,
  ownerApiSession,
  provisionColleague,
  systemRoleId,
  testAccountEmail,
  type ProvisionedAccount,
} from './test-account.js';

/**
 * A colleague who did not exist before this test and is out of the directory after it.
 *
 * The counterpart to the standing role accounts: those are furniture, reused by every run because
 * provisioning is rate-limited; this one is for the scenario that needs somebody **fresh** — an
 * account with no history, whose rights nobody has touched, whose sessions are its own. A scenario
 * that mutates a person (an exception written on them, a role revoked from them, an offboarding
 * performed on them) must have one of these, or it leaves the next scenario a different fixture
 * than the one it was promised.
 *
 * Cleanup is offboarding, because there is no delete in the contract and there is deliberately not
 * going to be one — `test-account.ts` carries the reasoning. What that buys is what «removed» can
 * mean here: the account leaves the directory's working set and every one of its sessions is
 * revoked in the same transaction.
 *
 * The address carries `TEST_ACCOUNT_MARKER`, so the run's global teardown collects it too — a
 * scenario killed with Ctrl-C never reaches a fixture teardown, and that is exactly the run that
 * left an account behind.
 */
export interface TemporaryColleagueFixtures {
  /** Which system role the temporary colleague is invited with. */
  temporaryColleagueRole: string;
  temporaryColleague: ProvisionedAccount;
}

export const test = sessionTest.extend<TemporaryColleagueFixtures>({
  temporaryColleagueRole: ['developer', { option: true }],

  temporaryColleague: async ({ seedOrganization, temporaryColleagueRole }, use) => {
    const owner = await ownerApiSession(seedOrganization);

    try {
      const account = await provisionColleague(owner, {
        email: testAccountEmail('temporary'),
        roleId: await systemRoleId(owner, temporaryColleagueRole),
      });

      await use(account);

      // Reported rather than thrown: a failure on the way out of a green test says nothing about
      // the product, and the marker sweep in `global-teardown.ts` collects whatever is left. That
      // the offboarding really happens is asserted where it can be — `tests/rbac/temporary-account.spec.ts`.
      if (!(await offboardAccount(owner, account.userId))) {
        process.stdout.write(
          `could not offboard the temporary colleague ${account.email}; the run's sweep will retry\n`,
        );
      }
    } finally {
      await owner.context.dispose();
    }
  },
});

export { expect } from '@playwright/test';
