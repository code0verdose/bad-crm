import { type EffectivePermissionsReaderPort } from '@/application/iam/ports/effective-permissions-reader.port.js';
import { type UserRoleRepositoryPort } from '@/application/iam/ports/user-role-repository.port.js';
import { type RecoveryCodeRepositoryPort } from '@/application/identity/ports/recovery-code-repository.port.js';
import { type SessionRepositoryPort } from '@/application/identity/ports/session-repository.port.js';
import { type TotpEnrollmentRepositoryPort } from '@/application/identity/ports/totp-enrollment.port.js';
import { type UserRepositoryPort } from '@/application/identity/ports/user-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type MailDispatchPort } from '@/application/platform/ports/mail-dispatch.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import {
  assertMfaResetInBounds,
  assertNotSelfReset,
} from '@/domain/identity/access/mfa-policy.policy.js';
import { renderMfaChangedMail } from '@/domain/identity/mfa-changed-mail.util.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';
import { RateLimitedError } from '@/domain/shared/errors/app.errors.js';

export interface ResetUserMfaInput {
  readonly actor: Actor;
  readonly subjectUserId: string;
}

/** What the reset actually did, as counts rather than as reassurance — the same reasoning
 *  `OffboardingReport` (`deactivate-user.use-case.ts`) gives for its own shape. */
export interface ResetUserMfaResult {
  readonly userId: string;
  /** Whether the account had 2FA enabled a moment before this ran. `false` is not an error. */
  readonly wasEnabled: boolean;
  readonly recoveryCodesDeleted: number;
  readonly sessionsRevoked: number;
}

