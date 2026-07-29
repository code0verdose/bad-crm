import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RequestPasswordResetUseCase } from '@/application/identity/use-cases/request-password-reset.use-case.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { MailNotConfiguredError, RateLimitedError } from '@/domain/shared/errors/app.errors.js';

import {
  authUser,
  FakeAddressHasher,
  FakeAuthLookup,
  FakeClock,
  FakeMail,
  FakeMailDispatcher,
  FakePasswordResetTokens,
  FakeRateLimit,
  type FakeRateLimitOptions,
  FakeResetTokens,
  FakeUnitOfWork,
  ORGANIZATION_ID,
  OTHER_ORGANIZATION_ID,
  RecordingLogger,
  USER_ID,
} from '../../support/identity-doubles.util.js';

/**
 * Asking for a reset link — the operation whose whole design is that its answer carries no
 * information.
 *
 * A registered address and one nobody has produce the same status, the same (empty) body and the
 * same work: no lookup happens before the limiter, nothing is awaited that only one branch does, and
 * the mail is *handed over* rather than sent, so the response does not wait for a relay. Every test
 * below exists to keep one of those true.
 */

const APP_URL = 'https://crm.example.com';
const KNOWN = 'ada@example.com';
const UNKNOWN = 'nobody@example.com';
const OTHER_ACCOUNT = 'e2f7a3d9-11c4-4f83-9a5e-6b0d2c8f4a17';

interface Harness {
  readonly useCase: RequestPasswordResetUseCase;
  readonly tokens: FakePasswordResetTokens;
  readonly resetTokens: FakeResetTokens;
  readonly mail: FakeMail;
  readonly dispatcher: FakeMailDispatcher;
  readonly rateLimit: FakeRateLimit;
  readonly logger: RecordingLogger;
  readonly unitOfWork: FakeUnitOfWork;
  readonly journal: string[];
  readonly clock: FakeClock;
}

const buildHarness = (
  options: {
    readonly accounts?: ReturnType<typeof authUser>[];
    readonly rateLimit?: FakeRateLimitOptions;
  } = {},
): Harness => {
  const clock = new FakeClock();
  const journal: string[] = [];
  const unitOfWork = new FakeUnitOfWork();
  const tokens = new FakePasswordResetTokens(unitOfWork);
  const lookup = new FakeAuthLookup(options.accounts ?? [authUser()]);
  const resetTokens = new FakeResetTokens();
  const mail = new FakeMail();
  const dispatcher = new FakeMailDispatcher();
  const rateLimit = new FakeRateLimit({ journal, ...(options.rateLimit ?? {}) });
  const logger = new RecordingLogger();

  return {
    useCase: new RequestPasswordResetUseCase(
      lookup,
      tokens,
      resetTokens,
      new FakeAddressHasher(),
      unitOfWork,
      rateLimit,
      mail,
      dispatcher,
      clock,
      logger,
      APP_URL,
    ),
    tokens,
    resetTokens,
    mail,
    dispatcher,
    rateLimit,
    logger,
    unitOfWork,
    journal,
    clock,
  };
};

const ask = (harness: Harness, email: string): Promise<void> =>
  harness.useCase.execute({
    email,
    client: { userAgent: 'suite', ipAddress: '203.0.113.7' },
  });

