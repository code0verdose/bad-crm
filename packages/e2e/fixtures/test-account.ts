import { randomUUID } from 'node:crypto';

import { request, type APIRequestContext, type APIResponse } from '@playwright/test';

import { SEED_PASSWORD, type SeedOrganization } from './seed-data.js';

/**
 * The accounts a run creates, and how they stop being the run's problem afterwards.
 *
 * ## What this exists to stop
 *
 * Measured 2026-08-30 against a live installation: one full run adds four accounts, four
 * invitations, thirty-nine session rows, thirty recovery codes and forty-eight audit lines, and
 * nothing anywhere took any of it back — `seed-org-a` had reached seventy-eight people, every one
 * of them a colleague invented by `enable-2fa`, `login-2fa`, `recovery-login` or `override-target`
 * on some earlier afternoon. The seed is not the source: it creates two organizations and skips
 * both when they exist.
 *
 * The suite still passed at seventy-eight, and that is exactly the shape of the problem — the
 * failure arrives later, in somebody else's change, as a directory that takes longer to paint than
 * an assertion waits for.
 *
 * ## Why offboarding rather than deletion
 *
 * There is no delete. `POST /users/{id}/deactivate` says so in as many words — «Nothing is
 * deleted», because tasks, hours and the audit trail keep pointing at the person (NFR-12) — and no
 * other operation in the contract removes an account either. A teardown reaching past the API into
 * PostgreSQL to remove rows the product deliberately keeps would be a harness asserting one thing
 * and doing another, and it would need database credentials this package has no business holding.
 *
 * Offboarding is the operation the product actually offers, and it happens to do the whole job:
 * `GET /employees` defaults to `status=ACTIVE&status=INVITED`, so a suspended account leaves the
 * directory's working set, and the same transaction revokes every live session. What is left
 * behind is history, which is what history is for.
 *
 * The seeded owners are safe from this by two independent facts, neither of them a promise made
 * here: they carry no marker, and `last_owner_required` refuses the operation on the last owner of
 * an organization anyway. The standing role accounts of `role-account.ts` are safe by the first of
 * those alone, and deliberately so: a sweep that took them would make the next run spend the
 * invitation budget putting them back.
 */

/**
 * The substring every account this suite creates carries, and the whole of what the sweep matches.
 *
 * Deliberately not a run identifier. A run that dies in the middle of a scenario still leaves its
 * colleagues behind, and a sweep keyed on the run that created them could never reach those — the
 * next run would step over them and the pile would keep growing, more slowly and just as
 * permanently. Matching a marker instead means every run cleans up after every run before it.
 *
 * Nobody types this by accident, which is what makes it safe to point at a shared installation:
 * the sweep can only ever reach accounts this harness itself invented.
 */
export const TEST_ACCOUNT_MARKER = 'e2e-sweepable';

/**
 * An address for a colleague this run invents. One shape, so one pattern finds all of them.
 *
 * Eight hex digits rather than a whole UUID, and that is a constraint of the product rather than a
 * preference: `GET /employees` caps `q` at 64 characters, and a full UUID puts this address a few
 * over — a scenario looking itself up by address would be answered 422 instead of a directory page.
 * Eight digits is four billion, against the handful of colleagues one run creates.
 */
export const testAccountEmail = (prefix: string): string =>
  `${TEST_ACCOUNT_MARKER}-${prefix}-${randomUUID().slice(0, 8)}@org-a.local`;

const apiURL = (): string => process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const browserOrigin = (): string =>
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin;

/**
 * A type alias rather than an interface, and the difference matters here: only an alias gets the
 * implicit index signature that lets it be passed where Playwright asks for `{ [key: string]: string }`.
 * `authorization` is replaceable so that a caller whose rights changed can re-mint the token in place.
 */
export type ApiHeaders = { authorization: string; readonly origin: string };

export interface ApiSession {
  readonly context: APIRequestContext;
  readonly headers: ApiHeaders;
  /** Who this token belongs to — the subject of the calls a role control makes about itself. */
  readonly userId: string;
}

/**
 * Signs an account in over the API and hands back a context ready to carry the bearer token.
 *
 * A bearer token rather than the cookie jar `session.fixture.ts` mints, and the difference is not
 * cosmetic: this is the credential a *caller* uses, and a scenario asking «what does the API answer
 * this person» must not ask it through the browser context of somebody else's page.
 */