/**
 * The way back in for somebody who lost their authenticator and every recovery code:
 * `POST /users/{userId}/reset-mfa`, behind `user:reset_mfa` — `dangerous`
 * (`permission-model.md` §3.2). STORY-013-04, acceptance 5.
 *
 * ## What one reset does, and why it is one transaction
 *
 * Four writes, inside a single `unitOfWork.withTenant` block: `enrollment.disable` clears the TOTP
 * columns, `recoveryCodes.deleteAllForUser` removes the batch a reset must not leave valid for a
 * *future* enrolment nobody scanned a QR code for (the identical reasoning `DisableTotpUseCase`
 * documents for the self-service path), `sessions.revokeAllFamilies` closes every device, and
 * `bumpPermissionsVersion` makes a token minted a minute ago stop working on its next request rather
 * than at its own expiry — the same three-fact invalidation `DeactivateUserUseCase`'s docstring
 * explains at length, reused here rather than reinvented (`SessionRepositoryPort.revokeAllFamilies`
 * is the identical method offboarding calls, not a new one). A partial application — sessions closed
 * and 2FA still reading as enabled, or the reverse — is a state nothing in this product can recover
 * from except this same operation run again, so every write happens or none does.
 *
 * `sessionsRevoked` and `recoveryCodesDeleted` travel in the response and in the trail's `after`,
 * not as reassurance but as the report `DeactivateUserUseCase` already established the pattern for:
 * a reset whose response carries no counters is one the caller has to trust rather than check.
 *
 * ## Two refusals decided before anything is written, and why the order is what it is
 *
 * `assertNotSelfReset` runs first, before the subject is even looked up: it needs only the two ids
 * already in the input, and refusing on them costs nothing (`domain/identity/access/mfa-policy.policy.ts`
 * explains why the refusal is a conflict rather than a denial). `users.findById` then answers
 * existence *inside this tenant* — `null` is 404, never 403, on the identical invariant every other
 * cross-tenant lookup in this codebase honours (`denyAccess`) — and doubles as the read that supplies
 * the address and locale the notice at the bottom needs, so there is no second query for it.
 *
 * `assertMfaResetInBounds` runs next, against facts read through `EffectivePermissionsReaderPort`
 * **inside this same transaction** — the identical reasoning `DeactivateUserUseCase` gives for reading
 * its own subject's capabilities where it writes rather than from a snapshot taken earlier: a role
 * granted between the guard and this line must not slip past the bound. Without it, `user:reset_mfa`
 * — held by both `owner` and `admin` — let one administrator strip the organization owner's second
 * factor down to a password, or strip a fellow administrator's, with nothing checked beyond the
 * capability the route guard already confirmed. `assertMfaResetInBounds` closes that: the rank rule
 * `T-IAM-09` already applies to every other way of touching somebody's rights in this codebase
 * (`role-assignment.policy.ts`, `permission-override.policy.ts`, `role-composition.policy.ts`,
 * `invitation-access.policy.ts`, `user-lifecycle.policy.ts`), and this was the one path without it.
 *
 * ## Idempotent in effect, and a repeat that changes nothing writes nothing
 *
 * `enrollment.disable` answers whether the account actually had 2FA enabled a moment ago
 * (`TotpEnrollmentRepositoryPort.disable`'s own contract, which names the mistake this class used to
 * make: "a caller that ignored the return value would write an audit row and send a mail for an
 * account whose 2FA was already off"). `wasEnabled: false` short-circuits `reset` before any further
 * write — no recovery codes to delete (a disabled account has none, the identical invariant
 * `DisableTotpUseCase` establishes for the self-service path), no session to revoke, no permission
 * version to bump, no trail entry, no mail. That last part is not a detail: a permission holder who
 * loops this call against one victim must not be able to deny them a session or fill their inbox once
 * the account's 2FA is already off, and idempotent-with-side-effects was exactly that loop. Mirrors
 * `DeactivateUserUseCase`'s `alreadyDeactivated` branch, which is silent for the same reason.
 *
 * ## Rate-limited before the transaction opens, for the repeats that are *not* a no-op
 *
 * The no-op above only helps once an account's 2FA is already off; a permission holder who instead
 * *keeps* disabling 2FA the moment its owner re-enables it produces a genuine state change every
 * time, and idempotency has nothing to say about that. `mfa_admin_reset_attempt` bounds it the same
 * way every sensitive path in this codebase is bounded (`rules/security.mdc`, rule 11): consumed
 * before `withTenant` opens, keyed on the actor — the administrator spending the budget, not the
 * account being reset, the same reasoning `invitation_create` is keyed on the inviter.
 *
 * ## No confirmation round trip, on purpose
 *
 * `user:reset_mfa` is `dangerous`, and the UI-level confirmation STORY-013-04's acceptance 10 asks
 * for lives entirely on the client (a dialog naming what is about to happen), the same choice this
 * codebase already made for `user:suspend` — also `dangerous` — in `DeactivateUserUseCase`, which
 * carries no `x-confirm-dangerous`/`ConfirmationRequiredError` round trip either. That mechanism is
 * reserved for **composing** a role out of dangerous keys (`ApplyRoleChangesUseCase`), a different
 * question — "should this capability exist at all" — from "should this one action, once, proceed".
 *
 * ## The owner is told, and cannot turn the notice off — when there is something to tell
 *
 * STORY-013-04's acceptance 5 asks for a notification "которое нельзя отключить в настройках". This
 * product has no notification-preference mechanism of any kind today — nothing here is switchable,
 * for anybody, about any event — so the requirement is met by there being nothing to disable it in,
 * not by a preference this use-case deliberately ignores. The mail itself is the identical
 * `renderMfaChangedMail` notice `DisableTotpUseCase` sends, with the one reason (`reset_by_admin`)
 * that says an administrator did this rather than the owner, fire-and-forget after the commit
 * (`rules/outbox.mdc`, rule 2) — an SMTP call inside the transaction that just revoked every session
 * would hold those row locks open for however long the relay takes to answer. `execute` gates it on
 * `result.wasEnabled`: a notice that says "your 2FA was turned off" would be false the moment nothing
 * happened.
 */
