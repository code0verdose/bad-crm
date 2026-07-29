import { createHash, randomUUID } from 'node:crypto';

import {
  type AccessTokenClaims,
  type AccessTokenPort,
  type IssuedAccessToken,
} from '@/application/identity/ports/access-token.port.js';
import { type AddressHasherPort } from '@/application/identity/ports/address-hasher.port.js';
import {
  type AuthLookupPort,
  type AuthPasswordResetRecord,
  type AuthSessionRecord,
  type AuthUserRecord,
} from '@/application/identity/ports/auth-lookup.port.js';
import {
  type PasswordResetTokenDraft,
  type PasswordResetTokenRepositoryPort,
} from '@/application/identity/ports/password-reset-token.port.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import {
  type MintedRefreshToken,
  type RefreshTokenPort,
} from '@/application/identity/ports/refresh-token.port.js';
import {
  type MintedResetToken,
  type ResetTokenPort,
} from '@/application/identity/ports/reset-token.port.js';
import {
  type ActiveSession,
  type CreatedSession,
  type SessionAuthContext,
  type SessionDraft,
  type SessionOwnerRecord,
  type SessionRepositoryPort,
  type SessionRevokedReason,
} from '@/application/identity/ports/session-repository.port.js';
import {
  type OrganizationDraft,
  type OrganizationRepositoryPort,
  type OrganizationSummary,
} from '@/application/organization/ports/organization-repository.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';
import { type LogFields, type LoggerPort } from '@/application/platform/ports/logger.port.js';
import {
  type MailDispatchContext,
  type MailDispatchPort,
} from '@/application/platform/ports/mail-dispatch.port.js';
import {
  type MailDelivery,
  type MailFailure,
  type MailPort,
  type OutgoingMail,
} from '@/application/platform/ports/mail.port.js';
import {
  type RateLimitDecision,
  type RateLimitPolicy,
  type RateLimitPort,
  type RateLimitSubjects,
} from '@/application/platform/ports/rate-limit.port.js';
import {
  type TenantScope,
  type UnitOfWorkPort,
} from '@/application/platform/ports/unit-of-work.port.js';
import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';
import {
  type OwnerDraft,
  type UserCredentialRecord,
  type UserRecord,
  type UserRepositoryPort,
} from '@/application/identity/ports/user-repository.port.js';

/**
 * In-memory stand-ins for the identity ports.
 *
 * They exist so that the use-case suites assert *decisions* — which answer, which order, which
 * write — without a database. The properties that only a database can hold (atomic rotation under
 * concurrency, the policy, the grants) are asserted in `test/integration/db/**` against a real
 * PostgreSQL, and neither level is a substitute for the other.
 */

export const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const OTHER_ORGANIZATION_ID = '1d0f8a2b-6c34-4e51-b8aa-9f2e7c5d31b4';
export const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';

export class FakeClock implements ClockPort {
  constructor(private current = new Date('2026-07-29T10:00:00.000Z')) {}

  now(): Date {
    return this.current;
  }

  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

export class FakeIdGenerator implements IdGeneratorPort {
  readonly issued: string[] = [];

  next(): string {
    return this.record(randomUUID());
  }

  uuid(): string {
    return this.record(randomUUID());
  }

  private record(value: string): string {
    this.issued.push(value);

    return value;
  }
}

export class RecordingLogger implements LoggerPort {
  readonly lines: { level: string; fields: LogFields; message: string }[] = [];

  debug(fields: LogFields, message: string): void {
    this.lines.push({ level: 'debug', fields, message });
  }

  info(fields: LogFields, message: string): void {
    this.lines.push({ level: 'info', fields, message });
  }

  warn(fields: LogFields, message: string): void {
    this.lines.push({ level: 'warn', fields, message });
  }

  error(fields: LogFields, message: string): void {
    this.lines.push({ level: 'error', fields, message });
  }

  child(): LoggerPort {
    return this;
  }
}

/**
 * Runs the work function and records the scope, so a test can assert which tenant was opened.
 *
 * `current` is the scope in effect while the work runs — the in-memory stand-in for
 * `app.organization_id`, so a fake repository can resolve the tenant the way a real one does
 * (`tenant-scoped.repository.ts`) instead of being handed one the caller might get wrong.
 *
 * `onScopeClosed` is the seam for the one property that cannot be asserted after the fact: that
 * nothing external was called *while* a transaction was open (`rules/outbox.mdc`, rule 2).
 */
export class FakeUnitOfWork implements UnitOfWorkPort {
  readonly scopes: TenantScope[] = [];

