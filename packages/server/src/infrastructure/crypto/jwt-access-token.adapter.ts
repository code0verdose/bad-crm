import { jwtVerify, SignJWT } from 'jose';

import {
  type AccessTokenClaims,
  type AccessTokenPort,
  type IssuedAccessToken,
} from '@/application/identity/ports/access-token.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';

/** Fifteen minutes, the value the contract publishes and the client's refresh timer is built on. */
export const ACCESS_TOKEN_TTL_SECONDS = 900;

/**
 * The one algorithm this installation signs and accepts.
 *
 * Pinned in *both* directions. Verification that reads the algorithm out of the token it is
 * verifying is the classic JWT failure: a token arriving with `alg: none` or with `alg: RS256` and a
 * public key as the HMAC secret verifies against a check that trusted the header. `jose` requires
 * the list to be stated, which is why it is used rather than hand-rolled.
 */
const ALGORITHM = 'HS256';

const ISSUER = 'bad-crm';
const AUDIENCE = 'bad-crm-api';

interface RawClaims {
  readonly sub?: unknown;
  readonly org?: unknown;
  readonly sid?: unknown;
  readonly pv?: unknown;
}

const asClaims = (payload: RawClaims): AccessTokenClaims | undefined => {
  const { sub, org, sid, pv } = payload;

  if (typeof sub !== 'string' || typeof org !== 'string' || typeof sid !== 'string') {
    return undefined;
  }

  // `pv` decides whether the rights carried by this token are still current, so a token without one
  // is refused rather than defaulted to zero: a default would make every legacy token look stale
  // (harmless) or current (not harmless), depending on which way somebody wrote the comparison.
  if (typeof pv !== 'number' || !Number.isInteger(pv)) return undefined;

  return { userId: sub, organizationId: org, sessionId: sid, permissionsVersion: pv };
};

/**
 * HS256 through `jose`, with the secret from `JWT_SECRET` and the clock from `ClockPort`.
 *
 * Symmetric and not a key pair, deliberately: the only verifier is the process that signs. An
 * asymmetric algorithm buys a second party the ability to verify without being able to sign, and
 * this product has no second party — it would buy key management instead.
 */
export class JwtAccessTokenAdapter implements AccessTokenPort {
  private readonly secret: Uint8Array;

  constructor(
    secret: string,
    private readonly clock: ClockPort,
    private readonly ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
  ) {
    this.secret = new TextEncoder().encode(secret);
  }

  async issue(claims: AccessTokenClaims): Promise<IssuedAccessToken> {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);

    const token = await new SignJWT({
      org: claims.organizationId,
      sid: claims.sessionId,
      pv: claims.permissionsVersion,
    })
      .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.ttlSeconds)
      .sign(this.secret);

    return { token, expiresInSeconds: this.ttlSeconds };
  }

  async verify(token: string): Promise<AccessTokenClaims | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: this.clock.now(),
      });

      return asClaims(payload);
    } catch {
      // Bad signature, expired, wrong issuer, wrong algorithm — one answer. The caller answers 401
      // in every case, and a reason carried out of here is a reason that reaches a response body.
      return undefined;
    }
  }
}
