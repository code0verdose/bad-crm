import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { createInvitation, type InvitationDraft, type MintedInvitation } from '@units/iam/api';

/**
 * Invites somebody — pessimistically, because the answer carries something the client cannot guess.
 *
 * An optimistic row would have to invent the link, and the link is the whole payload: it exists once,
 * in this response, and the server keeps only a digest. So the screen waits, and what comes back is
 * what it shows.
 *
 * **No toast here.** Whether this succeeded well or succeeded without a relay is one sentence with
 * two very different meanings (`mailDispatched`), and the screen says it beside the link the person
 * now has to copy — one signal per action (`rules/errors-and-toasts.mdc` §2). Failures are the
 * global mutation handler's, as everywhere else.
 *
 * Nothing is invalidated: no query in the client holds invitations yet. The screen that lists them
 * has no owning story — STORY-012-04 turned out to be the directory of *accounts* and deliberately
 * left invitations to their own list (`story-012-01`, «Осталось за пределами этой истории»). The key
 * arrives with the read that needs it.
 */
export const useCreateInvitation = (): UseMutationResult<
  MintedInvitation,
  Error,
  InvitationDraft
> =>
  useMutation({
    mutationFn: (draft: InvitationDraft) => createInvitation(draft),
    // The answer carries `inviteUrl` — the single-use link that is the *whole* credential for
    // creating an account in this organization, and the only time it is ever shown. Without this it
    // stays in the `MutationCache` for the default five minutes after the screen unmounts, reachable
    // from `self.__TSR_ROUTER__` by anything running on the page. The three other mutations that
    // carry a secret set it for the same reason.
    gcTime: 0,
  });
