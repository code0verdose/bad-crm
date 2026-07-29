import {
  type SessionRepositoryPort,
  type SessionRevokedReason,
} from '@/application/identity/ports/session-repository.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { requireSessionOwner } from '@/domain/identity/access/session-owner.policy.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';

/** The tenant and the person a session operation is made on behalf of. */
export interface SessionActor {
  readonly organizationId: string;
  readonly userId: string;
}

export interface RevokeSessionResult {
  /** True when the revoked session is the one the request was made from — the caller signs out. */
  readonly wasCurrent: boolean;
}

/**
 * Closing sessions: this one, another of one's own, or all the others.
 *
 * The three live together because they are one decision seen from three angles — *whose* session may
 * be closed — and separating them would mean writing the ownership check three times, which is the
 * shape mistakes take. `requireSessionOwner` is that check, and it is named by the route registry as
 * the `ownershipCheckedIn` of every self-service route below (`route-registry.types.ts`).
 *
 * **A family, not a row.** A rotation writes a new row with the same `familyId`, so "close that
 * device" means closing the family: revoking a single row would leave the rest of the chain
 * untouched, and the newest of them is the one holding a live refresh token.
 *
 * **Each of the three writes one line.** Rows are the wrong record of this: `revoked_reason` is
 * overwritten in place, so the table answers "why is this session closed" and never "who closed it,
 * from where, and when" — which is the question an incident actually asks. The line names the
 * family rather than the row for the same reason the revocation does: the row changes every
 * fifteen minutes and the family is the device. It goes to the audit table too, once that exists
 * (EPIC-009), dispatched from this same field rather than from a second call written elsewhere.
 */
export class EndSessionUseCase {
  constructor(
    private readonly sessions: SessionRepositoryPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: ClockPort,
    private readonly logger: LoggerPort,
  ) {}

  /**
   * The record of a revocation — written only when something was actually revoked.
   *
   * A sign-out of an already closed session answers 204 and is not an event: the operation is
   * idempotent by design, and a line for every repeat would make the count of real revocations
   * unusable.
   */
  private recordRevocation(input: {
    readonly actor: SessionActor;
    readonly familyId: string;
    readonly reason: SessionRevokedReason;
    readonly revokedFamilies: number;
  }): void {
    if (input.revokedFamilies === 0) return;

    this.logger.info(
      {
        event: SECURITY_EVENTS.sessionsRevoked,
        reason: input.reason,
        organizationId: input.actor.organizationId,
        userId: input.actor.userId,
        familyId: input.familyId,
        revokedFamilies: input.revokedFamilies,
      },
      'sessions revoked',
    );
  }

  /**
   * Signing out, addressed by the session the request itself belongs to.
   *
   * No ownership check, and none is possible or needed: the id comes from the caller's own access
   * token or from the cookie that resolved to it, never from the request body. Answering the same
   * thing whether or not the row was still live is what makes the operation idempotent — and
   * `docs/api/openapi.yaml` promises exactly that (204 either way).
   */
  async signOut(actor: SessionActor, sessionId: string): Promise<void> {
    const now = this.clock.now();

    const closed = await this.unitOfWork.withTenant(actor, async () => {
      const session = await this.sessions.findOwner(sessionId);

      if (session === null) return undefined;

      const rows = await this.sessions.revokeFamily(session.familyId, 'LOGOUT', now);

      return { familyId: session.familyId, rows };
    });

    // After the transaction, never inside it: a line written before a commit describes a
    // revocation that a rollback can still undo (`rules/outbox.mdc`, rule 2).
    if (closed !== undefined) {
      this.recordRevocation({
        actor,
        familyId: closed.familyId,
        reason: 'LOGOUT',
        revokedFamilies: closed.rows > 0 ? 1 : 0,
      });
    }
  }

  /**
   * Closing one of the caller's own sessions, by an id they read from the list.
   *
   * A stranger's id and one that does not exist are both 404 — decided by the policy, not here, so
   * the rule lives in one place (`domain/identity/access/session-owner.policy.ts`).
   */
  async revoke(
    actor: SessionActor,
    sessionId: string,
    currentSessionId: string,
  ): Promise<RevokeSessionResult> {
    const now = this.clock.now();

    const outcome = await this.unitOfWork.withTenant(actor, async () => {
      const session = requireSessionOwner(await this.sessions.findOwner(sessionId), actor.userId);
      const current = await this.sessions.findOwner(currentSessionId);

      const rows = await this.sessions.revokeFamily(session.familyId, 'REVOKED_BY_USER', now);

      return {
        familyId: session.familyId,
        rows,
        // Compared by family and not by id: the caller's own session id changes on every rotation,
        // so "is this mine" is a question about the device, which is what the family stands for.
        wasCurrent: current !== null && current.familyId === session.familyId,
      };
    });

    this.recordRevocation({
      actor,
      familyId: outcome.familyId,
      reason: 'REVOKED_BY_USER',
      revokedFamilies: outcome.rows > 0 ? 1 : 0,
    });

    return { wasCurrent: outcome.wasCurrent };
  }

  /** "I signed in on a machine that is not mine": everything but this device goes. */
  async revokeOthers(actor: SessionActor, currentSessionId: string): Promise<number> {
    const now = this.clock.now();

    const outcome = await this.unitOfWork.withTenant(actor, async () => {
      const current = await this.sessions.findOwner(currentSessionId);

      // The current session has to be resolvable, or "every session except this one" has no
      // exception to make and the caller would sign themselves out of the browser they are in.
      const family = requireSessionOwner(current, actor.userId).familyId;

      return {
        keptFamilyId: family,
        revokedFamilies: await this.sessions.revokeOtherFamilies(
          actor.userId,
          family,
          'REVOKED_BY_USER',
          now,
        ),
      };
    });

    // The kept family, not the closed ones: this operation names its exception rather than its
    // subjects, and listing every closed family would put an unbounded array in a log line.
    this.recordRevocation({
      actor,
      familyId: outcome.keptFamilyId,
      reason: 'REVOKED_BY_USER',
      revokedFamilies: outcome.revokedFamilies,
    });

    return outcome.revokedFamilies;
  }
}
