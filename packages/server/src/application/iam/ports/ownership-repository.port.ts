/**
 * Who the organization belongs to, and the one operation that changes it.
 *
 * Its own port because the transfer is a **single** write across four tables — the tenant root, two
 * role assignments and two version counters — and the invariant it protects is «an organization
 * always has exactly one owner». Split across granular calls, a failure between them leaves an
 * installation nobody can administer, which is the state this whole story exists to make
 * unreachable.
 *
 * No method takes an `organizationId`: the tenant is the scope the caller opened (`rules/tenancy-rls.mdc`, 9).
 */

/** The account the organization would be handed to. `null` when it is not in this tenant. */
export interface TransferCandidate {
  readonly userId: string;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
}

export interface OwnershipTransfer {
  readonly fromUserId: string;
  readonly toUserId: string;
  /**
   * What the previous owner is left holding.
   *
   * Never nothing: an organization whose founder hands it over and is left unable to open the
   * administration screen has traded one broken state for another. Hence the default at the edge
   * (`admin`) rather than an optional field: an omitted role must not mean «no role». The screen
   * that will offer this choice is deferred with STORY-012-06, so today the default is what every
   * API caller gets unless they say otherwise.
   */
  readonly previousOwnerRoleKey: string;
}

export interface OwnershipRepositoryPort {
  /** `organizations.owner_id` of the current scope. */
  currentOwnerId(): Promise<string | null>;

  candidate(userId: string): Promise<TransferCandidate | null>;

  /**
   * Hands the organization over — roles swapped, root repointed, both versions bumped, at once.
   *
   * Both versions matter and for different reasons: the recipient's because their new authority must
   * apply to their **next** request rather than their next sign-in, and the outgoing owner's because
   * their token still claims an authority they no longer have.
   *
   * **Rejects rather than overwrites when `fromUserId` is no longer the owner.** Two transfers of the
   * same organization can be asked for concurrently — the caller of this method already read
   * `currentOwnerId()` once, but that read is not what makes the write safe. An implementation is
   * required to repoint the tenant root only if the row still names `fromUserId`, and to throw a
   * `stale_version` conflict otherwise, so that of two racing transfers exactly one succeeds and the
   * organization is never left with the `owner` role on two accounts at once.
   */
  transfer(transfer: OwnershipTransfer): Promise<void>;
}
