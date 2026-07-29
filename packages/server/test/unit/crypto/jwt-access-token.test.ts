import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  JwtAccessTokenAdapter,
} from '@/infrastructure/crypto/jwt-access-token.adapter.js';

const SECRET = 'j'.repeat(32);

const claims = {
  userId: 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
  organizationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  sessionId: '4f1c2f4a-0a6d-4a7b-9a1e-2d3c4b5a6f70',
  permissionsVersion: 3,
};

/** A clock the test moves, so expiry is asserted rather than waited for. */
const fixedClock = (start: Date): { now: () => Date; advance: (seconds: number) => void } => {
  let current = start;

  return {
    now: () => current,
    advance: (seconds) => {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
};

const at = (): Date => new Date('2026-07-29T10:00:00.000Z');

describe('the access token', () => {
  it('carries sub, org, sid and pv, and expires in fifteen minutes', async () => {
    const clock = fixedClock(at());
    const tokens = new JwtAccessTokenAdapter(SECRET, clock);

    const issued = await tokens.issue(claims);

    expect(issued.expiresInSeconds).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
    await expect(tokens.verify(issued.token)).resolves.toEqual(claims);
  });

  it('stops verifying once its lifetime has passed', async () => {
    const clock = fixedClock(at());
    const tokens = new JwtAccessTokenAdapter(SECRET, clock);
    const issued = await tokens.issue(claims);

    clock.advance(ACCESS_TOKEN_TTL_SECONDS - 1);
    await expect(tokens.verify(issued.token)).resolves.toEqual(claims);

    clock.advance(2);
    await expect(tokens.verify(issued.token)).resolves.toBeUndefined();
  });

  it('refuses a token signed with another secret', async () => {
    const clock = fixedClock(at());
    const issued = await new JwtAccessTokenAdapter('k'.repeat(32), clock).issue(claims);

    await expect(
      new JwtAccessTokenAdapter(SECRET, clock).verify(issued.token),
    ).resolves.toBeUndefined();
  });

  it('refuses a token that is not one', async () => {
    const tokens = new JwtAccessTokenAdapter(SECRET, fixedClock(at()));

    await expect(tokens.verify('')).resolves.toBeUndefined();
    await expect(tokens.verify('not.a.token')).resolves.toBeUndefined();
  });

  /**
   * The two forgeries a JWT verifier is actually attacked with. Both are refused because the
   * algorithm and the audience are stated by the verifier rather than read out of the token.
   */
  it('refuses `alg: none` and a token minted for another audience', async () => {
    const clock = fixedClock(at());
    const tokens = new JwtAccessTokenAdapter(SECRET, clock);
    const secret = new TextEncoder().encode(SECRET);
    const issuedAt = Math.floor(clock.now().getTime() / 1000);

    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({
        sub: claims.userId,
        org: claims.organizationId,
        sid: claims.sessionId,
        pv: 1,
      }),
    ).toString('base64url')}.`;

    const foreignAudience = await new SignJWT({
      org: claims.organizationId,
      sid: claims.sessionId,
      pv: 1,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer('bad-crm')
      .setAudience('somebody-else')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 900)
      .sign(secret);

    await expect(tokens.verify(unsigned)).resolves.toBeUndefined();
    await expect(tokens.verify(foreignAudience)).resolves.toBeUndefined();
  });

  /**
   * A correctly signed token whose payload is missing a claim the authorization layer needs. It
   * cannot arrive from this process, and it is exactly what a partially rolled-back deployment or a
   * hand-written token looks like — the answer is "no claims", not a partially filled context.
   */
  it.each([
    ['no pv', { org: claims.organizationId, sid: claims.sessionId }],
    ['a fractional pv', { org: claims.organizationId, sid: claims.sessionId, pv: 1.5 }],
    ['no sid', { org: claims.organizationId, pv: 1 }],
    ['no org', { sid: claims.sessionId, pv: 1 }],
  ])('refuses a well-signed token with %s', async (_case, payload) => {
    const clock = fixedClock(at());
    const issuedAt = Math.floor(clock.now().getTime() / 1000);

    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer('bad-crm')
      .setAudience('bad-crm-api')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 900)
      .sign(new TextEncoder().encode(SECRET));

    await expect(new JwtAccessTokenAdapter(SECRET, clock).verify(token)).resolves.toBeUndefined();
  });
});
