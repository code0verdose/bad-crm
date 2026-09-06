import {
  type AuthLookupPort,
  type AuthSessionRecord,
} from '@/application/identity/ports/auth-lookup.port.js';
import { type RefreshTokenPort } from '@/application/identity/ports/refresh-token.port.js';
import { type SessionRepositoryPort } from '@/application/identity/ports/session-repository.port.js';
import { type UserRepositoryPort } from '@/application/identity/ports/user-repository.port.js';
import {
  type IssuedSession,
  type IssueSessionUseCase,
  type SessionClient,
} from '@/application/identity/use-cases/issue-session.use-case.js';
import {
  type SessionOrganization,
  type SessionProfile,
} from '@/application/identity/use-cases/login.use-case.js';
import { type OrganizationRepositoryPort } from '@/application/organization/ports/organization-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type MailDispatchPort } from '@/application/platform/ports/mail-dispatch.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { renderRefreshReuseMail } from '@/domain/identity/refresh-reuse-mail.util.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { RateLimitedError } from '@/domain/shared/errors/app.errors.js';

/**
 * How recently a token may have been spent *by a rotation* and still count as a lost race.
 *
 * Two tabs of one browser refreshing at the same moment is ordinary, and the loser presents a token
 * the winner spent milliseconds earlier. Treating that as theft would revoke the family and sign
 * somebody out of a browser that did nothing wrong; treating theft as a race would make the whole
 * mechanism decorative. The signal that separates them, from STORY-006-03, is *how* and *how long
 * ago* the token was spent: a rotation, seconds ago.
 *
 * Ten seconds is generous for two tabs on one machine and short enough that a stolen token has to be
 * replayed inside the same breath to hide behind it — and a thief who is that fast is racing the
 * legitimate client, which will present its own next token and trip the detection anyway.
 */
export const REFRESH_RACE_GRACE_SECONDS = 10;

export interface RefreshSessionInput {
  readonly refreshToken: string;
  readonly client: SessionClient;
}

export interface RefreshSessionResult {
  readonly session: IssuedSession;
  readonly user: SessionProfile;
  readonly organization: SessionOrganization;
}

/**
 * Every refresh rotates, and a token presented twice is a fact worth acting on.
 *
 * ## The shape of the answer
 *
 * Unknown, expired, spent, replayed, or from an account that may no longer sign in: **one** refusal,
 * expressed as `null` rather than as five exceptions. The distinctions matter to the server and to
 * nobody else — a `detail` that separated them would tell a holder of a stolen token whether it was
 * ever valid — and a single returned value makes that structural instead of a convention every
 * branch has to keep.
 *
 * It is also what lets the controller stay free of `try`/`catch`: it clears the cookie and raises
 * the 401 on one branch, which is the shape `test/unit/architecture/express-conventions.test.ts`
 * requires of every controller in this codebase.
 *
 * ## Why the lookup is org-less and the writes are not
 *
 * The request carries a cookie and nothing else: no organization, so no `withTenant` to open. That
 * is the third of the three legitimate org-less paths of `docs/security/rls-design.md` («Особые
 * пути»), and it is answered by a `SECURITY DEFINER` function that reads exactly one session by the
 * digest of the token. The moment the organization is known, everything goes back through
 * `withTenant` under `app_user`.
 */
export class RefreshSessionUseCase {
  constructor(
    private readonly authLookup: AuthLookupPort,
    private readonly refreshTokens: RefreshTokenPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly users: UserRepositoryPort,
    private readonly organizations: OrganizationRepositoryPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly issueSession: IssueSessionUseCase,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
    private readonly rateLimit: RateLimitPort,
    private readonly audit: AuditLoggerPort,
    private readonly dispatcher: MailDispatchPort,
    private readonly appUrl: string,
  ) {}

