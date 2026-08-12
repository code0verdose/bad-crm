import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { type TokenDenylistPort } from '@/application/identity/ports/token-denylist.port.js';
import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';
import {
  JwtMfaPendingTokenAdapter,
  MFA_PENDING_TOKEN_TTL_SECONDS,
} from '@/infrastructure/crypto/jwt-mfa-pending-token.adapter.js';

import { FakeClock, FakeIdGenerator } from '../../support/identity-doubles.util.js';

const SECRET = 'j'.repeat(32);

const SUBJECT = {
  userId: 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
  organizationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
};

/**
 * A `TokenDenylistPort` in memory, with the same failure seam `FakeWindowLimiter` gives the rate
 * limiter suite: set `failure` to make every call reject the way an unreachable Redis does.
 */
class FakeTokenDenylist implements TokenDenylistPort {
  readonly revoked = new Map<string, number>();
  failure: Error | undefined;

  async revoke(key: string, ttlSeconds: number): Promise<void> {
    if (this.failure !== undefined) throw this.failure;

    this.revoked.set(key, ttlSeconds);
  }

  async isRevoked(key: string): Promise<boolean> {
    if (this.failure !== undefined) throw this.failure;

    return this.revoked.has(key);
  }
}

const harness = (): {
  clock: FakeClock;
  ids: FakeIdGenerator;
  denylist: FakeTokenDenylist;
  tokens: JwtMfaPendingTokenAdapter;
} => {
  const clock = new FakeClock();
  const ids = new FakeIdGenerator();
  const denylist = new FakeTokenDenylist();
  const tokens = new JwtMfaPendingTokenAdapter(SECRET, clock, ids, denylist);

  return { clock, ids, denylist, tokens };
};

/** Builds a raw token this process could never have signed with the payload's own hand-picked claims. */
const rawToken = async (
  payload: Record<string, unknown>,
  options: {
    secret?: string;
    issuer?: string;
    audience?: string;
    sub?: string;
    jti?: string;
    ttl?: number;
  } = {},
): Promise<string> => {
  const issuedAt = Math.floor(new FakeClock().now().getTime() / 1000);

  let builder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(options.sub ?? `pending:${SUBJECT.userId}`)
    .setIssuer(options.issuer ?? 'bad-crm')
    .setAudience(options.audience ?? 'bad-crm-api')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (options.ttl ?? MFA_PENDING_TOKEN_TTL_SECONDS));

  if (options.jti !== undefined) builder = builder.setJti(options.jti);

  return builder.sign(new TextEncoder().encode(options.secret ?? SECRET));
};

