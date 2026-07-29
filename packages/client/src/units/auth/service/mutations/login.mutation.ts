import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { login, type LoginCredentials, type LoginResult } from '@units/auth/api';
import { adoptSession, emitAuthEvent } from '@units/auth/lib';
import { authSession } from '@units/auth/service/stores';
import { type SessionIdentity } from '@units/auth/types';

/**
 * What the sign-in resolves to — deliberately not what the server answered.
 *
 * `status` is the branch the form renders on; `identity` is who was signed in, or `null` when the
 * answer carried no session — a choice of organization, or one this client could not read. There is
 * no third field, and the absence is the whole point.
 */
export interface LoginOutcome {
  readonly status: LoginResult['status'];
  readonly identity: SessionIdentity | null;
}

/**
 * The answer is taken apart inside `mutationFn`, and only the outcome comes back out.
 *
 * `POST /auth/login` answers with an `AuthenticatedSession`, access token included. Resolved
 * unchanged, that object is what TanStack Query keeps in the `MutationCache` — for the five minutes
 * of the default `gcTime`, and for as long as an observer stays mounted. The cache is not a private
 * corner either: the `QueryClient` travels in the router context, and `@tanstack/router-core`
 * assigns `self.__TSR_ROUTER__ = this` for every router built in a document, under no development
 * flag. The walk from there is three property reads, and it ends on the credential that
 * authenticates every request of this tab.
 *
 * It is not the worst a script with that reach could do — it could ask for a rotation itself, the
 * refresh cookie travels on its own — but CLAUDE.md invariant 3 names the places a token may not be,
 * and «в query-кеше» and «в состоянии роутера» are two of them. The boundary is the right place to
 * hold it: mapping here means no reader has to remember, and a screen added later that inspects the
 * mutation finds nothing to leak.
 *
 * `adoptSession` does the taking apart — the same function the rotation uses, so the token reaches
 * memory by exactly one path — and it is called here rather than in `onSuccess` because this is the
 * last moment the raw answer exists.
 */
const adoptLoginResult = (result: LoginResult): LoginOutcome => ({
  status: result.status,
  identity: result.status === 'authenticated' ? adoptSession(result) : null,
});

/**
 * Exchanges credentials for a session, and tells the rest of the application exactly once.
 *
 * Three things happen on the way in, in this order for a reason. `adoptSession` puts the access
 * token in memory and hands back an identity that does not contain it; the store records who is
 * signed in, so a guard reading it in the next microtask already sees a session; and only then does
 * the bus announce `logged-in`, which is what `app/auth-events.util.ts` turns into
 * `router.invalidate()`. Announcing first would re-check the guards against a session that is not
 * there yet.
 *
 * **No local `onError`, deliberately.** A refused sign-in is a failed operation, and the single
 * source of that signal is the global `MutationCache.onError`, which turns the `code` of the
 * `problem+json` into one red toast (`rules/errors-and-toasts.mdc` §3, `rules/tanstack-query.mdc`
 * §10). Handling it here would *replace* that toast; handling it here *as well* is the duplicate
 * the rule exists to prevent. What the form owns is the other half — an address that is not an
 * address — and that goes inline, under the field.
 *
 * The cache is not cleared here. Signing in happens from an anonymous tab, whose cache is either
 * empty or was cleared by the sign-out that preceded it (`app/auth-events.util.ts`); clearing it
 * mid-mutation would also throw away the mutation that is still settling.
 */
export const useLoginMutation = (): UseMutationResult<LoginOutcome, Error, LoginCredentials> =>
  useMutation({
    // The answer is taken apart above so the access token never reaches the cache; `gcTime: 0` is the
    // same rule applied to the *arguments*, which are an address and a password. `state.variables`
    // outlives the screen by the whole `gcTime` and is reachable through `self.__TSR_ROUTER__` exactly
    // like `state.data` — stripping one and keeping the other secures the cheaper of the two.
    gcTime: 0,

    mutationFn: async (credentials: LoginCredentials) => adoptLoginResult(await login(credentials)),

    onSuccess: (outcome) => {
      if (outcome.identity === null) return;

      authSession.start(outcome.identity);
      emitAuthEvent('logged-in');
    },
  });
