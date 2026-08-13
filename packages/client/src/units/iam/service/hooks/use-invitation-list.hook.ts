import { type Invitation, type MintedInvitation } from '@units/iam/api';
import { isInvitationExpired } from '@units/iam/lib';
import { useResendInvitation } from '@units/iam/service/mutations/resend-invitation.mutation.js';
import { useRevokeInvitation } from '@units/iam/service/mutations/revoke-invitation.mutation.js';
import { useInvitationsQuery } from '@units/iam/service/queries/invitations.query.js';
import { errorMessageKey } from '@shared/api';

/** One row as the screen renders it: the invitation, plus the one fact the contract leaves open. */
export interface OpenInvitation {
  readonly invitation: Invitation;
  /** Compared with the clock **here**, because a flag computed by the server is stale on arrival. */
  readonly isExpired: boolean;
}

/**
 * What one of the two actions is doing right now.
 *
 * No «which row»: both are started from a confirmation that names the row, so the wait belongs to
 * the button inside it and there is never a second one in flight.
 */
export interface InvitationAction {
  readonly isPending: boolean;
  /** The refusal as a sentence key, chosen from the `code` — never from `detail`. */
  readonly failureKey: string | undefined;
  /**
   * Runs it. `onDone` fires only on success, which is how the screen closes a dialog on the
   * operation that has nothing left to show and keeps it open on the one that has.
   *
   * A per-call callback rather than a `isSuccess` flag the caller watches: a flag would have to be
   * cleared before the next open, and «close the dialog when the flag turns true» is the effect
   * `rules/frontend-fsd.mdc` rule 11 exists to prevent.
   */
  readonly run: (invitationId: string, onDone?: () => void) => void;
  readonly reset: () => void;
}

export interface InvitationList {
  readonly status: 'pending' | 'error' | 'success';
  readonly items: readonly OpenInvitation[];
  readonly refetch: () => void;
  readonly resend: InvitationAction;
  /**
   * The link the last re-issue produced — the **only** copy that will ever exist.
   *
   * It lives in the mutation's own result and nowhere else: not in the URL, not in storage, not in
   * a query key. `useResendInvitation` sets `gcTime: 0`, so it goes with the screen.
   */
  readonly minted: MintedInvitation | undefined;
  readonly revoke: InvitationAction;
}

/**
 * The public API of the unit for the invitations screen (`rules/frontend-fsd.mdc` rule 6).
 *
 * It composes the one read and the two writes, and derives the single fact the contract deliberately
 * leaves to the client: whether a row has run out. The screen renders what comes back and decides
 * nothing — which rows exist and in what order is the server's answer, and whether an action is
 * allowed is the server's again; the buttons are hints.
 */
export const useInvitationList = (): InvitationList => {
  const query = useInvitationsQuery();
  const resend = useResendInvitation();
  const revoke = useRevokeInvitation();

  // Read once per render rather than per row, so every row of one paint is judged against the same
  // instant — a list where the first row is expired and the last is not, by a microsecond, is a list
  // nobody can explain.
  const now = new Date();

  return {
    status: statusOf(query),
    items: (query.data ?? []).map((invitation) => ({
      invitation,
      isExpired: isInvitationExpired(invitation.expiresAt, now),
    })),
    refetch: () => {
      void query.refetch();
    },
    resend: {
      isPending: resend.isPending,
      failureKey: resend.error === null ? undefined : errorMessageKey(resend.error),
      run: (invitationId, onDone) => {
        resend.mutate(invitationId, onDone === undefined ? undefined : { onSuccess: onDone });
      },
      reset: () => {
        resend.reset();
      },
    },
    minted: resend.data,
    revoke: {
      isPending: revoke.isPending,
      failureKey: revoke.error === null ? undefined : errorMessageKey(revoke.error),
      run: (invitationId, onDone) => {
        revoke.mutate(invitationId, onDone === undefined ? undefined : { onSuccess: onDone });
      },
      reset: () => {
        revoke.reset();
      },
    },
  };
};

/**
 * The three states `DataState` knows, from the two booleans a query reports.
 *
 * `isPending` rather than `isFetching`: revoking invalidates the list, and a skeleton drawn over
 * rows that are already on screen is a flash after every confirmation.
 */
const statusOf = (query: {
  readonly isPending: boolean;
  readonly isError: boolean;
}): 'pending' | 'error' | 'success' => {
  if (query.isError) return 'error';

  return query.isPending ? 'pending' : 'success';
};
