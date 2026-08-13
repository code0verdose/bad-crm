/**
 * Employee profiles of the current tenant.
 *
 * No method takes an `organizationId`: the tenant is the scope the caller opened through
 * `UnitOfWorkPort`, and a parameter beside it would be a second answer to the same question — one
 * the policy silently overrules, turning a mismatch into an empty result rather than into an error
 * (`rules/tenancy-rls.mdc`, 9).
 */

import { type DirectoryStatus } from '@/application/iam/ports/employee-directory-repository.port.js';

/** A profile as the screens and the policies read it. The emergency contact is **ciphertext**. */
export interface EmployeeProfileRow {
  readonly userId: string;
  readonly email: string;
  /**
   * The state of the **account** the record belongs to — `users.status`, not a column of the
   * profile.
   *
   * Read here because the card has to be able to say «this account is switched off» when it is
   * opened by a direct link, with no directory row in the cache to derive it from. **Not** derived
   * from `terminatedAt`: that is an editable HR field under `employee:update`, and a leaving date
   * entered in advance would otherwise turn a working account into a disabled one on screen.
   *
   * The vocabulary is the directory's rather than a second restatement of `UserStatus`;
   * `test/unit/persistence/tenant-tables.test.ts` compares that one against the datamodel, so a
   * value added to the enum cannot drift past both.
   *
   * Absent from `EmployeeProfilePatch` on purpose: this endpoint edits a personnel record, and the
   * account is switched off and on by `/users/{userId}/deactivate` and `/reactivate`.
   */
  readonly status: DirectoryStatus;
  readonly firstName: string;
  readonly lastName: string;
  readonly jobTitle: string | null;
  readonly department: string | null;
  readonly managerId: string | null;
  readonly weeklyCapacityHours: number;
  readonly employmentType: string;
  readonly hiredAt: Date | null;
  readonly terminatedAt: Date | null;
  readonly timezone: string;
  readonly skills: readonly string[];
  /**
   * Still encrypted when it crosses this boundary, and decrypted by the use-case at the moment of
   * use. A repository that decrypted would put the plaintext in every read of the table, including
   * the ones that never needed it.
   */
  readonly emergencyContactEnc: string | null;
}

/** What an edit changes. Every field optional: a PATCH says what it touches and nothing more. */
export interface EmployeeProfilePatch {
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
  /** Already ciphertext: the plaintext never reaches this layer. */
  readonly emergencyContactEnc?: string | null;
}

export interface EmployeeProfileRepositoryPort {
  /** `null` when the person is not in this organization — answered 404, never 403. */
  byUserId(userId: string): Promise<EmployeeProfileRow | null>;

  /**
   * Creates the profile if there is none and applies the patch — one statement.
   *
   * An upsert rather than «read, then insert or update», because the row is created by two
   * different paths: accepting an invitation, and the first time an administrator fills the form in.
   * Reading first would let the two race and one of them fail on `uq_employee_profiles_user` for a
   * reason that has nothing to do with what the caller asked.
   *
   * `null` when the account itself does not exist here — the foreign key would refuse, and this
   * answers before it does so the caller can say 404.
   */
  upsert(userId: string, patch: EmployeeProfilePatch): Promise<EmployeeProfileRow | null>;

  /**
   * Every `user → manager` link of the organization, for the cycle check.
   *
   * The whole map rather than a recursive query: the chart of a team of fifty is fifty rows, read
   * once inside the transaction that is about to write the edge. A `WITH RECURSIVE` per edit would
   * be the same answer at the cost of a query nobody can read.
   */
  managerLinks(): Promise<ReadonlyMap<string, string>>;
}