  async execute(input: RefreshSessionInput): Promise<RefreshSessionResult | null> {
    // The ambient API budget, spent before the lookup. Rotation is not a credential guess — the
    // token is 256 opaque bits — so what this bounds is *work*: a `SECURITY DEFINER` read, a digest
    // and, on the happy branch, two writes, all of it reachable without a session. The subject is
    // the address alone because the caller has no identity until the cookie has been resolved, and
    // resolving it is the work being bounded.
    const decision = await this.rateLimit.consume('api_request', {
      userId: undefined,
      ipAddress: input.client.ipAddress,
    });

    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);

    const now = this.clock.now();
    const record = await this.authLookup.findSessionByRefreshHash(
      this.refreshTokens.hash(input.refreshToken),
    );

    if (record === null) return null;

    if (record.revokedAt !== null) {
      await this.handleSpentToken(record, record.revokedAt, now, input.client.ipAddress);

      return null;
    }

    // An expiry is the ordinary end of a session and not a sign of anything: the family stays.
    if (record.expiresAt.getTime() <= now.getTime()) return null;

    return this.rotate(record, input, now);
  }

  /**
   * A token that was already spent: theft, or a tab that lost a race.
   *
   * Revocation and the throw are separated on purpose. The family is revoked — and, since this fix,
   * the `AuditLog` row that describes it is written — in its own committed transaction, and the
   * refusal is raised *after* it: raising inside would roll both back along with everything else,
   * which is the one outcome this branch must not produce.
   *
   * The notice to the account owner sits *outside* that transaction for the same reason and one
   * more: SMTP is never called from inside one (`rules/outbox.mdc`, rule 2), and the revocation is
   * the defence while the mail is the courtesy. A relay that is down loses the message and closes
   * the family anyway — `MailDispatchPort.dispatch` returns before a socket is opened and never
   * throws, and the adapter records every outcome including the failures
   * (`ImmediateMailDispatcher`, «Why it never throws»). No `isConfigured()` check guards it, on the
   * same reasoning as `ChangePasswordUseCase`: an installation of the `minimal` profile has no
   * `SMTP_URL`, and a defensive revocation must not depend on a transport it does not have. The
   * eventual shape is the outbox row and a queue handler (ADR-0021); neither exists yet, and this
   * call site does not change when they do.
   */
  private async handleSpentToken(
    record: AuthSessionRecord,
    spentAt: Date,
    now: Date,
    ipAddress: string | undefined,
  ): Promise<void> {
    const spentAgo = now.getTime() - spentAt.getTime();
    const lostRace =
      record.revokedReason === 'ROTATED' && spentAgo <= REFRESH_RACE_GRACE_SECONDS * 1000;

    if (lostRace) return;

    const revoked = await this.unitOfWork.withTenant(
      { organizationId: record.organizationId, userId: record.userId },
      async () => {
        const sessionsRevoked = await this.sessions.revokeFamily(
          record.familyId,
          'REUSE_DETECTED',
          now,
        );

        // The row `rules/security.mdc` rule 8 asks for, written **inside** the transaction that
        // revoked the family — the identical reasoning every other privileged use-case in this
        // codebase follows for its own `audit.record` call (`rules/observability.mdc`, rule 15): a
        // rejection here must unwind the revocation with it, not leave a family closed with nothing
        // in the trail explaining why, or a row claiming a revocation that never committed.
        //
        // Identifiers and a counter only. The token and its digest never reach `before`/`after` on
        // the same construction that already kept them out of the log line below
        // (CLAUDE.md, «Что нельзя логировать никогда»); the address travels as `actor.ipAddress`
        // and is hashed before `PrismaAuditLogger` turns it into a column, never stored or logged
        // raw.
        await this.audit.record({
          action: 'session.refresh_reuse_detected',
          actor: { userId: record.userId, organizationId: record.organizationId, ipAddress },
          target: { type: 'SESSION_FAMILY', id: record.familyId },
          after: { sessionsRevoked },
          requestId: undefined,
        });

        return sessionsRevoked;
      },
    );

    // The operational line `rules/security.mdc` rule 8 also asks for — the one an on-call engineer
    // greps for, beside the `AuditLog` row a reviewer reads later (the identical split
    // `SECURITY_EVENTS.totpSetupAbandoned`'s own docstring draws). Identifiers only: the token, its
    // digest and the address are all absent by construction.
    //
    // **The event name is the `event` field, not the sentence.** An alert keyed on a substring of
    // `msg` stops matching the first time somebody improves the wording, and stops matching
    // silently.
    this.logger.warn(
      {
        event: SECURITY_EVENTS.refreshReuseDetected,
        userId: record.userId,
        organizationId: record.organizationId,
        familyId: record.familyId,
        sessionId: record.sessionId,
      },
      'refresh token reuse detected, revoking the session family',
    );

    // **One message per revoked family, not per presentation.** The condition is the revocation
    // itself: `UPDATE … WHERE family_id = $1 AND revoked_at IS NULL` matches rows exactly once, so a
    // token replayed ten more times against a family that is already closed costs ten more lines
    // here and no further mail. Without that, the detection would be a mailer aimed at the person
    // whose token was stolen — the attacker chooses when it fires.
    //
    // The trail and the log line stay unconditional: every presentation is a fact worth recording,
    // and only the *notification* has a recipient who can be flooded.
    if (revoked === 0) return;

    // The address and the language are read in a **second** scope, after the revoking one has
    // committed — not inside it. `withTenant` opens a transaction, not merely an RLS scope
    // (`UnitOfWorkPort`), and a read that failed there — an exhausted pool, a backend restarting
    // mid-statement — would roll the revocation and its trail back with it: a stolen token left
    // working, and nothing recording that it was ever noticed. Reading the recipient is part of the
    // mail path, and the mail must not be able to undo the defence. The same second scope for the
    // same reason is what `rotate` opens for its `OFFBOARDING` revocation below.
    //
    // `null` when the row is gone — the account can be deleted between the rotation and the replay.
    const account = await this.unitOfWork.withTenant(
      { organizationId: record.organizationId, userId: record.userId },
      () => this.users.findById(record.userId),
    );

    if (account === null) return;

    this.dispatcher.dispatch(
      {
        to: account.email,
        ...renderRefreshReuseMail({
          locale: account.locale,
          appUrl: this.appUrl,
          revokedSessions: revoked,
        }),
      },
      {
        event: SECURITY_EVENTS.refreshReuseDetected,
        organizationId: record.organizationId,
        userId: record.userId,
      },
    );
  }

  private async rotate(
    record: AuthSessionRecord,
    input: RefreshSessionInput,
    now: Date,
  ): Promise<RefreshSessionResult | null> {
    const scope = { organizationId: record.organizationId, userId: record.userId };
    const outcome = await this.unitOfWork.withTenant(scope, async () => {
      const user = await this.users.findById(record.userId);

      if (user === null || user.status !== 'ACTIVE') return { refused: 'account' } as const;

      // The one statement that decides a race: `UPDATE ... WHERE id = $1 AND revoked_at IS NULL`.
      // The loser updates nothing, and its own next presentation of the same token lands in
      // `handleSpentToken` inside the grace window — a 401 without touching the family.
      if (!(await this.sessions.markRotated(record.sessionId, now))) {
        return { refused: 'race' } as const;
      }

      const organization = await this.organizations.findCurrent();

      if (organization === null) return { refused: 'account' } as const;

      const session = await this.issueSession.execute({
        userId: record.userId,
        permissionsVersion: user.permissionsVersion,
        client: input.client,
        familyId: record.familyId,
        rotatedFromId: record.sessionId,
      });

      return {
        refused: undefined,
        result: {
          session,
          user: {
            id: user.id,
            email: user.email,
            locale: user.locale,
            timezone: user.timezone,
          },
          organization: {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
          },
        },
      } as const;
    });

    if (outcome.refused === 'account') {
      // Committed on its own, then refused — same reasoning as the reuse branch above.
      await this.unitOfWork.withTenant(scope, () =>
        this.sessions.revokeFamily(record.familyId, 'OFFBOARDING', now),
      );

      return null;
    }

    return outcome.refused === 'race' ? null : outcome.result;
  }
}
