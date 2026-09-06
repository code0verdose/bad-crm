import { expect, test } from '@playwright/test';

import { SEED_ORGANIZATION_A } from '../../fixtures/seed-data.js';
import {
  ownerApiSession,
  provisionColleague,
  sweepTestAccounts,
  systemRoleId,
  testAccountEmail,
  type ApiSession,
} from '../../fixtures/test-account.js';

/**
 * The property the teardown depends on, proven against the running application rather than assumed.
 *
 * A teardown cannot be checked by a scenario — it runs after the last of them — so the operation it
 * performs is checked here instead, on one account this scenario creates for the purpose. The
 * teardown then does the identical thing to every marked account at the end of the run.
 *
 * `q` is this account's own address on purpose. The suite is `fullyParallel`, and a sweep of every
 * marked account run from inside it would offboard the colleagues `enable-2fa` and `login-2fa` are
 * at that moment signed in as.
 */

/**
 * Invites somebody and accepts on their behalf, through the two endpoints onboarding really uses.
 *
 * The same provisioning `temporaryColleague` performs, and deliberately not that fixture: this
 * scenario is about the sweep, so the account has to still be there when the sweep runs — a fixture
 * that offboards it on the way out would leave nothing to sweep and the test would pass on an empty
 * directory.
 */
const provisionMarkedColleague = async (owner: ApiSession): Promise<string> => {
  const { email } = await provisionColleague(owner, {
    email: testAccountEmail('sweep'),
    roleId: await systemRoleId(owner, 'developer'),
  });

  return email;
};

/** Who the directory lists under `q`, on its default `status=ACTIVE&status=INVITED`. */
const directoryEmails = async (owner: ApiSession, q: string): Promise<readonly string[]> => {
  const response = await owner.context.get(
    `/api/v1/employees?${new URLSearchParams({ q, perPage: '100' }).toString()}`,
    { headers: owner.headers },
  );

  expect(response.ok(), await response.text()).toBe(true);

  const { items } = (await response.json()) as { items: readonly { email: string }[] };

  return items.map((row) => row.email);
};

test.describe('the sweep the run ends with', () => {
  test('takes an account this suite created out of the directory', async () => {
    const owner = await ownerApiSession(SEED_ORGANIZATION_A);

    try {
      const email = await provisionMarkedColleague(owner);

      // Positive control, and not a formality: a sweep asserted only by absence would pass just as
      // well against an invitation that was never accepted, or a directory that lists nobody.
      expect(await directoryEmails(owner, email)).toContain(email);

      const { swept, refused } = await sweepTestAccounts(owner, { q: email });

      expect({ swept, refused }).toEqual({ swept: 1, refused: 0 });
      expect(await directoryEmails(owner, email)).not.toContain(email);
    } finally {
      await owner.context.dispose();
    }
  });

  test('CONTROL: leaves the seeded owner in the directory', async () => {
    const owner = await ownerApiSession(SEED_ORGANIZATION_A);

    try {
      const { email } = SEED_ORGANIZATION_A.owner;

      await sweepTestAccounts(owner, { q: email });

      // The owner carries no marker, so the sweep has nothing to do here — and the product would
      // refuse anyway (`last_owner_required`). Both facts point the same way; this asserts the
      // outcome rather than either mechanism.
      expect(await directoryEmails(owner, email)).toContain(email);
    } finally {
      await owner.context.dispose();
    }
  });
});
