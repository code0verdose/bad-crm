import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { acceptInvitation, type InvitationAcceptance } from '@units/auth/api';
import { adoptSession, emitAuthEvent } from '@units/auth/lib';
import { authSession } from '@units/auth/service/stores';
import { type SessionIdentity } from '@units/auth/types';

/** What the screen needs back: who this now is, or `null` if the answer was not a session. */
export interface AcceptedInvitationOutcome {
  readonly identity: SessionIdentity | null;
}

/**
 * Takes up an invitation: an account appears and this tab is signed in as it.
 *
 * The answer is taken apart **inside `mutationFn`**, for the reason `login.mutation.ts` states at
 * length: resolved unchanged, an `AuthenticatedSession` is what TanStack Query keeps in its
 * `MutationCache`, and the cache is reachable from `self.__TSR_ROUTER__`. `adoptSession` puts the
 * access token in memory and hands back an identity without it — one path into memory, one place to
 * read it from.
 *
 * `gcTime: 0` for the same reason it is zero on sign-in and on password reset: the **arguments**
 * here are a single-use token and a plaintext password, and `state.variables` outlives the screen by
 * the whole window otherwise.
 *
 * **No local `onError`.** Every refusal — `410` for a link that is unknown, revoked, accepted or
 * expired, `422` for a password the policy rejects, `429` — is one red toast from the global
 * `MutationCache.onError` keyed by `code` (`rules/errors-and-toasts.mdc` §3). A second signal here
 * would either replace it or double it.
 */
export const useAcceptInvitation = (): UseMutationResult<
  AcceptedInvitationOutcome,
  Error,
  InvitationAcceptance
> =>
  useMutation({
    gcTime: 0,

    mutationFn: async (acceptance: InvitationAcceptance) => ({
      identity: adoptSession(await acceptInvitation(acceptance)),
    }),

    onSuccess: (outcome) => {
      if (outcome.identity === null) return;

      // The store first, the bus second: a guard reading the store in the next microtask must
      // already see the session, and announcing first would re-check the guards against a session
      // that is not there yet.
      authSession.start(outcome.identity);
      emitAuthEvent('logged-in');
    },
  });
