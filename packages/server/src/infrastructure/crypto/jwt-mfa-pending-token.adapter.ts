import { jwtVerify, SignJWT } from 'jose';

import {
  type IssuedMfaPendingToken,
  type MfaPendingTokenClaims,
  type MfaPendingTokenPort,
  type MfaPendingTokenSubject,
} from '@/application/identity/ports/mfa-pending-token.port.js';
import { type TokenDenylistPort } from '@/application/identity/ports/token-denylist.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';

/** Five minutes, exactly what STORY-013-03 acceptance 1 states. */
export const MFA_PENDING_TOKEN_TTL_SECONDS = 300;

/**
 * The one algorithm this installation signs and accepts — pinned in both directions for the same
 * reason `jwt-access-token.adapter.ts` pins it: reading the algorithm out of the token being
 * verified is the classic JWT failure.
 */
const ALGORITHM = 'HS256';

const ISSUER = 'bad-crm';
const AUDIENCE = 'bad-crm-api';

/**
 * The value of the `scope` claim, and the one thing that makes this token a *different kind of
 * credential* from an access token rather than a variant of one.
 */
const SCOPE = 'mfa_pending';

/**
 * `sub` is `pending:{userId}` rather than a bare `userId` — STORY-013-03 acceptance 1 states the
 * shape verbatim. It buys nothing on its own against a JWT signed with the *other* purpose's secret
 * (the scope check below already refuses that), but it means a raw claims dump in a log or a
 * debugger reads as what it is instead of as a user id sitting where `AccessTokenClaims.userId` would
 * be, which is the shape a human skimming a log actually confuses.
 */
const SUBJECT_PREFIX = 'pending:';

/** The denylist's own namespace for these tokens — `TokenDenylistPort` knows nothing about JWTs. */
const denylistKeyOf = (jti: string): string => `mfa-pending-token:${jti}`;

interface RawClaims {
  readonly sub?: unknown;
  readonly org?: unknown;
  readonly scope?: unknown;
  readonly jti?: unknown;
  readonly exp?: unknown;
}

/**
 * Turns a verified payload into `MfaPendingTokenClaims`, or refuses.
 *
 * **The scope check is its own branch, reached only once every other claim already validated.** That
 * ordering is deliberate and is the answer to the trap STORY-013-03 names explicitly: a token missing
 * `sid`/`pv` fails `AccessTokenPort`'s own `asClaims` *before* anything about scope is ever
 * consulted, which would make "an mfa-pending token is rejected everywhere but `/auth/2fa/verify`"
 * true by accident of a claims-shape mismatch rather than by a scope check that actually runs. Here,
 * a token carrying a well-formed `sub`, `org`, `jti` and `exp` — everything this function requires —
 * and *only* the wrong `scope` reaches the `scope !== SCOPE` line and is refused by it specifically,
 * which is what `jwt-mfa-pending-token.test.ts` exercises: a token forged with every other claim
 * right and the scope wrong.
 */
const asClaims = (payload: RawClaims): MfaPendingTokenClaims | undefined => {
  const { sub, org, scope, jti, exp } = payload;

  if (typeof sub !== 'string' || !sub.startsWith(SUBJECT_PREFIX)) return undefined;

  const userId = sub.slice(SUBJECT_PREFIX.length);
  if (userId.length === 0) return undefined;

  if (typeof org !== 'string' || typeof jti !== 'string' || typeof exp !== 'number') {
    return undefined;
  }

  if (scope !== SCOPE) return undefined;

  return { userId, organizationId: org, jti, expiresAt: new Date(exp * 1000) };
};