describe('asking for a reset link', () => {
  it('stores one token for the account and hands one message over', async () => {
    const harness = buildHarness();

    await ask(harness, KNOWN);

    expect([...harness.tokens.rows.values()]).toMatchObject([
      { organizationId: ORGANIZATION_ID, userId: USER_ID, usedAt: null },
    ]);
    expect(harness.dispatcher.dispatched).toHaveLength(1);
    expect(harness.dispatcher.dispatched[0]?.mail.to).toBe(KNOWN);
  });

  /**
   * The database holds a digest, never the value in the link. A row that stored the token itself
   * would make a read of the table — a backup, a log of a slow query, an SQL injection — a set of
   * live password resets for every account that asked for one.
   */
  it('stores only the SHA-256 of the token, never the token itself', async () => {
    const harness = buildHarness();

    await ask(harness, KNOWN);

    const token = harness.resetTokens.minted[0] ?? '';
    const row = [...harness.tokens.rows.values()][0];

    expect(token).not.toBe('');
    expect(Buffer.from(row?.tokenHash ?? new Uint8Array()).toString('hex')).toBe(
      createHash('sha256').update(`fake-reset:${token}`).digest('hex'),
    );
    expect(JSON.stringify([...harness.tokens.rows.values()])).not.toContain(token);
  });

  it('puts the token in the link of the message and in no other field', async () => {
    const harness = buildHarness();

    await ask(harness, KNOWN);

    const token = harness.resetTokens.minted[0] ?? '';
    const dispatched = harness.dispatcher.dispatched[0];

    expect(dispatched?.mail.text).toContain(`${APP_URL}/reset-password/${token}`);
    expect(dispatched?.mail.html).toContain(`${APP_URL}/reset-password/${token}`);
    expect(dispatched?.mail.subject).not.toContain(token);
  });

  /**
   * Thirty minutes, and the number comes from `docs/security/threat-model.md` T-IAM-07 rather than
   * from convenience. It was 60 here and in `data-model.md` while the threat model said 30 — a
   * conflict inside `docs/`, which `CLAUDE.md` says is escalated rather than settled quietly; it was
   * escalated and settled at 30. The window matters because it is exactly how long a token that
   * reached a proxy access log stays usable, and that leak was live until this same change set
   * turned `Referrer-Policy` into `no-referrer`.
   */
  it('gives the token half an hour to live', async () => {
    const harness = buildHarness();

    await ask(harness, KNOWN);

    const row = [...harness.tokens.rows.values()][0];

    expect(row?.expiresAt.toISOString()).toBe('2026-07-29T10:30:00.000Z');
  });

  /**
   * One message per account, because the address is the identity and an installation may hold the
   * same address in two organizations. Asking the caller which one they meant would require them to
   * know, and answering "wrong organization" would say where they do not have an account.
   */
  it('issues one token and one message per organization the address has an account in', async () => {
    const harness = buildHarness({
      accounts: [
        authUser(),
        authUser({
          userId: OTHER_ACCOUNT,
          organizationId: OTHER_ORGANIZATION_ID,
          organizationSlug: 'side-project',
          organizationName: 'Side Project',
        }),
      ],
    });

    await ask(harness, KNOWN);

    expect([...harness.tokens.rows.values()].map((row) => row.organizationId).sort()).toEqual(
      [ORGANIZATION_ID, OTHER_ORGANIZATION_ID].sort(),
    );
    expect(harness.dispatcher.dispatched).toHaveLength(2);
    expect(new Set(harness.resetTokens.minted).size).toBe(2);
  });

  it('writes each token inside the tenant scope of its own organization', async () => {
    const harness = buildHarness({
      accounts: [
        authUser(),
        authUser({
          userId: OTHER_ACCOUNT,
          organizationId: OTHER_ORGANIZATION_ID,
          organizationSlug: 'side-project',
        }),
      ],
    });

    await ask(harness, KNOWN);

    expect(harness.unitOfWork.scopes).toEqual([
      { organizationId: ORGANIZATION_ID, userId: USER_ID },
      { organizationId: OTHER_ORGANIZATION_ID, userId: OTHER_ACCOUNT },
    ]);
  });

  it('does not issue a token for an account that may not sign in', async () => {
    const harness = buildHarness({ accounts: [authUser({ status: 'SUSPENDED' })] });

    await ask(harness, KNOWN);

    expect([...harness.tokens.rows.values()]).toEqual([]);
    expect(harness.dispatcher.dispatched).toEqual([]);
  });
});

describe('the answer does not say whether the address exists', () => {
  it('resolves for an unknown address exactly as it does for a known one', async () => {
    const harness = buildHarness();

    await expect(ask(harness, UNKNOWN)).resolves.toBeUndefined();
    await expect(ask(harness, KNOWN)).resolves.toBeUndefined();
  });

  it('writes nothing and hands nothing over for an address nobody has', async () => {
    const harness = buildHarness();

    await ask(harness, UNKNOWN);

    expect([...harness.tokens.rows.values()]).toEqual([]);
    expect(harness.dispatcher.dispatched).toEqual([]);
  });

  /**
   * The timing half, which is the half a status code cannot express.
   *
   * The message is *handed over* and not sent, so the branch that has an account to write to does
   * not additionally wait for an SMTP round trip while the branch that has none returns at once.
   * Asserted as "the transport was never called during the operation" — the property that makes the
   * two branches differ by one insert rather than by a network conversation.
   */
  it('never waits for the transport, so the two branches differ by an insert and not by a relay', async () => {
    const harness = buildHarness();

    await ask(harness, KNOWN);

    expect(harness.mail.sent).toEqual([]);
    expect(harness.dispatcher.dispatched).toHaveLength(1);
  });

  /**
   * **The 503 is decided before the address is resolved.** Raised after the lookup it would say
   * "this address exists, the mail just did not leave" — the enumeration oracle the constant 202
   * exists to avoid, reintroduced through the error path (`docs/api/openapi.yaml`).
   */
  it('refuses an installation without a transport identically for both addresses', async () => {
    const harness = buildHarness();

    harness.mail.configured = false;

    await expect(ask(harness, KNOWN)).rejects.toBeInstanceOf(MailNotConfiguredError);
    await expect(ask(harness, UNKNOWN)).rejects.toBeInstanceOf(MailNotConfiguredError);
    expect(harness.rateLimit.consumed).toEqual([]);
  });

  it('records the request for both, so the log is not an oracle either', async () => {
    const harness = buildHarness();

    await ask(harness, KNOWN);
    await ask(harness, UNKNOWN);

    const lines = harness.logger.lines.filter(
      (entry) => entry.fields['event'] === SECURITY_EVENTS.passwordResetRequested,
    );

    expect(lines).toHaveLength(2);
    expect(lines.map((entry) => entry.fields['accounts'])).toEqual([1, 0]);
    expect(JSON.stringify(lines)).not.toContain(KNOWN);
    expect(JSON.stringify(lines)).not.toContain(UNKNOWN);
    expect(lines[0]?.fields['ipMasked']).toBe('203.0.113.0/24');
  });

  it('never writes the token into a log line', async () => {
    const harness = buildHarness();

    await ask(harness, KNOWN);

    expect(JSON.stringify(harness.logger.lines)).not.toContain(
      harness.resetTokens.minted[0] ?? 'no-token-was-minted',
    );
  });
});