export class ResetUserMfaUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly users: UserRepositoryPort,
    private readonly enrollment: TotpEnrollmentRepositoryPort,
    private readonly recoveryCodes: RecoveryCodeRepositoryPort,
    private readonly sessions: SessionRepositoryPort,
    private readonly userRoles: UserRoleRepositoryPort,
    private readonly permissions: EffectivePermissionsReaderPort,
    private readonly rateLimit: RateLimitPort,
    private readonly audit: AuditLoggerPort,
    private readonly clock: ClockPort,
    private readonly mailDispatcher: MailDispatchPort,
    /** `APP_URL`. Required rather than defaulted: a link built on a guess points at nobody. */
    private readonly appUrl: string,
  ) {}

  async execute(input: ResetUserMfaInput): Promise<ResetUserMfaResult> {
    assertNotSelfReset(input.actor, input.subjectUserId);

    // Before the transaction, on the identical reasoning every other sensitive path in this codebase
    // spends its budget early: verifying and writing are both costs a caller who has already exceeded
    // the budget must not be allowed to trigger.
    const decision = await this.rateLimit.consume('mfa_admin_reset_attempt', {
      userId: input.actor.userId,
    });

    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);

    const { result, email, locale } = await this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      () => this.reset(input),
    );

    // A notice that says "your 2FA was turned off" would be false for a call that found nothing to
    // turn off — the no-op branch of `reset` this gates on.
    if (result.wasEnabled) this.notify(input.actor.organizationId, result.userId, email, locale);

    return result;
  }

  private async reset(input: ResetUserMfaInput): Promise<{
    readonly result: ResetUserMfaResult;
    readonly email: string;
    readonly locale: string;
  }> {
    const subject = await this.users.findById(input.subjectUserId);

    if (subject === null) throw denyAccess('user', 'other_organization');

    const facts = await this.permissions.capabilitiesOf(subject.id);

    // Vanished between the two reads (a concurrent soft delete): the identical 404
    // `DeactivateUserUseCase` answers for the same race, never "permissions of undefined".
    if (facts === null) throw denyAccess('user', 'other_organization');

    assertMfaResetInBounds(input.actor, {
      userId: subject.id,
      isOwner: facts.isOwner,
      permissions: facts.granted,
      denied: facts.denied,
    });

    const now = this.clock.now();
    const wasEnabled = await this.enrollment.disable(subject.id);

    if (!wasEnabled) {
      // A true no-op (MEDIUM-2): nothing to delete, nothing to revoke, nothing to bump, nothing to
      // tell anyone — mirrors `DeactivateUserUseCase`'s silent `alreadyDeactivated` branch.
      return {
        result: {
          userId: subject.id,
          wasEnabled: false,
          recoveryCodesDeleted: 0,
          sessionsRevoked: 0,
        },
        email: subject.email,
        locale: subject.locale,
      };
    }

    const recoveryCodesDeleted = await this.recoveryCodes.deleteAllForUser(subject.id);
    const sessionsRevoked = await this.sessions.revokeAllFamilies(
      subject.id,
      'MFA_RESET_BY_ADMIN',
      now,
    );

    await this.userRoles.bumpPermissionsVersion(subject.id);

    await this.audit.record({
      action: 'user.mfa_reset_by_admin',
      actor: {
        userId: input.actor.userId,
        organizationId: input.actor.organizationId,
        ipAddress: undefined,
      },
      target: { type: 'USER', id: subject.id },
      before: { totpEnabled: true },
      after: { totpEnabled: false, recoveryCodesDeleted, sessionsRevoked },
      requestId: undefined,
    });

    return {
      result: { userId: subject.id, wasEnabled: true, recoveryCodesDeleted, sessionsRevoked },
      email: subject.email,
      locale: subject.locale,
    };
  }

  private notify(organizationId: string, userId: string, email: string, locale: string): void {
    this.mailDispatcher.dispatch(
      {
        to: email,
        ...renderMfaChangedMail({ locale, appUrl: this.appUrl, reason: 'reset_by_admin' }),
      },
      { event: SECURITY_EVENTS.totpResetByAdmin, organizationId, userId },
    );
  }
}