  current: TenantScope | undefined;

  onScopeClosed: (() => void) | undefined;

  async withTenant<T>(scope: TenantScope, work: () => Promise<T>): Promise<T> {
    this.scopes.push(scope);
    this.current = scope;

    try {
      return await work();
    } finally {
      this.current = undefined;
      this.onScopeClosed?.();
    }
  }
}

/** The mail transport, in memory, with both degradations the port distinguishes. */
export class FakeMail implements MailPort {
  readonly sent: OutgoingMail[] = [];

  configured = true;

  /** Set to make every send report a transport failure, the way an unreachable relay does. */
  failure: MailFailure | undefined;

  isConfigured(): boolean {
    return this.configured;
  }

  send(mail: OutgoingMail): Promise<MailDelivery> {
    if (!this.configured) return Promise.resolve({ status: 'not_configured' });

    this.sent.push(mail);

    if (this.failure !== undefined) {
      return Promise.resolve({ status: 'failed', failure: this.failure });
    }

    return Promise.resolve({ status: 'sent', messageId: `<${this.sent.length}@example.test>` });
  }
}

/**
 * The dispatcher, recording what it was handed.
 *
 * It deliberately does **not** deliver: what a use-case suite asserts is that the message was handed
 * over, that it was handed over after the transaction closed, and what is in it. Whether a message
 * handed over actually reaches an SMTP server is the subject of the Mailpit suite.
 */
export class FakeMailDispatcher implements MailDispatchPort {
  readonly dispatched: { mail: OutgoingMail; context: MailDispatchContext }[] = [];

  dispatch(mail: OutgoingMail, context: MailDispatchContext): void {
    this.dispatched.push({ mail, context });
  }

