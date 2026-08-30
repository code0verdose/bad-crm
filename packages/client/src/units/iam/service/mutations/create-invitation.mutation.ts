import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { createInvitation, type InvitationDraft, type MintedInvitation } from '@units/iam/api';
import { QueryKeys } from '@shared/lib';

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
 * **The list is invalidated**, because there now is one: `/admin/members/invitations`
 * (STORY-012-08) reads `QueryKeys.Invitations`, and an invitation created in one tab has to be on
 * it. The comment that used to stand here said the screen was STORY-012-04's; it was not — that
 * story is the directory of *accounts*, and an invitation is not one.
 */
export const useCreateInvitation = (): UseMutationResult<
  MintedInvitation,
  Error,
  InvitationDraft
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: InvitationDraft) => createInvitation(draft),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Invitations.all });
    },

    // The answer carries `inviteUrl` — the single-use link that is the *whole* credential for
    // creating an account in this organization, and the only time it is ever shown. Without this it
    // stays in the `MutationCache` for the default five minutes after the screen unmounts, reachable
    // from `self.__TSR_ROUTER__` by anything running on the page. Every other mutation that carries
    // a secret — in its answer or in its arguments — sets it for the same reason; this said «the
    // three other mutations», which was right at `349a10b` and is not now (2026-08-30). What they
    // are: `grep -rln 'gcTime: 0' packages/client/src/units/*/service/mutations/*.ts`.
    gcTime: 0,
  });
};
