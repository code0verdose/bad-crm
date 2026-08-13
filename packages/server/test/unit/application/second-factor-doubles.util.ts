import {
  type IssuedMfaPendingToken,
  type MfaPendingTokenClaims,
  type MfaPendingTokenPort,
  type MfaPendingTokenSubject,
} from '@/application/identity/ports/mfa-pending-token.port.js';
import { type TotpEnrollmentState } from '@/application/identity/ports/totp-enrollment.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';

import { FakeTotpEnrollment } from '../../support/mfa-doubles.util.js';

/**
 * The two doubles the second-factor step needs and `test/support` does not carry yet.
 *
 * They live beside the suites that use them rather than in `test/support/identity-doubles.util.ts`
 * for one reason only: STORY-013-03 is being written by several agents at once and `test/support`
 * belongs to none of them. Promote them there once the HTTP surface needs the same stand-ins — the
 * shape is deliberately the one `identity-doubles.util.ts` already uses (record what was asked, not
 * that it was asked).
 */

/** Five minutes — `MFA_PENDING_TOKEN_TTL_SECONDS`, restated so the double needs no adapter import. */
const TTL_SECONDS = 300;

interface IssuedRecord {
  readonly jti: string;
  readonly token: string;
  readonly subject: MfaPendingTokenSubject;
}

/**
 * `MfaPendingTokenPort` in memory, with the two facts the suites actually assert: a token stops
 * verifying once it is revoked, and it stops verifying once its own five minutes are up.
 *
 * Expiry is decided against the same `ClockPort` the use-case reads, so «истёк промежуточный токен»
 * is reached by advancing the clock rather than by handing the double a flag — a flag would let the
 * expiry assertion pass on an implementation that never checks anything at all.
 */
export class FakeMfaPendingTokens implements MfaPendingTokenPort {
  readonly issued: IssuedRecord[] = [];
  readonly revoked: string[] = [];

  /** Makes `verify` reject, the way the adapter does when the denylist cannot be consulted. */
  unavailable = false;

  private counter = 0;

  private readonly live = new Map<string, MfaPendingTokenClaims>();

  constructor(private readonly clock: ClockPort) {}

  issue(subject: MfaPendingTokenSubject): Promise<IssuedMfaPendingToken> {
    this.counter += 1;

    const jti = `mfa-jti-${String(this.counter)}`;
    const token = `mfa.${jti}`;

    this.live.set(token, {
      ...subject,
      jti,
      expiresAt: new Date(this.clock.now().getTime() + TTL_SECONDS * 1000),
    });
    this.issued.push({ jti, token, subject });

    return Promise.resolve({ token, jti, expiresInSeconds: TTL_SECONDS });
  }

  verify(token: string): Promise<MfaPendingTokenClaims | undefined> {
    if (this.unavailable) {
      return Promise.reject(new ServiceUnavailableError({ dependency: 'redis' }));
    }

    const claims = this.live.get(token);

    if (claims === undefined) return Promise.resolve(undefined);

    return Promise.resolve(
      claims.expiresAt.getTime() <= this.clock.now().getTime() ? undefined : claims,
    );
  }

  revoke(claims: Pick<MfaPendingTokenClaims, 'jti' | 'expiresAt'>): Promise<void> {
    this.revoked.push(claims.jti);

    for (const [token, live] of this.live) if (live.jti === claims.jti) this.live.delete(token);

    return Promise.resolve();
  }
}

/**
 * `FakeTotpEnrollment` that writes every `find` into the shared journal.
 *
 * The journal is the only way to assert an *order* across two doubles, and one order is a criterion
 * of this story rather than a detail: acceptance 8 says the fact «у этого адреса включена 2FA» is
 * not readable before the password verified. That is a statement about which call happens first, and
 * no assertion over two separate call lists can express it.
 */
export class JournalingTotpEnrollment extends FakeTotpEnrollment {
  constructor(private readonly journal: string[]) {
    super();
  }

  override find(userId: string): Promise<TotpEnrollmentState | null> {
    this.journal.push('totp-enrollment:find');

    return super.find(userId);
  }
}