export const apiSessionFor = async (
  email: string,
  password: string = SEED_PASSWORD,
): Promise<ApiSession> => {
  const context = await request.newContext({
    baseURL: apiURL(),
    extraHTTPHeaders: { origin: browserOrigin() },
  });

  const response = await context.post('/api/v1/auth/login', { data: { email, password } });

  if (!response.ok()) {
    await context.dispose();

    throw new Error(
      [
        `Could not sign in ${email}: HTTP ${String(response.status())}.`,
        await response.text(),
        'Run `pnpm db:seed` against the stack this run points at.',
      ].join('\n'),
    );
  }

  const { accessToken, user } = (await response.json()) as {
    accessToken: string;
    user: { id: string };
  };

  return {
    context,
    headers: { authorization: `Bearer ${accessToken}`, origin: browserOrigin() },
    userId: user.id,
  };
};

/** The seeded owner of an organization — the account that provisions and sweeps everything below. */
export const ownerApiSession = async (organization: SeedOrganization): Promise<ApiSession> =>
  apiSessionFor(organization.owner.email);

/**
 * Turns a 429 during provisioning into the sentence that explains it.
 *
 * Two product limits stand between a run and the colleague it needs, and neither is a defect:
 *
 * - `invitation_accept` — **10 per 15 minutes, keyed on the address**. This is the binding one.
 *   Every scenario needing a colleague accepts exactly one invitation and they all come from the
 *   same machine, so the whole suite spends one budget: at five accepts a run, two consecutive
 *   runs fill it and the third is refused partway through. Measured 2026-08-30 — runs one and two
 *   passed, run three failed on its third colleague.
 * - `invitation_create` — 20 per 10 minutes, keyed on the **inviting owner**, and reached a run or
 *   two later than the one above.
 *
 * Both are keyed the only way they can be. The token is the credential at `accept`, so the caller
 * has no account and the address is the only subject there is; at `create` the recipient is the
 * part the caller varies, which is why the inviter is counted instead (`T-IAM-10`).
 *
 * The reason this message exists at all: the refusal surfaces as an ordinary assertion failure on
 * `invited.ok()`, which reads as «the invitation endpoint is broken» and costs an afternoon in the
 * wrong file. The answer is to let the window pass. **Do not widen either policy to make the suite
 * green** — they are brute-force and mail-cannon guards, and the suite would be the only
 * beneficiary. If reruns need to be quicker, spend fewer invitations, not a weaker limit.
 */
export const explainProvisioningRefusal = async (
  response: APIResponse,
  step: 'create' | 'accept',
): Promise<string> => {
  const body = await response.text();

  if (response.status() !== 429) return body;

  const policy =
    step === 'accept'
      ? "`invitation_accept`: 10 per 15 minutes, keyed on this machine's address."
      : '`invitation_create`: 20 per 10 minutes, keyed on the inviting seeded owner.';

  return [
    body,
    '',
    `This is ${policy}`,
    'The suite spends one of each per colleague, so a couple of back-to-back runs exhaust it. Wait',
    'for the window rather than changing anything — see fixtures/test-account.ts for the arithmetic.',
  ].join('\n');
};

export type EmployeeStatus = 'ACTIVE' | 'SUSPENDED' | 'INVITED';

export interface DirectoryRole {
  readonly id: string;
  readonly key: string;
}

export interface DirectoryRow {
  readonly userId: string;
  readonly email: string;
  readonly status: EmployeeStatus;
  readonly roles: readonly DirectoryRole[];
}

/**
 * One person of the caller's organization, by address, or nothing.
 *
 * `q` is a substring match over name, e-mail, job title and department, so the answer is filtered
 * again here on the exact address — a prefix of one fixture address is a prefix of the next one.
 *
 * Statuses are named rather than defaulted: the endpoint's own default hides suspended accounts,
 * which is right for a directory screen and wrong for a fixture asking «does this account already
 * exist», where a hidden account is the difference between reactivating one and inviting a second.
 */
export const directoryRow = async (
  reader: ApiSession,
  email: string,
  options: { readonly statuses?: readonly EmployeeStatus[] } = {},
): Promise<DirectoryRow | undefined> => {
  const query = new URLSearchParams({ q: email, perPage: '100' });

  for (const status of options.statuses ?? (['ACTIVE', 'SUSPENDED', 'INVITED'] as const)) {
    query.append('status', status);
  }

  const response = await reader.context.get(`/api/v1/employees?${query.toString()}`, {
    headers: reader.headers,
  });

  if (!response.ok()) {
    throw new Error(
      `Could not read the directory: HTTP ${String(response.status())}.\n${await response.text()}`,
    );
  }

  const { items } = (await response.json()) as { items: readonly DirectoryRow[] };

  return items.find((row) => row.email === email);
};

