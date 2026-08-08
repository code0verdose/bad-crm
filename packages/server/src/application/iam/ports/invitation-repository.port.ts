import { type SharedPermissions } from '@bad-crm/shared';

import { type MailLocale } from '@/domain/identity/mail-locale.util.js';

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
  /** The language the letter is written in; the recipient has no account to read one from. */
  readonly locale: MailLocale;
  readonly invitedById: string;
  readonly expiresAt: Date;
}

/** An invitation as the administration screen and the policies read it. */
export interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly roleId: string | null;
  readonly teamIds: readonly string[];
  /** Carried on the row so a resend produces the same letter as the first attempt. */
  readonly locale: MailLocale;
  readonly invitedById: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly createdAt: Date;
}

/** What an invitation hands over at the moment it is spent. */
export interface AcceptedInvitation {
  /** The address the account is created on — from the row, never from the request. */
  readonly email: string;
  readonly roleId: string | null;
  readonly teamIds: readonly string[];
}

/** Who the account being created is, as far as `users` is concerned. */
export interface InvitedAccountDraft {
  readonly email: string;
  /** Already argon2id. A plaintext password never crosses this boundary. */
  readonly passwordHash: string;
  readonly locale: string;
  readonly timezone: string;
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

  /**
   * Spends the invitation: one conditional
   * `UPDATE … WHERE accepted_at IS NULL AND expires_at > $now RETURNING …`.
   *
   * `null` when nothing matched — accepted already, or expired. **Both, and deliberately one
   * answer:** two clicks on the same link race here, and the loser updates no row, where a
   * read-then-write would let both pass under READ COMMITTED and create two accounts. Telling the
   * two apart in the return value would put the distinction back one layer up, where somebody would
   * eventually put it in a response (`T-IAM-03`).
   *
   * The account it names must already exist: `ck_invitations_accepted_pair` requires «accepted» and
   * «accepted by» to move together, and the foreign key on `accepted_user_id` is checked when this
   * statement ends. That is the whole reason the user row is written first — see
   * `AcceptInvitationUseCase`.
   */
  accept(
    invitationId: string,
    acceptedUserId: string,
    now: Date,
  ): Promise<AcceptedInvitation | null>;

  /**
   * Creates the account an invitation produces, `ACTIVE` from the first moment.
   *
   * Not `INVITED`: that status is for a row created **by** the invitation and waiting for its
   * holder, and this product does not create one — an invitation is a token, not an account
   * (`data-model.md` §1). By the time this runs the person has proved they hold the link and has
   * chosen a password, which is everything `ACTIVE` means.
   *
   * Rejects a duplicate address through `uq_users_org_email`, and that is the second guard on
   * single use: two requests that both read a still-open invitation both try to create the same
   * account, and the partial unique index refuses the second.
   */
  createAccount(draft: InvitedAccountDraft): Promise<string>;

  /**
   * Puts the new account into the teams the invitation drafted, skipping any that were deleted while
   * it was open.
   *
   * Skipping rather than failing: `team_ids` is a `uuid[]` with no foreign key — a **draft**, as the
   * column comment says — and a team removed in the meantime is not a reason to refuse somebody
   * their first sign-in. Returns how many memberships were actually written, so the trail can say
   * what happened rather than what was asked for.
   */
  joinTeams(userId: string, teamIds: readonly string[]): Promise<number>;
}
