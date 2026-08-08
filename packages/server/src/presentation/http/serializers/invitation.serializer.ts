import { type InvitationRow } from '@/application/iam/ports/invitation-repository.port.js';
import { type MintedInvitation } from '@/application/iam/use-cases/write-invitation.use-case.js';

/**
 * One invitation on the administration screen.
 *
 * **No token and no digest.** The repository does not even select the column, so there is nothing
 * here to forget to remove; this interface exists to say so where a reader of the API will look.
 *
 * `expiresAt` rather than «expired»: whether a link still works is a comparison with the clock, and
 * a boolean computed here would be stale by the time the screen renders it.
 */
export interface InvitationResponse {
  readonly id: string;
  readonly email: string;
  readonly roleId: string | null;
  readonly teamIds: readonly string[];
  readonly locale: string;
  readonly invitedById: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export const serializeInvitation = (invitation: InvitationRow): InvitationResponse => ({
  id: invitation.id,
  email: invitation.email,
  roleId: invitation.roleId,
  teamIds: [...invitation.teamIds],
  locale: invitation.locale,
  invitedById: invitation.invitedById,
  expiresAt: invitation.expiresAt.toISOString(),
  createdAt: invitation.createdAt.toISOString(),
});

/**
 * The answer to creating or re-issuing one — the **only** time the link is ever shown.
 *
 * It is here rather than on the row for the reason the column is a digest: the server cannot
 * produce this URL again, and a screen that lost it has to re-issue rather than look it up.
 *
 * `mailDispatched: false` is not a failure. It means this installation has no relay (NFR-9), the
 * invitation exists, and the interface has to show the link with a warning instead of pretending a
 * letter is on its way.
 */
export interface MintedInvitationResponse {
  readonly id: string;
  readonly email: string;
  readonly inviteUrl: string;
  readonly expiresAt: string;
  readonly mailDispatched: boolean;
}

export const serializeMintedInvitation = (minted: MintedInvitation): MintedInvitationResponse => ({
  id: minted.invitationId,
  email: minted.email,
  inviteUrl: minted.inviteUrl,
  expiresAt: minted.expiresAt.toISOString(),
  mailDispatched: minted.mailDispatched,
});