describe('the mfa-pending token — issuing and verifying', () => {
  it('issues a token that verifies back to the subject, with a five-minute TTL', async () => {
    const { tokens } = harness();

    const issued = await tokens.issue(SUBJECT);

    expect(issued.expiresInSeconds).toBe(MFA_PENDING_TOKEN_TTL_SECONDS);
    expect(MFA_PENDING_TOKEN_TTL_SECONDS).toBe(5 * 60);

    await expect(tokens.verify(issued.token)).resolves.toEqual({
      userId: SUBJECT.userId,
      organizationId: SUBJECT.organizationId,
      jti: issued.jti,
      expiresAt: new Date(new FakeClock().now().getTime() + MFA_PENDING_TOKEN_TTL_SECONDS * 1000),
    });
  });

  it('stops verifying once its five minutes have passed (acceptance 4)', async () => {
    const { clock, tokens } = harness();
    const issued = await tokens.issue(SUBJECT);

    clock.advance(MFA_PENDING_TOKEN_TTL_SECONDS - 1);
    await expect(tokens.verify(issued.token)).resolves.toMatchObject({ jti: issued.jti });

    clock.advance(2);
    await expect(tokens.verify(issued.token)).resolves.toBeUndefined();
  });

  it('refuses a token signed with another secret', async () => {
    const { clock, ids, denylist } = harness();
    const foreign = new JwtMfaPendingTokenAdapter('k'.repeat(32), clock, ids, denylist);
    const issued = await foreign.issue(SUBJECT);

    await expect(
      new JwtMfaPendingTokenAdapter(SECRET, clock, ids, denylist).verify(issued.token),
    ).resolves.toBeUndefined();
  });

  it('refuses a token that is not one', async () => {
    const { tokens } = harness();

    await expect(tokens.verify('')).resolves.toBeUndefined();
    await expect(tokens.verify('not.a.token')).resolves.toBeUndefined();
  });

  it('refuses `alg: none` and a token minted for another audience', async () => {
    const { tokens } = harness();

    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({
        sub: `pending:${SUBJECT.userId}`,
        org: SUBJECT.organizationId,
        scope: 'mfa_pending',
        jti: 'forged-jti',
      }),
    ).toString('base64url')}.`;

    const foreignAudience = await rawToken(
      { org: SUBJECT.organizationId, scope: 'mfa_pending' },
      { audience: 'somebody-else', jti: 'forged-jti-2' },
    );

    await expect(tokens.verify(unsigned)).resolves.toBeUndefined();
    await expect(tokens.verify(foreignAudience)).resolves.toBeUndefined();
  });

  /**
   * The negative cases required alongside the trap named in the brief: a token can fail here for
   * missing `org`/`jti`/`exp`, or for a subject that never had the `pending:` prefix at all — none of
   * that reaches the scope branch below, because `asClaims` returns before it.
   */
  it.each([
    ['no org', { scope: 'mfa_pending' }, { jti: 'j-1' }],
    ['no jti', { org: SUBJECT.organizationId, scope: 'mfa_pending' }, {}],
    [
      'subject without the pending: prefix',
      { org: SUBJECT.organizationId, scope: 'mfa_pending' },
      { jti: 'j-2', sub: SUBJECT.userId },
    ],
    [
      'empty userId after the prefix',
      { org: SUBJECT.organizationId, scope: 'mfa_pending' },
      { jti: 'j-3', sub: 'pending:' },
    ],
  ])('refuses a well-signed token with %s', async (_case, payload, options) => {
    const { tokens } = harness();
    const token = await rawToken(payload, options);

    await expect(tokens.verify(token)).resolves.toBeUndefined();
  });

  /**
   * The scope check on its own, isolated from every other claim: `org`, `jti`, `exp` and the
   * `pending:` subject are all exactly what a genuine token would carry — the *only* thing wrong is
   * `scope`. STORY-013-03's brief calls this out by name: a token missing `sid`/`pv` already fails an
   * access-token verifier's `asClaims` before scope is ever considered, which would make rejection
   * "everywhere but /auth/2fa/verify" true by accident rather than by a scope check that actually
   * runs. This case proves the scope check runs on its own: nothing else about the token is wrong.
   */
  it('refuses a token whose only fault is the wrong scope', async () => {
    const { tokens } = harness();
    const token = await rawToken(
      { org: SUBJECT.organizationId, scope: 'not_mfa_pending' },
      { jti: 'well-formed-otherwise' },
    );

    await expect(tokens.verify(token)).resolves.toBeUndefined();
  });

  it('accepts a token with every claim right, including scope, as the control for the case above', async () => {
    const { tokens } = harness();
    const token = await rawToken(
      { org: SUBJECT.organizationId, scope: 'mfa_pending' },
      { jti: 'well-formed-control' },
    );

    await expect(tokens.verify(token)).resolves.toMatchObject({ jti: 'well-formed-control' });
  });
});

describe('the mfa-pending token — one-time use (acceptance 2)', () => {
  it('stops verifying once revoked', async () => {
    const { tokens } = harness();
    const issued = await tokens.issue(SUBJECT);

    const claims = await tokens.verify(issued.token);
    if (claims === undefined) throw new Error('unreachable: just issued');

    await tokens.revoke(claims);

    await expect(tokens.verify(issued.token)).resolves.toBeUndefined();
  });

  it('revokes for at least the remaining lifetime of the token, never less', async () => {
    const { clock, denylist, tokens } = harness();
    const issued = await tokens.issue(SUBJECT);

    clock.advance(200);
    const claims = await tokens.verify(issued.token);
    if (claims === undefined) throw new Error('unreachable: still within five minutes');

    await tokens.revoke(claims);

    const key = [...denylist.revoked.keys()].find((k) => k.includes(issued.jti));
    expect(key).toBeDefined();
    expect(denylist.revoked.get(key!)).toBe(MFA_PENDING_TOKEN_TTL_SECONDS - 200);
  });

  it('floors the TTL at one second for a token revoked past its own expiry', async () => {
    const { denylist, tokens } = harness();
    const issued = await tokens.issue(SUBJECT);

    // The claims of an already-expired token cannot come from `verify()` (it would refuse), so this
    // exercises `revoke()` directly with claims a caller could only have held from before expiry —
    // the same shape the five-failed-attempts path (a different zone) would hold if its last attempt
    // landed right at the token's own boundary.
    await tokens.revoke({ jti: issued.jti, expiresAt: new Date('2000-01-01T00:00:00.000Z') });

    const key = [...denylist.revoked.keys()].find((k) => k.includes(issued.jti));
    expect(key).toBeDefined();
    expect(denylist.revoked.get(key!)).toBe(1);
  });
});

describe('the mfa-pending token — an unreachable denylist', () => {
  /**
   * The decision this adapter documents in its class comment: an unreachable denylist must never let
   * `verify()` answer "not spent" by accident of a swallowed error. Both methods propagate.
   */
  it('lets verify reject instead of admitting a token it could not check', async () => {
    const { denylist, tokens } = harness();
    const issued = await tokens.issue(SUBJECT);

    denylist.failure = new Error('connection lost');

    await expect(tokens.verify(issued.token)).rejects.toBe(denylist.failure);
  });

  it('lets revoke reject instead of silently failing to invalidate the token', async () => {
    const { denylist, tokens } = harness();
    const issued = await tokens.issue(SUBJECT);
    const claims = await tokens.verify(issued.token);
    if (claims === undefined) throw new Error('unreachable: just issued');

    denylist.failure = new Error('connection lost');

    await expect(tokens.revoke(claims)).rejects.toBe(denylist.failure);
  });
});

/**
 * `ServiceUnavailableError` is what `RedisTokenDenylistAdapter` actually throws in production —
 * asserted at that adapter's own test. This file's `FakeTokenDenylist` throws a plain `Error` to keep
 * the two layers independent, and this one case checks that this adapter still does not catch and
 * convert whatever `TokenDenylistPort` raises.
 */
describe('the mfa-pending token — propagating a real denylist failure', () => {
  it('propagates a ServiceUnavailableError from the denylist unchanged', async () => {
    const { denylist, tokens } = harness();
    const issued = await tokens.issue(SUBJECT);

    denylist.failure = new ServiceUnavailableError({ dependency: 'redis' });

    await expect(tokens.verify(issued.token)).rejects.toBeInstanceOf(ServiceUnavailableError);
  });
});
