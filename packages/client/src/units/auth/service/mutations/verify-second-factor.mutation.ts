import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { verifySecondFactor } from '@units/auth/api';
import { adoptSession, clearMfaToken, emitAuthEvent, readMfaToken } from '@units/auth/lib';
import { type TwoFactorFormValues } from '@units/auth/model';
import { authSession } from '@units/auth/service/stores';
import { type SessionIdentity } from '@units/auth/types';

/**
 * Presents the second factor and ends the sign-in — pessimistically, because there is nothing to
 * show optimistically: the answer *is* the session (`rules/tanstack-query.mdc` §7).
 *
 * **The intermediate token is attached here, not passed in.** The variables of this mutation are
 * the one value the person typed; the token comes from `lib/mfa-token-storage.util.ts` at the
 * moment the request is built. That is the whole reason the holder exists: whatever a mutation
 * takes or resolves is kept by the `MutationCache`, the `QueryClient` travels in the router
 * context, and `@tanstack/router-core` assigns `self.__TSR_ROUTER__ = this` for every router built
 * in a document — so a token handed through `mutate({ mfaToken, code })` would be readable by three
 * property reads for as long as anything observed it. `gcTime: 0` is the same rule applied to what
 * remains: the code is a one-time credential too, and nothing of it survives the screen.
 *
 * The order inside `onSuccess` is the order `login.mutation.ts` explains at length and for the same
 * reason: `adoptSession` (inside `mutationFn`, the last moment the raw answer exists) puts the
 * access token in memory and hands back an identity that cannot carry one; the store records who is
 * signed in, so a guard reading it in the next microtask already sees a session; and only then does
 * the bus announce `logged-in`, which is what `app/auth-events.util.ts` turns into
 * `router.invalidate()`. The screen does not navigate — `redirectIfAuthed` on `/login` decides
 * where a session lands, once, for both doors.
 *
 * **The token is forgotten on success and kept on a refusal.** The server spends it in the same
 * step, so the copy here is dead the moment the session exists; a wrong code, on the other hand,
 * leaves it usable for the next of five attempts, and clearing it would mean retyping a password
 * because of a typo.
 *
 * **The local `onError` is deliberate, and it is what makes the refusal one signal rather than
 * two.** `rules/errors-and-toasts.mdc` §4 puts a server's verdict about a field under that field,
 * and here there is exactly one field on the screen: `mfa_invalid_code`, `mfa_code_replayed` and
 * `recovery_code_invalid` are all statements about the code that was just typed. The step renders
 * them beside it, announced (`rules/a11y.mdc` §13); an additional toast in the corner would be the
 * duplicate §2–§3 exist to prevent. This is the same call `disable-totp.mutation.ts` makes, and it
 * differs from the password step above on purpose: `invalid_credentials` is a refusal about two
 * fields at once that deliberately refuses to say which, and belongs nowhere near either of them.
 * `logError` still runs — the fabric logs every failure whoever else handles it
 * (`rules/tanstack-query.mdc` §10).
 */
export const useVerifySecondFactorMutation = (): UseMutationResult<
  SessionIdentity | null,
  Error,
  TwoFactorFormValues
> =>
  useMutation({
    gcTime: 0,

    mutationFn: async ({ code }: TwoFactorFormValues) =>
      adoptSession(await verifySecondFactor({ mfaToken: readMfaToken(), code })),

    onSuccess: (identity) => {
      if (identity === null) return;

      clearMfaToken();
      authSession.start(identity);
      emitAuthEvent('logged-in');
    },

    onError: () => undefined,
  });
