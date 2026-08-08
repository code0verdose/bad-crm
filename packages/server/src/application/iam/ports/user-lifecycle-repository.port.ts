/**
 * The account lifecycle: switching a person off and back on.
 *
 * Its own port rather than a method on the identity repository, because the rows it touches belong
 * to three tables at once — the account, the personnel record and the team memberships — and the
 * operation is one transaction over all of them. No method takes an `organizationId`: the tenant is
 * the scope the caller opened through `UnitOfWorkPort` (`rules/tenancy-rls.mdc`, 9).
 */

/** What the decision needs about the subject, read once, inside the transaction that writes. */
export interface UserLifecycleRow {
  readonly userId: string;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
  /**
   * `organizations.owner_id` of the tenant, carried here rather than fetched separately.
   *
   * The owner rule compares two values that must be read in one moment: an organization whose
   * ownership was transferred between the two reads would let the previous owner be deactivated on
   * the strength of a fact that had already stopped being true.
   */
  readonly organizationOwnerId: string;
}

/**
 * One membership a suspension removed — and the only record that it existed.
 *
 * `team_members` has no `deleted_at`: the row is deleted outright, and `team_role` (`LEAD` or
 * `MEMBER`) goes with it. Reactivation deliberately does not bring memberships back, so the person
 * who decides to grant them again tomorrow needs a source for **what** to grant — and a counter is
 * not one. Carried out of the repository so the trail can hold it; short of that, the only way back
 * from a mistaken offboarding is restoring the database.
 *
 * Not personal data and not a secret: it is a team id and a role, already visible to anybody who can
 * read the audit trail (`rules/observability.mdc`, 16).
 */
export interface LeftTeamMembership {
  readonly teamId: string;
  /** `MEMBER` | `LEAD`, as `ck_team_members_role` constrains it. Text, like the column. */
  readonly teamRole: string;
}

export interface UserLifecycleRepositoryPort {
  /** `null` when the account is not in this organization — answered 404, never 403. */
  byId(userId: string): Promise<UserLifecycleRow | null>;

  /**
   * Switches the account off and reports what that cost, in one statement per table.
   *
   * `permissions_version` is incremented here rather than by a separate call, because it is what
   * makes every access token of this person stale — and a bump issued after the status change, in
   * its own statement, is a window in which a live token still answers.
   *
   * The personnel record gets `terminated_at`; an account with no record yet gets none, and that is
   * not a failure — somebody who accepted an invitation this morning has nothing to terminate.
   *
   * Answers **which** memberships were removed rather than how many: the count is `length`, and the
   * rows are gone. See `LeftTeamMembership`.
   */
  suspend(userId: string, at: Date): Promise<readonly LeftTeamMembership[]>;

  /**
   * Brings the account back: `ACTIVE`, no termination date, one more version.
   *
   * **Restores nothing else.** Teams, projects and vault memberships were left on the way out and
   * stay left — see `ReactivateUserUseCase` for why that is a decision rather than an omission.
   *
   * `void`, not `boolean`. It used to answer a constant `true` that no caller read — a return value
   * that means nothing is worse than none, because a test can pin it and look like it checked
   * something. «Was there a row» is not a question this method can answer usefully either: the
   * account was read inside the same transaction two statements ago.
   */
  reactivate(userId: string): Promise<void>;
}
