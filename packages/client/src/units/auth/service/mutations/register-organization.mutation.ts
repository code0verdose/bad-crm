import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { registerOrganization, type OrganizationRegistration } from '@units/auth/api';
import { adoptSession, emitAuthEvent } from '@units/auth/lib';
import { authSession } from '@units/auth/service/stores';
import { type SessionIdentity } from '@units/auth/types';

/**
 * Creates the first organization of an installation and signs the tab in as its owner —
 * pessimistically, because there is nothing to show optimistically: the answer *is* the session
 * (`rules/tanstack-query.mdc` §7).
 *
 * The answer is taken apart **inside `mutationFn`**, for the reason `login.mutation.ts` states at
 * length: resolved unchanged, an `AuthenticatedSession` is what TanStack Query keeps in its
 * `MutationCache`, and that cache is reachable from `self.__TSR_ROUTER__`. `adoptSession` puts the
 * access token in memory and hands back an identity without it — one path into memory, one place to
 * read it from.
 *
 * `gcTime: 0` because the **arguments** are a plaintext password, exactly as on sign-in and on
 * invitation acceptance: `state.variables` would otherwise outlive the screen by the whole window.
 *
 * The order inside `onSuccess` is the order every other door into a session uses: the store first,
 * so a guard reading it in the next microtask already sees the session, and the bus second, because
 * announcing first would re-check the guards against a session that is not there yet.
 *
 * **The local `onError` is deliberate, and it is what makes a refusal one signal rather than two.**
 * The registration screen renders all three of its refusals itself: a taken slug goes under the slug
 * field (`rules/errors-and-toasts.mdc` §4), a closed installation replaces the form, and anything
 * else becomes the notice above the fields. A toast in the corner on top of any of them is the
 * duplicate §2–§3 exist to prevent — and on this screen it would be the worse half of the pair,
 * because the person is looking at a five-field form and needs to know *which* field to fix.
 * `logError` still runs: the fabric logs every failure whoever else handles it
 * (`rules/tanstack-query.mdc` §10).
 */
export const useRegisterOrganizationMutation = (): UseMutationResult<
  SessionIdentity | null,
  Error,
  OrganizationRegistration
> =>
  useMutation({
    gcTime: 0,

    mutationFn: async (registration: OrganizationRegistration) =>
      adoptSession(await registerOrganization(registration)),

    onSuccess: (identity) => {
      if (identity === null) return;

      authSession.start(identity);
      emitAuthEvent('logged-in');
    },

    onError: () => undefined,
  });
