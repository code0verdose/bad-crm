import { ConflictError } from '@/domain/shared/errors/app.errors.js';

/** The only two facts the decision needs: who is being offboarded, and who owns the organization. */
export interface OffboardingSubject {
  readonly userId: string;
  /** `organizations.owner_id` of the tenant the account belongs to. */
  readonly organizationOwnerId: string;
}

/**
 * The one thing an organization cannot survive: losing the last account nobody can take rights from.
 *
 * ## Why a policy and not a constraint
 *
 * Since the contract step of STORY-006-09, `organizations.owner_id` is NOT NULL and its foreign key is
 * `ON DELETE NO ACTION`, so the database itself refuses to *delete* the owner. What the database
 * cannot see is a **soft** delete: `users.deleted_at` leaves the row in place, the foreign key never
 * fires, and the organization goes on pointing at an account the product will never show again.
 * Formally there is an owner; in practice there is nobody who can administer the installation.
 *
 * A `CHECK` cannot close it either — a check cannot read another table — and a trigger would put the
 * rule somewhere no reader of the use-case would look. So it is an application invariant, and this is
 * the place it lives (`docs/architecture/data-model.md`, «Про `Organization.ownerId`»).
 *
 * ## Why it exists before the operation it guards
 *
 * Offboarding is not implemented: it belongs to STORY-012-05 of EPIC-012. That is the reason to write
 * the guard now rather than later — the story this policy comes from exists so that offboarding
 * *cannot* be implemented without transferring ownership first, and a rule added afterwards is a rule
 * added after the defect. `test/unit/domain/owner-offboarding.test.ts` is what makes it non-decorative;
 * `test/architecture` keeps the call sites honest once they exist.
 *
 * ## Why a conflict and not a denial
 *
 * `409`, not `403` or `404`. Nothing about this refusal is about permission or about hiding a row: the
 * caller is allowed to offboard people and the subject plainly exists. The request is refused because
 * the system is in a state where it cannot be satisfied, and there is a specific action that changes
 * that state — transfer ownership. That is what a conflict means in this API, and the code says which
 * step is missing rather than making the caller guess (`docs/api/README.md`, error codes).
 */
export const requireOwnershipTransferredBeforeOffboarding = (subject: OffboardingSubject): void => {
  if (subject.userId !== subject.organizationOwnerId) return;

  throw new ConflictError('last_owner_required', {
    cause: 'owner_offboarding_without_transfer',
  });
};
