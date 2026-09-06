import { type AccessTokenPort } from '@/application/identity/ports/access-token.port.js';
import { type SessionRepositoryPort } from '@/application/identity/ports/session-repository.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { UnauthenticatedError } from '@/domain/shared/errors/app.errors.js';

/** Who the request is from, once the token has been believed and the session confirmed. */
export interface AuthenticatedCaller {
  readonly userId: string;
  readonly organizationId: string;
  readonly sessionId: string;
  readonly familyId: string;
  /**
   * The session was opened under the organization's second-factor policy and may reach nothing but
   * the enrolment routes (STORY-013-05, acceptance 3).
   *
   * Read from the token's `scope` claim rather than recomputed here: the decision was made when the
   * session was issued, and remaking it per request would be the policy read, the role read and the
   * enrolment read on every request of every organization.
   */
  readonly mfaEnrollment: boolean;
}

/**
 * Turns a bearer token into a caller, or refuses.
 *
 * **The signature is not the whole answer.** A valid access token says what was true fifteen minutes
 * ago; the session behind it may have been revoked since — signed out, closed from
 * `/settings/security`, or taken down with its family by reuse detection — and the acceptance
 * criterion of STORY-006-04 is that the next request with that token fails *immediately* rather than
 * at expiry. So the row is read, in the tenant the token names.
 *
 * That read is where `docs/api/openapi.yaml` describes a Redis denylist of `sid`. The row answers
 * the same question with strictly more authority and no second store to keep consistent, at the cost
 * of one indexed primary-key lookup per request; the denylist remains the right optimisation once
 * there is a Redis client to hang it on, and it changes nothing about the outcome — which is why it
 * is an optimisation rather than the mechanism (STORY-006-03, still open).
 *
 * `permissionsVersion` is compared here for the same reason: a token minted before a right was taken
 * away carries the old `pv`, and the whole point of the claim is that such a token stops being
 * believed without anybody keeping a list of issued tokens.
 */
export class AuthenticateSessionQuery {
  constructor(
    private readonly accessTokens: AccessTokenPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(bearerToken: string): Promise<AuthenticatedCaller> {
    const claims = await this.accessTokens.verify(bearerToken);

    if (claims === undefined) throw new UnauthenticatedError();

    const now = this.clock.now();
    const caller = await this.unitOfWork.withTenant(
      { organizationId: claims.organizationId, userId: claims.userId },
      async () => {
        const context = await this.sessions.findAuthContext(claims.sessionId);

        if (context === null) return undefined;

        const usable =
          context.userId === claims.userId &&
          context.revokedAt === null &&
          context.expiresAt.getTime() > now.getTime() &&
          context.userStatus === 'ACTIVE' &&
          context.permissionsVersion === claims.permissionsVersion;

        return usable
          ? {
              userId: context.userId,
              organizationId: claims.organizationId,
              sessionId: context.sessionId,
              familyId: context.familyId,
              mfaEnrollment: claims.mfaEnrollment,
            }
          : undefined;
      },
    );

    if (caller === undefined) throw new UnauthenticatedError();

    return caller;
  }
}