describe('the budget', () => {
  it('is spent before the address is resolved', async () => {
    const harness = buildHarness();

    await ask(harness, KNOWN);

    expect(harness.rateLimit.consumed).toEqual([
      { policy: 'auth_attempt', subject: { ipAddress: '203.0.113.7', email: KNOWN } },
    ]);
  });

  it('refuses over the limit without saying whether the address exists', async () => {
    const harness = buildHarness({ rateLimit: { limits: { auth_attempt: 1 } } });

    await ask(harness, UNKNOWN);

    await expect(ask(harness, UNKNOWN)).rejects.toBeInstanceOf(RateLimitedError);
  });

  /**
   * A successful request does **not** clear the counter. It would otherwise be the one operation on
   * the installation that pays for its own repetition: a script asking for a reset every second for
   * one address would keep resetting its own budget and keep the mailbox full.
   */
  it('is not cleared by a request that succeeded', async () => {
    const harness = buildHarness();

    await ask(harness, KNOWN);

    expect(harness.rateLimit.cleared).toEqual([]);
  });
});

/**
 * The table this operation writes to is the only one in the schema nothing ever deleted from, and
 * every row in it is the digest of a credential that was mailed to somebody. There is no scheduler
 * to sweep it with yet — no `outbox_event`, no BullMQ worker (ADR-0021) — so the settled rows of the
 * account are removed inside the transaction that is already writing a new one for it.
 *
 * It is hygiene and not the control: a stale link is harmless because `consume` refuses it, and
 * because that refusal is reached before anything expensive happens
 * (`confirm-password-reset.use-case.ts`). What this bounds is the size of the table.
 */
describe('the rows the account already had', () => {
  const spent = (harness: Harness): unknown[] =>
    [...harness.tokens.rows.values()].filter((row) => row.usedAt !== null);

  it('removes the spent ones, and keeps the one it just wrote', async () => {
    const harness = buildHarness();

    await ask(harness, KNOWN);

    const first = [...harness.tokens.rows.keys()][0] ?? '';

    await harness.unitOfWork.withTenant({ organizationId: ORGANIZATION_ID, userId: USER_ID }, () =>
      harness.tokens.consume(first, harness.clock.now()),
    );

    await ask(harness, KNOWN);

    expect(spent(harness)).toEqual([]);
    expect([...harness.tokens.rows.values()]).toHaveLength(1);
  });

  it('removes the ones nobody ever clicked, once their half hour is up', async () => {
    const harness = buildHarness();

    await ask(harness, KNOWN);
    harness.clock.advance(31 * 60);
    await ask(harness, KNOWN);

    expect([...harness.tokens.rows.values()]).toHaveLength(1);
    expect([...harness.tokens.rows.values()][0]?.expiresAt.toISOString()).toBe(
      '2026-07-29T11:01:00.000Z',
    );
  });

  it('leaves a live one alone: two links can be outstanding at once', async () => {
    const harness = buildHarness();

    await ask(harness, KNOWN);
    await ask(harness, KNOWN);

    expect([...harness.tokens.rows.values()]).toHaveLength(2);
  });
});

/**
 * A request with no address to record — over a unix socket, or behind a proxy that stripped it.
 * `requested_ip_hash` is nullable for exactly this, and the alternative would be storing a digest of
 * the empty string, which reads like an address and is not one.
 */
describe('a request whose source address cannot be read', () => {
  it('writes the row with no address digest at all', async () => {
    const harness = buildHarness();

    await harness.useCase.execute({
      email: KNOWN,
      client: { userAgent: 'suite', ipAddress: undefined },
    });

    expect([...harness.tokens.rows.values()]).toHaveLength(1);
    expect(harness.dispatcher.dispatched).toHaveLength(1);
  });
});
