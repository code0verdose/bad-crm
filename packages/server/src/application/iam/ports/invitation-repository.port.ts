import { type SharedPermissions } from '@bad-crm/shared';

/**
 * Invitations of the current tenant.
 *
 * No method takes an `organizationId`: the tenant is the scope the caller opened through
 * `UnitOfWorkPort`, and a parameter beside it would be a second answer to the same question — one
 * the policy silently overrules, turning a mismatch into an empty result rather than into an error
 * (`rules/tenancy-rls.mdc`, 9).
 */

/** What an invitation will hand out once it is accepted. */
export interface InvitationDraftRow {
  readonly email: string;
  readonly roleId: string | null;
  readonly teamIds: readonly string[];
  readonly tokenHash: Uint8Array;
  readonly invitedById: string;
  readonly expiresAt: Date;
}

/** An invitation as the administration screen and the policies read it. */
export interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly roleId: string | null;
  readonly teamIds: readonly string[];
  readonly invitedById: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly createdAt: Date;
}

export interface InvitationRepositoryPort {
  /**
   * Stores a new invitation.
   *
   * Rejects a second **open** one for the same address with the conflict the caller reports as
   * `invitation_already_pending`: the partial unique index answers it, because reading first and
   * inserting afterwards is two statements racing each other, and the loser cannot tell its failure
   * apart from success.
   */
  create(draft: InvitationDraftRow): Promise<string>;

  /** `null` when it is not in this organization — answered 404, never 403. */
  byId(invitationId: string): Promise<InvitationRow | null>;

  /**
   * A fresh token on an existing invitation, and a new expiry.
   *
   * The old digest stops working in the same statement that stores the new one: an invitation with
   * two live tokens is a door somebody thinks they closed.
   */
  reissue(invitationId: string, tokenHash: Uint8Array, expiresAt: Date): Promise<boolean>;

  /** Removes it. A revoked invitation is not a row with a flag — the token has to stop working. */
  remove(invitationId: string): Promise<boolean>;

  /** Every open invitation of the organization, newest first. */
  listOpen(): Promise<readonly InvitationRow[]>;

  /** Is there an account on this address already — the conflict that is not about invitations. */
  userExists(email: string): Promise<boolean>;

  /** What the role would grant, for the subset rule. `null` when the role is not in this tenant. */
  rolePermissions(roleId: string): Promise<readonly SharedPermissions.PermissionKey[] | null>;
}