/** The organization's system role of this key, by id — provisioned for every organization. */
export const systemRoleId = async (reader: ApiSession, key: string): Promise<string> => {
  const response = await reader.context.get('/api/v1/roles', { headers: reader.headers });

  if (!response.ok()) {
    throw new Error(
      `Could not list roles: HTTP ${String(response.status())}.\n${await response.text()}`,
    );
  }

  const { items } = (await response.json()) as { items: readonly DirectoryRole[] };
  const role = items.find((candidate) => candidate.key === key);

  if (role === undefined) {
    throw new Error(`the organization has no \`${key}\` role — has provisioning run?`);
  }

  return role.id;
};

export interface ProvisionedAccount {
  readonly userId: string;
  readonly email: string;
}

/**
 * Invites somebody with a role and accepts on their behalf — the product's own two endpoints, never
 * a direct insert.
 *
 * There is no «create user» in the contract, and there should not be: an account exists because
 * somebody accepted an invitation, and a harness that reached past that would be testing a path the
 * product does not have. The cost is two rate-limited operations per account, which is the whole
 * reason the role accounts of `role-account.ts` are provisioned once and kept rather than made
 * fresh each run — see `explainProvisioningRefusal` above for the arithmetic.
 */
export const provisionColleague = async (
  owner: ApiSession,
  options: { readonly email: string; readonly roleId: string },
): Promise<ProvisionedAccount> => {
  const invited = await owner.context.post('/api/v1/invitations', {
    headers: { ...owner.headers, 'Idempotency-Key': randomUUID() },
    data: { email: options.email, roleId: options.roleId, locale: 'en' },
  });

  if (!invited.ok()) {
    throw new Error(
      `Could not invite ${options.email}: HTTP ${String(invited.status())}.\n${await explainProvisioningRefusal(invited, 'create')}`,
    );
  }

  const { inviteUrl } = (await invited.json()) as { inviteUrl: string };
  // The token is the last path segment of `/invite/$token`
  // (`packages/server/src/domain/iam/invitation-mail.util.ts`), never a query parameter.
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

    if (!accepted.ok()) {
      throw new Error(
        `Could not accept the invitation for ${options.email}: HTTP ${String(accepted.status())}.\n${await explainProvisioningRefusal(accepted, 'accept')}`,
      );
    }

    const { user } = (await accepted.json()) as { user: { id: string } };

    return { userId: user.id, email: options.email };
  } finally {
    await anonymous.dispose();
  }
};

/** Offboards one account — the only removal the contract offers. Answers whether it was accepted. */
export const offboardAccount = async (owner: ApiSession, userId: string): Promise<boolean> => {
  const response = await owner.context.post(`/api/v1/users/${userId}/deactivate`, {
    headers: { ...owner.headers, 'Idempotency-Key': randomUUID() },
    data: { reason: 'end-to-end run finished' },
  });

  return response.ok();
};

/**
 * Offboards the accounts this harness created, and answers with how many.
 *
 * `q` narrows what is swept: the teardown passes nothing and reaches every marked account, and a
 * scenario proving this works passes its own address so that it sweeps exactly one — a sweep of
 * everything, run inside a `fullyParallel` suite, would offboard colleagues other scenarios are
 * still signed in as.
 *
 * Refusals are counted rather than raised. A teardown that throws turns a green run red on the way
 * out, which is the one moment at which a failure carries no information about the product.
 */
export const sweepTestAccounts = async (
  owner: ApiSession,
  options: { readonly q?: string } = {},
): Promise<{ swept: number; refused: number }> => {
  const query = new URLSearchParams({
    q: options.q ?? TEST_ACCOUNT_MARKER,
    perPage: '100',
  });

  const listed = await owner.context.get(`/api/v1/employees?${query.toString()}`, {
    headers: owner.headers,
  });

  if (!listed.ok()) {
    throw new Error(
      `Could not read the directory to sweep it: HTTP ${String(listed.status())}.\n${await listed.text()}`,
    );
  }

  const { items } = (await listed.json()) as { items: readonly DirectoryRow[] };
  const marked = items.filter((row) => row.email.includes(TEST_ACCOUNT_MARKER));

  let swept = 0;
  let refused = 0;

  for (const row of marked) {
    if (await offboardAccount(owner, row.userId)) swept += 1;
    else refused += 1;
  }

  return { swept, refused };
};