/**
 * `MfaPendingTokenPort` on `jose` for the JWT half and a `TokenDenylistPort` for the one-time-use
 * half.
 *
 * The two are composed here rather than in the use-case that will call `verify()`
 * (`verify-second-factor.use-case.ts`, a different zone of STORY-013-03) because the port promises a
 * single verdict — "verified and unspent, or not" — and splitting that promise across two objects
 * the use-case has to call in the right order would let a future caller check the JWT and skip the
 * denylist, which is exactly the one-time-use guarantee this adapter exists to make impossible to
 * bypass by omission.
 *
 * **What happens when the denylist cannot be consulted is a decision, not an accident.** The store
 * lookup inside `verify()` and the store write inside `revoke()` both let `TokenDenylistPort`'s
 * rejection propagate rather than catching it and answering `undefined`/resolving anyway. Two shapes
 * were available and the rate limiter already chose between them for the same class of failure
 * (`rate-limiter.adapter.ts`): fold the outage into the ordinary "no" (here, `undefined` → the
 * caller's `mfa_token_expired`), or let it surface as `ServiceUnavailableError` → `503`. This adapter
 * takes the second path, for the same reason the limiter does — a limiter that admits everyone while
 * its store is down makes "take the store down" the cheapest bypass, and a denylist that answers
 * "not spent" under the same condition makes "take the store down" the cheapest way to reuse a
 * spent token. Folding it into `mfa_token_expired` would also be actively misleading here in a way
 * it is not for the limiter: an operator paging on a spike of "second factor token expired" during a
 * Redis outage is chasing a UX complaint, not the infrastructure failure actually happening. `503`
 * is the honest answer, and it is a status this API already returns from the same sign-in flow for
 * the identical dependency (`docs/api/openapi.yaml`, `login`).
 *
 * **This adapter is reached before the limiter, not after.** `VerifySecondFactorUseCase` verifies
 * the token first and only then spends a budget, because the subject of that budget *is* the
 * token's `jti` and a `jti` read out of an unverified string would be a counter the caller picks.
 * So during a Redis outage the `503` a caller sees comes from here rather than from the limiter —
 * the earlier draft of this comment claimed the opposite ordering, which was wrong about its own
 * caller. Both answers are the same status for the same dependency; only the source differs.
 */
export class JwtMfaPendingTokenAdapter implements MfaPendingTokenPort {
  private readonly secret: Uint8Array;

  constructor(
    secret: string,
    private readonly clock: ClockPort,
    private readonly idGenerator: IdGeneratorPort,
    private readonly denylist: TokenDenylistPort,
    private readonly ttlSeconds: number = MFA_PENDING_TOKEN_TTL_SECONDS,
  ) {
    this.secret = new TextEncoder().encode(secret);
  }

  async issue(subject: MfaPendingTokenSubject): Promise<IssuedMfaPendingToken> {
    const jti = this.idGenerator.next();
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);

    const token = await new SignJWT({ org: subject.organizationId, scope: SCOPE })
      .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
      .setSubject(`${SUBJECT_PREFIX}${subject.userId}`)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setJti(jti)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.ttlSeconds)
      .sign(this.secret);

    return { token, jti, expiresInSeconds: this.ttlSeconds };
  }

  async verify(token: string): Promise<MfaPendingTokenClaims | undefined> {
    let payload: RawClaims;

    try {
      ({ payload } = await jwtVerify(token, this.secret, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: this.clock.now(),
      }));
    } catch {
      // Bad signature, expired, wrong issuer, wrong algorithm — one answer, same reasoning as
      // `jwt-access-token.adapter.ts`: the caller answers `mfa_token_expired` in every case, and a
      // reason carried out of here is a reason that reaches a response body.
      return undefined;
    }

    const claims = asClaims(payload);
    if (claims === undefined) return undefined;

    // Left uncaught on purpose — see the class doc for why an unreachable denylist must reject
    // rather than resolve `false` here.
    const spent = await this.denylist.isRevoked(denylistKeyOf(claims.jti));
    if (spent) return undefined;

    return claims;
  }

  async revoke(claims: Pick<MfaPendingTokenClaims, 'jti' | 'expiresAt'>): Promise<void> {
    // "TTL не меньше остатка жизни токена": whatever is left of the token's own lifetime, floored at
    // one second because `EX 0` and negative values are rejected by Redis, and a token presented for
    // revocation after it has already expired needs no denylist entry to stay unusable — the floor
    // exists only to keep the write itself valid, not to extend anything.
    const remainingSeconds = Math.max(
      Math.ceil((claims.expiresAt.getTime() - this.clock.now().getTime()) / 1000),
      1,
    );

    await this.denylist.revoke(denylistKeyOf(claims.jti), remainingSeconds);
  }
}
