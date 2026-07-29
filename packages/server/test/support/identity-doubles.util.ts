import { randomUUID } from 'node:crypto';

import {
  type AccessTokenClaims,
  type AccessTokenPort,
  type IssuedAccessToken,
} from '@/application/identity/ports/access-token.port.js';
import { type AddressHasherPort } from '@/application/identity/ports/address-hasher.port.js';
import {
  type AuthLookupPort,
  type AuthSessionRecord,
  type AuthUserRecord,
} from '@/application/identity/ports/auth-lookup.port.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import {
  type MintedRefreshToken,
  type RefreshTokenPort,
} from '@/application/identity/ports/refresh-token.port.js';
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

/** Runs the work function and records the scope, so a test can assert which tenant was opened. */
export class FakeUnitOfWork implements UnitOfWorkPort {
  readonly scopes: TenantScope[] = [];

  withTenant<T>(scope: TenantScope, work: () => Promise<T>): Promise<T> {
    this.scopes.push(scope);

    return work();
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

  updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    this.rehashed.push({ userId, passwordHash });

    return Promise.resolve();
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

  constructor(public users: AuthUserRecord[] = []) {}

  /** Point the lookup at the repository whose rows it resolves. */
  reading(store: FakeSessions): this {
    this.store = store;

    return this;
  }

  findUsersByEmail(email: string): Promise<readonly AuthUserRecord[]> {
    return Promise.resolve(this.users.filter((user) => user.email === email));
  }

  findUserByEmailAndSlug(email: string, organizationSlug: string): Promise<AuthUserRecord | null> {
    return Promise.resolve(
      this.users.find(
        (user) => user.email === email && user.organizationSlug === organizationSlug,
      ) ?? null,
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
