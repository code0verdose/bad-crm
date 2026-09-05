import { randomUUID } from 'node:crypto';

import { expect, request, test } from '@playwright/test';

import { SEED_ORGANIZATION_A, SEED_PASSWORD } from '../../fixtures/seed-data.js';
import {
  explainProvisioningRefusal,
  ownerApiSession,
  sweepTestAccounts,
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

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

/** The `developer` system role, needed only because `POST /invitations` requires one. */
const developerRoleId = async (owner: ApiSession): Promise<string> => {
  const response = await owner.context.get('/api/v1/roles', { headers: owner.headers });

  expect(response.ok(), await response.text()).toBe(true);

  const { items } = (await response.json()) as { items: readonly { id: string; key: string }[] };
  const developer = items.find((role) => role.key === 'developer');

  if (developer === undefined) {
    throw new Error('the organization has no `developer` system role — has provisioning run?');
  }

  return developer.id;
};

/** Invites somebody and accepts on their behalf — the two endpoints onboarding really uses. */
const provisionMarkedColleague = async (owner: ApiSession, roleId: string): Promise<string> => {
  const email = testAccountEmail('sweep');

  const invited = await owner.context.post('/api/v1/invitations', {
    headers: { ...owner.headers, 'Idempotency-Key': randomUUID() },
    data: { email, roleId, locale: 'en' },
  });

  expect(invited.ok(), await explainProvisioningRefusal(invited, 'create')).toBe(true);

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

    expect(accepted.ok(), await explainProvisioningRefusal(accepted, 'accept')).toBe(true);

    return email;
  } finally {
    await anonymous.dispose();
  }
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
      const email = await provisionMarkedColleague(owner, await developerRoleId(owner));

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
