import {
  type EmployeeProfilePatch,
  type EmployeeProfileRepositoryPort,
  type EmployeeProfileRow,
} from '@/application/iam/ports/employee-profile-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type FieldEncryptionPort } from '@/application/platform/ports/field-encryption.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  canEditProfile,
  canReadProfile,
  employmentPeriodInverted,
  employmentPeriodRefused,
  managerCycleRefused,
  profileAudience,
  type ProfileAudience,
} from '@/domain/iam/access/employee-access.policy.js';
import { closesManagerCycle } from '@/domain/iam/org-chart.util.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

/** What a caller may change, in the shape the request carries it — plaintext included. */
export interface EmployeeProfileInput {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly jobTitle?: string | null;
  readonly department?: string | null;
  readonly managerId?: string | null;
  readonly weeklyCapacityHours?: number;
  readonly employmentType?: string;
  readonly hiredAt?: Date | null;
  readonly terminatedAt?: Date | null;
  readonly timezone?: string;
  readonly skills?: readonly string[];
  /** Plaintext here and **only** here: it is encrypted before it reaches the repository. */
  readonly emergencyContact?: string | null;
}

export interface WriteEmployeeProfileInput {
  readonly actor: Actor;
  readonly subjectUserId: string;
  readonly patch: EmployeeProfileInput;
}

/** The profile plus which audiences this caller belongs to — the serializer needs both. */
export interface VisibleEmployeeProfile {
  readonly profile: EmployeeProfileRow;
  readonly audience: ProfileAudience;
  /** Decrypted only when the caller may see it, and only then. */
  readonly emergencyContact: string | null;
}

/**
 * Editing a person's employment record.
 *
 * One operation for two audiences, and the policy is what tells them apart: an administrator with
 * `employee:update` edits anybody, and everybody edits the handful of fields on their own record
 * that nobody else is a better authority on — a name, a language, a timezone, a list of skills
 * (`employee-access.policy.ts`). An HR field in a self-edit is a refusal rather than a silently
 * ignored key: dropping it would let a form claim it saved something it did not.
 *
 * **The cycle check reads inside the transaction that writes.** «Is this manager already below me»
 * answered before the transaction is answered against a chart somebody else may have changed since,
 * and two concurrent edits could then each be fine on their own and close a loop together.
 *
 * The emergency contact is encrypted **here**, not in the repository: the repository stores what it
 * is given, and a layer that encrypted would be a layer that has to be trusted to have done it.
 */