  drain(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A hasher that records every verification.
 *
 * The recording is the point: "an unknown address still costs one verification" is a property of
 * the *call*, not of the answer, and it is what keeps the timing of the two refusals equal. A test
 * that only compared status codes would pass on an implementation that returned early.
 */
export class FakePasswordHasher implements PasswordHasherPort {
  readonly dummyHash = '$argon2id$dummy';
  readonly verified: { digest: string; password: string }[] = [];
  readonly hashed: string[] = [];
  rehashNeeded = false;

  /**
   * `journal` is shared with `FakeRateLimit`, so a test can assert the *order* of two doubles.
   *
   * Order is the whole of the argon2id rule: at 19 MiB per verification, a limiter consulted after
   * the digest has already been computed is a memory-exhaustion vector rather than a defence
   * (`docs/security/threat-model.md`, T-IAM-08). Two separate call lists cannot express "before".
   */
  constructor(private readonly journal: string[] = []) {}

  hash(password: string): Promise<string> {
    this.journal.push('password:hash');
    this.hashed.push(password);

    return Promise.resolve(`$argon2id$hashed:${password}`);
  }

  verify(digest: string, password: string): Promise<boolean> {
    this.journal.push('password:verify');
    this.verified.push({ digest, password });

    return Promise.resolve(digest === `$argon2id$hashed:${password}`);
  }

  needsRehash(): boolean {
    return this.rehashNeeded;
  }
}

export interface FakeRateLimitOptions {
  /** Shared with `FakePasswordHasher`, so a test can assert which of the two ran first. */
  readonly journal?: string[];
  /** Attempts a subject is granted per policy before the answer turns into a refusal. */
  readonly limits?: Partial<Record<RateLimitPolicy, number>>;
  readonly retryAfterSeconds?: number;
  /** Makes every `consume` raise, which is what the adapter does when Redis cannot be reached. */
  readonly unavailable?: boolean;
}

/**
 * The distributed attempt counter, in memory, with a budget that is really spent.
 *
 * A counting double rather than a stub returning a fixed decision: what the use-case suites assert
 * is that the *sixth* attempt is refused and that a success puts the budget back, and neither is
 * observable against a double that always says yes. What it deliberately does not model is the part
 * only Redis can answer — that two replicas share one budget — which is asserted against a real
 * server in `test/integration/rate-limit/shared-counter.test.ts`.
 */
export class FakeRateLimit implements RateLimitPort {
  readonly consumed: { policy: RateLimitPolicy; subject: unknown }[] = [];
  readonly cleared: { policy: RateLimitPolicy; subject: unknown }[] = [];

  private readonly counters = new Map<string, number>();

  constructor(private readonly options: FakeRateLimitOptions = {}) {}

  consume<P extends RateLimitPolicy>(
    policy: P,
    subject: RateLimitSubjects[P],
  ): Promise<RateLimitDecision> {
    this.options.journal?.push(`rate-limit:consume:${policy}`);
    this.consumed.push({ policy, subject });

    if (this.options.unavailable === true) {
      return Promise.reject(new ServiceUnavailableError({ dependency: 'redis', policy }));
    }

    const key = this.keyOf(policy, subject);
    const limit = this.options.limits?.[policy] ?? Number.POSITIVE_INFINITY;
    const used = (this.counters.get(key) ?? 0) + 1;

    this.counters.set(key, used);

    return Promise.resolve(
      used > limit
        ? { allowed: false, retryAfterSeconds: this.options.retryAfterSeconds ?? 900 }
        : { allowed: true, remaining: limit - used },
    );
  }

  reset<P extends RateLimitPolicy>(policy: P, subject: RateLimitSubjects[P]): Promise<void> {
    this.options.journal?.push(`rate-limit:reset:${policy}`);
    this.cleared.push({ policy, subject });
    this.counters.delete(this.keyOf(policy, subject));

    return Promise.resolve();
  }

  private keyOf(policy: RateLimitPolicy, subject: unknown): string {
    return `${policy}|${JSON.stringify(subject)}`;
  }
}

/**
 * Reset tokens, minted in order so a test can name the one it expects to be in a link.
 *
 * The digest is a *real* SHA-256 over a marked value rather than an encoded string: the assertion
 * that the database stores a digest and never the token is only worth making against a hash the test
 * can recompute, and a reversible encoding would let that assertion pass on an implementation that
 * stored the token itself.
 */
export class FakeResetTokens implements ResetTokenPort {
  readonly minted: string[] = [];

  private counter = 0;

  mint(): MintedResetToken {
    this.counter += 1;
    const token = `reset-token-${this.counter}-${randomUUID()}`;

    this.minted.push(token);

    return { token, hash: this.hash(token) };
  }

  hash(token: string): Uint8Array {
    return createHash('sha256').update(`fake-reset:${token}`).digest();
  }
}

export interface StoredResetToken {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly tokenHash: Uint8Array;
  readonly expiresAt: Date;
  usedAt: Date | null;
}

/**
 * Reset-token rows, spent the way the real statement spends them.
 *
 * `consume` reproduces `UPDATE … WHERE id = $1 AND used_at IS NULL AND expires_at > $2 RETURNING
 * user_id` — including that a second call answers `null` rather than throwing, which is what the
 * "two clicks on one link" assertion leans on. The organization comes from the scope the unit of
 * work has open, exactly as `TenantScopedRepository` reads it from `app.organization_id`: a
 * constructor argument here would be a second source of truth for the tenant, which is the defect
 * the real base class exists to remove.
 */
export class FakePasswordResetTokens implements PasswordResetTokenRepositoryPort {
  readonly rows = new Map<string, StoredResetToken>();

  /**
   * `journal` is the same list `FakePasswordHasher` and `FakeRateLimit` write to.
   *
   * It is here because the order of *these two* is the whole of the confirm path: a digest computed
   * before the row is spent is a digest a replayed link can force again and again, and no assertion
   * about the two call lists separately can express "after".
   */
  constructor(
    private readonly unitOfWork: FakeUnitOfWork,
    private readonly journal: string[] = [],
  ) {}

  create(draft: PasswordResetTokenDraft): Promise<string> {
    const scope = this.unitOfWork.current;

    if (scope === undefined)
      throw new Error('FakePasswordResetTokens.create outside a tenant scope');

    const id = randomUUID();

    this.rows.set(id, {
      id,
      organizationId: scope.organizationId,
      userId: draft.userId,
      tokenHash: draft.tokenHash,
      expiresAt: draft.expiresAt,
      usedAt: null,
    });

    return Promise.resolve(id);
  }

  consume(tokenId: string, now: Date): Promise<string | null> {
    this.journal.push('reset-token:consume');

    const row = this.rows.get(tokenId);

    if (row === undefined || row.usedAt !== null || row.expiresAt.getTime() <= now.getTime()) {
      return Promise.resolve(null);
    }

    row.usedAt = now;

    return Promise.resolve(row.userId);
  }

  invalidateOutstanding(userId: string, at: Date): Promise<number> {
    const live = [...this.rows.values()].filter(
      (row) => row.userId === userId && row.usedAt === null,
    );

    for (const row of live) row.usedAt = at;

    return Promise.resolve(live.length);
  }

  deleteSettled(userId: string, now: Date): Promise<number> {
    const settled = [...this.rows.values()].filter(
      (row) =>
        row.userId === userId && (row.usedAt !== null || row.expiresAt.getTime() <= now.getTime()),
    );

    for (const row of settled) this.rows.delete(row.id);

    return Promise.resolve(settled.length);
  }
}

export class FakeRefreshTokens implements RefreshTokenPort {
  private counter = 0;

  mint(): MintedRefreshToken {
    this.counter += 1;
    const token = `refresh-${this.counter}`;

    return { token, hash: this.hash(token) };
  }

  hash(token: string): Uint8Array {
    return new TextEncoder().encode(`sha256:${token}`);
  }
}

export class FakeAccessTokens implements AccessTokenPort {
  readonly issued: AccessTokenClaims[] = [];

  issue(claims: AccessTokenClaims): Promise<IssuedAccessToken> {
    this.issued.push(claims);

    // `.` and not `:` — a real JWT is three base64url segments joined by dots, and
    // `readBearerToken` accepts exactly that alphabet. A double that used a character the parser
    // rejects would make every authenticated request in the HTTP suites a 401 for the wrong reason.
    return Promise.resolve({
      token: `access.${claims.sessionId}`,
      expiresInSeconds: 900,
    });
  }

  verify(token: string): Promise<AccessTokenClaims | undefined> {
    const sessionId = token.startsWith('access.') ? token.slice('access.'.length) : undefined;
    // The newest claims for that session win, so a test can push a deliberately mismatched pairing
    // over one this double issued earlier.
    const claims = this.issued.findLast((candidate) => candidate.sessionId === sessionId);

    return Promise.resolve(claims);
  }
}

export class FakeAddressHasher implements AddressHasherPort {
  hash(address: string | undefined): string {
    return `hmac:${address ?? ''}`;
  }
}

export class FakeOrganizations implements OrganizationRepositoryPort {
  constructor(
    private organization: OrganizationSummary | null = {
      id: ORGANIZATION_ID,
      slug: 'bad-company',
      name: 'Bad Company',
      timezone: 'UTC',
      defaultCurrency: 'USD',
    },
  ) {}

  create(draft: OrganizationDraft): Promise<OrganizationSummary> {
    this.organization = { id: ORGANIZATION_ID, ...draft };

    return Promise.resolve(this.organization);
  }

  findCurrent(): Promise<OrganizationSummary | null> {
    return Promise.resolve(this.organization);
  }

  forget(): void {
    this.organization = null;
  }
}

export class FakeUsers implements UserRepositoryPort {
  readonly rows = new Map<string, UserRecord>();
  /** The digests, kept apart from `rows` exactly as the repository keeps them out of `UserRecord`. */
  readonly credentials = new Map<string, UserCredentialRecord>();
  readonly rehashed: { userId: string; passwordHash: string }[] = [];
  createdOwner: OwnerDraft | undefined;

  constructor(seed: readonly UserRecord[] = []) {
    for (const row of seed) this.rows.set(row.id, row);
  }

  createOwner(draft: OwnerDraft): Promise<string> {
    this.createdOwner = draft;
    this.rows.set(USER_ID, {
      id: USER_ID,
      email: draft.email,
      locale: draft.locale,
      timezone: draft.timezone,
      status: 'ACTIVE',
      permissionsVersion: 1,
    });

    return Promise.resolve(USER_ID);
  }

  findById(userId: string): Promise<UserRecord | null> {
    return Promise.resolve(this.rows.get(userId) ?? null);
  }

  findCredential(userId: string): Promise<UserCredentialRecord | null> {
    return Promise.resolve(this.credentials.get(userId) ?? null);
  }

  /**
   * Answers `false` when no row matched, exactly as `updateMany` reports a zero count.
   *
   * `vanished` is how a test reaches the one state the real statement can be in and this map cannot
   * reach on its own: the account was soft-deleted between the read that found it and the write that
   * follows. It is a state no fixture can set up by deleting from `rows`, because the callers read
   * the account through `findCredential` or `findById` first.
   */
  vanished = false;

  updatePasswordHash(userId: string, passwordHash: string): Promise<boolean> {
    if (this.vanished) return Promise.resolve(false);

    this.rehashed.push({ userId, passwordHash });

    const credential = this.credentials.get(userId);

    if (credential !== undefined) this.credentials.set(userId, { ...credential, passwordHash });

    return Promise.resolve(this.rows.has(userId) || credential !== undefined);
  }
}

interface StoredSession extends SessionDraft {
  readonly id: string;
  readonly createdAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevokedReason | null;
}

/**
 * Sessions in a map, with `markRotated` written as the one-shot the port promises: a second call
 * for the same row answers `false`, which is what the real `UPDATE ... WHERE revoked_at IS NULL`
 * does and what the race test leans on.
 */
export class FakeSessions implements SessionRepositoryPort {
  readonly rows = new Map<string, StoredSession>();

  private counter = 0;

  constructor(
    private readonly clock: ClockPort,
    private readonly userStatus: () => { status: string; permissionsVersion: number } = () => ({
      status: 'ACTIVE',
      permissionsVersion: 1,
    }),
  ) {}

  /** Set to make the next `create` report a colliding refresh digest, as the real one can. */
  collisionsToSimulate = 0;

  create(draft: SessionDraft): Promise<CreatedSession | null> {
    if (this.collisionsToSimulate > 0) {
      this.collisionsToSimulate -= 1;

      return Promise.resolve(null);
    }

    this.counter += 1;
    // A uuid, like the column: `sessionIdParamsSchema` rejects anything else, so a readable
    // placeholder here would make `DELETE /auth/sessions/{id}` a 422 in every HTTP suite.
    const id = randomUUID();
    const createdAt = this.clock.now();

    this.rows.set(id, { ...draft, id, createdAt, revokedAt: null, revokedReason: null });

    return Promise.resolve({ id, createdAt });
  }

  markRotated(sessionId: string, at: Date): Promise<boolean> {
    return Promise.resolve(this.revokeRow(sessionId, 'ROTATED', at));
  }

  revoke(sessionId: string, reason: SessionRevokedReason, at: Date): Promise<boolean> {
    return Promise.resolve(this.revokeRow(sessionId, reason, at));
  }

  revokeFamily(familyId: string, reason: SessionRevokedReason, at: Date): Promise<number> {
    const live = [...this.rows.values()].filter(
      (row) => row.familyId === familyId && row.revokedAt === null,
    );

    for (const row of live) this.revokeRow(row.id, reason, at);

    return Promise.resolve(live.length);
  }

  revokeAllFamilies(userId: string, reason: SessionRevokedReason, at: Date): Promise<number> {
    const families = new Set(
      [...this.rows.values()]
        .filter((row) => row.userId === userId && row.revokedAt === null)
        .map((row) => row.familyId),
    );

    for (const family of families) void this.revokeFamily(family, reason, at);

    return Promise.resolve(families.size);
  }

  revokeOtherFamilies(
    userId: string,
    keepFamilyId: string,
    reason: SessionRevokedReason,
    at: Date,
  ): Promise<number> {
    const families = new Set(
      [...this.rows.values()]
        .filter(
          (row) => row.userId === userId && row.revokedAt === null && row.familyId !== keepFamilyId,
        )
        .map((row) => row.familyId),
    );

    for (const family of families) void this.revokeFamily(family, reason, at);

    return Promise.resolve(families.size);
  }

  findOwner(sessionId: string): Promise<SessionOwnerRecord | null> {
    const row = this.rows.get(sessionId);

    return Promise.resolve(
      row === undefined ? null : { id: row.id, userId: row.userId, familyId: row.familyId },
    );
  }

  findAuthContext(sessionId: string): Promise<SessionAuthContext | null> {
    const row = this.rows.get(sessionId);

    if (row === undefined) return Promise.resolve(null);

    const user = this.userStatus();

    return Promise.resolve({
      sessionId: row.id,
      userId: row.userId,
      familyId: row.familyId,
      revokedAt: row.revokedAt,
      expiresAt: row.expiresAt,
      userStatus: user.status,
      permissionsVersion: user.permissionsVersion,
    });
  }

  listActive(userId: string, now: Date): Promise<readonly ActiveSession[]> {
    const live = [...this.rows.values()].filter(
      (row) => row.userId === userId && row.revokedAt === null && row.expiresAt > now,
    );

    return Promise.resolve(
      live.map((row) => ({
        id: row.id,
        familyId: row.familyId,
        startedAt: this.familyStart(row.familyId),
        lastUsedAt: row.createdAt,
        expiresAt: row.expiresAt,
        userAgent: row.userAgent,
        ipMasked: row.ipMasked,
      })),
    );
  }

  private familyStart(familyId: string): Date {
    const times = [...this.rows.values()]
      .filter((row) => row.familyId === familyId)
      .map((row) => row.createdAt.getTime());

    return new Date(Math.min(...times));
  }

  private revokeRow(sessionId: string, reason: SessionRevokedReason, at: Date): boolean {
    const row = this.rows.get(sessionId);

    if (row === undefined || row.revokedAt !== null) return false;

    row.revokedAt = at;
    row.revokedReason = reason;

    return true;
  }
}

export const authUser = (overrides: Partial<AuthUserRecord> = {}): AuthUserRecord => ({
  userId: USER_ID,
  email: 'ada@example.com',
  locale: 'en',
  timezone: 'Europe/Berlin',
  organizationId: ORGANIZATION_ID,
  organizationName: 'Bad Company',
  organizationSlug: 'bad-company',
  passwordHash: '$argon2id$hashed:correct-horse-battery',
  status: 'ACTIVE',
  permissionsVersion: 1,
  ...overrides,
});

/**
 * The `app_auth` surface.
 *
 * Sessions are read back out of `FakeSessions` rather than kept in a second list, which is what the
 * real path does too: the `SECURITY DEFINER` function reads the same `sessions` rows the repository
 * writes. A separate list would let a test rotate a session and still resolve the old state, and the
 * reuse-detection assertions would then be about the double instead of about the use-case.
 */
export class FakeAuthLookup implements AuthLookupPort {
  private store: FakeSessions | undefined;

  private accounts: FakeUsers | undefined;

  private resetTokens: FakePasswordResetTokens | undefined;

  constructor(public users: AuthUserRecord[] = []) {}

  /** Point the lookup at the repository whose rows it resolves. */
  reading(store: FakeSessions): this {
    this.store = store;

    return this;
  }

  /**
   * Read the digest out of the account rows rather than out of the seed.
   *
   * The real resolver selects `users.password_hash` — the same column `updatePasswordHash` writes —
   * so a change of password is visible to the very next sign-in. Two copies here would let a suite
   * change a password and still sign in with the old one, and the assertion that matters most in
   * STORY-006-06 and STORY-006-08 would be asserting the double.
   */
  readingCredentials(accounts: FakeUsers): this {
    this.accounts = accounts;

    return this;
  }

  findUsersByEmail(email: string): Promise<readonly AuthUserRecord[]> {
    return Promise.resolve(
      this.users.filter((user) => user.email === email).map((user) => this.withDigest(user)),
    );
  }

  findUserByEmailAndSlug(email: string, organizationSlug: string): Promise<AuthUserRecord | null> {
    const user = this.users.find(
      (candidate) => candidate.email === email && candidate.organizationSlug === organizationSlug,
    );

    return Promise.resolve(user === undefined ? null : this.withDigest(user));
  }

  private withDigest(user: AuthUserRecord): AuthUserRecord {
    const stored = this.accounts?.credentials.get(user.userId);

    return stored === undefined ? user : { ...user, passwordHash: stored.passwordHash };
  }

  /**
   * Resolve reset tokens out of the repository that wrote them — the same reason sessions are read
   * back out of `FakeSessions`: the real resolver reads the very rows `create` inserted, and a
   * second list here would let a suite spend a token the table no longer considers live.
   */
  readingResetTokens(store: FakePasswordResetTokens): this {
    this.resetTokens = store;

    return this;
  }

  findPasswordResetToken(tokenHash: Uint8Array): Promise<AuthPasswordResetRecord | null> {
    const wanted = Buffer.from(tokenHash).toString('hex');
    const row = [...(this.resetTokens?.rows.values() ?? [])].find(
      (candidate) => Buffer.from(candidate.tokenHash).toString('hex') === wanted,
    );

    return Promise.resolve(
      row === undefined
        ? null
        : { tokenId: row.id, organizationId: row.organizationId, userId: row.userId },
    );
  }

  findSessionByRefreshHash(refreshTokenHash: Uint8Array): Promise<AuthSessionRecord | null> {
    const wanted = new TextDecoder().decode(refreshTokenHash);
    const row = [...(this.store?.rows.values() ?? [])].find(
      (candidate) => new TextDecoder().decode(candidate.refreshTokenHash) === wanted,
    );

    if (row === undefined) return Promise.resolve(null);

    return Promise.resolve({
      sessionId: row.id,
      userId: row.userId,
      organizationId: ORGANIZATION_ID,
      familyId: row.familyId,
      revokedAt: row.revokedAt,
      revokedReason: row.revokedReason,
      expiresAt: row.expiresAt,
    });
  }
}
