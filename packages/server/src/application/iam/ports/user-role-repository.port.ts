import { type SharedPermissions } from '@bad-crm/shared';

/**
 * Who holds which role, inside the tenant the caller opened.
 *
 * No method takes an `organizationId`, for the reason `role-repository.port.ts` states: the tenant is
 * the scope, and a parameter beside it is a second answer to the same question — one the policy does
 * not refuse but silently filters, turning a mismatch into an empty result.
 *
 * Every read here is made **inside the transaction that will act on it**. The counts and sets below
 * decide whether an organization keeps an owner and whether somebody keeps a way back in, and a
 * decision made against a state read before the transaction is a decision two concurrent requests
 * can both make.
 */

export interface RoleFacts {
  readonly roleId: string;
  readonly key: string;
  /** Everything the role grants; the subset rule cannot be checked against a count. */
  readonly permissions: readonly SharedPermissions.PermissionKey[];
}

export interface AssignmentDraft {
  readonly userId: string;
  readonly roleId: string;
  readonly grantedById: string | null;
  readonly expiresAt: Date | null;
}

export interface AssignmentResult {
  /** `false` when the person already held the role: the same assignment, not a second one. */
  readonly created: boolean;
}

export interface UserRoleRepositoryPort {
  /**
   * The role and what it grants, or `null` when it does not exist **in this organization** — which
   * the caller answers 404 to, never 403.
   */
  roleFacts(roleId: string): Promise<RoleFacts | null>;

  /** Role ids the person holds right now, expired grants excluded. */
  roleIdsOf(userId: string): Promise<readonly string[]>;

  /** Whether the person exists in this organization at all; `null` means «not here», i.e. 404. */
  userExists(userId: string): Promise<boolean>;

  /**
   * How many people hold the role with this key, optionally ignoring one of them.
   *
   * `excludingUserId` is how «how many owners would be left» is asked without arithmetic at the call
   * site: the query answers about the state after the change, inside the transaction that makes it.
   */
  countHoldersOfKey(key: string, excludingUserId?: string): Promise<number>;

  /** Idempotent: assigning a role somebody already holds changes nothing and reports `created: false`. */
  assign(draft: AssignmentDraft): Promise<AssignmentResult>;

  /** `false` when there was nothing to remove — the same end state, and not an error. */
  revoke(userId: string, roleId: string): Promise<boolean>;

  /**
   * Invalidates every cached permission view of this person.
   *
   * The counter travels in the access token, so a change of roles takes effect on the **next
   * request** rather than on the next sign-in. It is bumped in the same transaction as the change:
   * bumped after, a request in flight can still be answered with the old rights and no trace of why.
   */
  bumpPermissionsVersion(userId: string): Promise<void>;
}