export class WriteEmployeeProfileUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly profiles: EmployeeProfileRepositoryPort,
    private readonly fields: FieldEncryptionPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  /**
   * `async`, so that a refusal is a **rejection** rather than a synchronous throw.
   *
   * The policy check happens before the transaction is opened, which is correct — but a method whose
   * type says `Promise<T>` and which sometimes throws before returning one is a trap: `.catch()` on
   * it does not catch, and the error handler sees it only because Express happens to await the
   * handler. Every other use-case here has the same shape for the same reason.
   */
  async execute(input: WriteEmployeeProfileInput): Promise<VisibleEmployeeProfile> {
    // Which fields the request actually carried — the policy decides on these, not on their values.
    const changed = Object.keys(input.patch).filter(
      (field) => input.patch[field as keyof EmployeeProfileInput] !== undefined,
    );

    // `user`, not `employee`: the closed catalogue of error resources names the person, and the
    // profile is a record *about* one. `user_not_found` is also what every other operation on a
    // person of another organization answers, which is what keeps 404 indistinguishable.
    assertAllowed(canEditProfile(input.actor, input.subjectUserId, changed), 'user');

    return await this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        if (input.patch.managerId !== undefined && input.patch.managerId !== null) {
          const links = await this.profiles.managerLinks();

          if (
            closesManagerCycle(
              { userId: input.subjectUserId, managerId: input.patch.managerId },
              links,
            )
          ) {
            assertAllowed(managerCycleRefused(), 'user');
          }
        }

        await this.assertEmploymentPeriod(input);

        const stored = await this.profiles.upsert(input.subjectUserId, this.toRow(input.patch));

        // The account is not in this organization: 404, like every other object of somebody else's
        // tenant.
        if (stored === null) throw denyAccess('user', 'other_organization');

        await this.audit.record({
          action: 'employee.updated',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'USER', id: input.subjectUserId },
          // **Which fields changed, never their values.** An emergency contact in the trail would
          // undo the column being ciphertext, and a salary-shaped field would do worse; the reviewer
          // needs to know that HR data was edited and by whom.
          after: { fields: changed },
          requestId: undefined,
        });

        return this.visible(input.actor, stored);
      },
    );
  }

  /**
   * «Ends before it begins» — checked against what the record **will** hold, inside the transaction.
   *
   * The read happens only when the patch touches one of the two dates, and it has to happen at all
   * because a PATCH may carry just the termination date: comparing the body against itself would
   * pass, and the database would then answer `23514`, which the error handler has no name for and
   * turns into a 500. The same shape as the cycle check above, for the same reason.
   */
  private async assertEmploymentPeriod(input: WriteEmployeeProfileInput): Promise<void> {
    const { hiredAt, terminatedAt } = input.patch;

    if (hiredAt === undefined && terminatedAt === undefined) return;

    // **The stored row is only consulted for somebody allowed to read it.**
    //
    // Comparing against it makes the answer depend on a value the caller may not see, and a
    // difference in the answer is a value that can be searched for: `{terminatedAt: X}` answering
    // 422 above some X and 200 below it yields a colleague's hiring date by bisection. That is the
    // same channel the directory closes by refusing `sort=hiredAt` — through a write instead of a
    // read. It needs `employee:update` without `employee:view_personal_data`, which no built-in role
    // grants and a custom one can.
    //
    // So such a caller has to send both dates or neither: the pair is then judged against itself,
    // and nothing about the stored row reaches them. It costs a caller who edits one date the
    // trouble of sending the other, and it is the only version of this check that leaks nothing.
    if (!profileAudience(input.actor, input.subjectUserId).personal) {
      // Both conditions in one place, so «one date missing» and «the stated pair is inverted» give
      // the same answer to the same caller — a second `if` would be a second observable outcome, and
      // two outcomes are what a bisection needs.
      const incomplete = hiredAt === undefined || terminatedAt === undefined;
      const stated = { hiredAt: hiredAt ?? null, terminatedAt: terminatedAt ?? null };

      if (incomplete || employmentPeriodInverted(stated)) {
        assertAllowed(employmentPeriodRefused(), 'user');
      }

      return;
    }

    const current = await this.profiles.byUserId(input.subjectUserId);
    const merged = {
      hiredAt: hiredAt === undefined ? (current?.hiredAt ?? null) : hiredAt,
      terminatedAt: terminatedAt === undefined ? (current?.terminatedAt ?? null) : terminatedAt,
    };

    if (employmentPeriodInverted(merged)) assertAllowed(employmentPeriodRefused(), 'user');
  }

  /** The plaintext becomes ciphertext exactly once, on the way in. */
  private toRow(patch: EmployeeProfileInput): EmployeeProfilePatch {
    const { emergencyContact, ...rest } = patch;

    return emergencyContact === undefined
      ? rest
      : { ...rest, emergencyContactEnc: this.fields.encrypt(emergencyContact) };
  }

  /**
   * Decrypts the emergency contact **only** for a caller who may read it.
   *
   * Not «decrypt and let the serializer drop it»: a value that was never decrypted cannot be
   * serialised by mistake, logged by mistake, or end up in a snapshot.
   */
  private visible(actor: Actor, profile: EmployeeProfileRow): VisibleEmployeeProfile {
    const audience = profileAudience(actor, profile.userId);

    return {
      profile,
      audience,
      // `.personal`, never «belongs to some audience»: the cost audience is about rates, and a
      // relative's phone number is not a rate.
      emergencyContact: audience.personal ? this.fields.decrypt(profile.emergencyContactEnc) : null,
    };
  }
}

export interface ReadEmployeeProfileInput {
  readonly actor: Actor;
  readonly subjectUserId: string;
}

/**
 * Reading one profile, folded to what this caller may see.
 *
 * The folding happens here rather than in the serializer for the same reason the decryption does:
 * what a caller may see is a decision, and decisions live one layer below the shape they produce.
 */
export class ReadEmployeeProfileQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly profiles: EmployeeProfileRepositoryPort,
    private readonly fields: FieldEncryptionPort,
  ) {}

  /** `async` for the reason the writer above states: a refusal is a rejection, never a throw. */
  async execute(input: ReadEmployeeProfileInput): Promise<VisibleEmployeeProfile> {
    assertAllowed(canReadProfile(input.actor, input.subjectUserId), 'user');

    return await this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const profile = await this.profiles.byUserId(input.subjectUserId);

        if (profile === null) throw denyAccess('user', 'other_organization');

        const audience = profileAudience(input.actor, profile.userId);

        return {
          profile,
          audience,
          emergencyContact: audience.personal
            ? this.fields.decrypt(profile.emergencyContactEnc)
            : null,
        };
      },
    );
  }
}
