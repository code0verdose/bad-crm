import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { login, type LoginCredentials, type LoginResult } from '@units/auth/api';
import {
  adoptSession,
  clearMfaToken,
  emitAuthEvent,
  type LoginAttempt,
  setMfaToken,
} from '@units/auth/lib';
import { authSession } from '@units/auth/service/stores';
import { type SessionIdentity } from '@units/auth/types';

/**
 * What the sign-in resolves to — deliberately not what the server answered.
 *
 * `status` is the branch the form renders on; `identity` is who was signed in, or `null` when the
 * answer carried no session — a choice of organization, a second factor still owed, or an answer
 * this client could not read.
 *
 * `secondFactorExpiresAt` is the one thing the second step needs that is safe to keep: the instant
 * the intermediate token dies, in epoch milliseconds, so the step can count down to it. The token
 * itself is **not** here and never will be — it goes to `lib/mfa-token-storage.util.ts` for the
 * reason the docstring below gives about the access token, which applies word for word to a
 * credential that buys a session in one more request.
 *
 * An instant rather than the `expiresIn` seconds the contract reports: a duration cannot be wrong
 * about the reader's clock, which is why the server sends one, and a countdown cannot be right
 * without a fixed end, which is why it is turned into one here — once, at the moment the answer
 * arrived, rather than on every render.
 */
export interface LoginOutcome {
  readonly status: LoginResult['status'];
  readonly identity: SessionIdentity | null;
  readonly secondFactorExpiresAt: number | null;
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
 *
 * **The `mfa_required` answer is treated exactly the same way, and for exactly the same reason.**
 * Its `mfaToken` is not a session token — it is refused everywhere but `POST /auth/2fa/verify` — but
 * it plus one code *is* a session, so it goes to `lib/mfa-token-storage.util.ts` and what comes back
 * out is a deadline. A screen that later inspected this mutation would find a number and a status,
 * which is all a screen has any business finding (STORY-013-03, acceptance 1 and 11).
 */
const adoptLoginResult = (result: LoginResult): LoginOutcome => {
  if (result.status === 'mfa_required') {
    setMfaToken(result.mfaToken);

    return {
      status: result.status,
      identity: null,
      secondFactorExpiresAt: Date.now() + result.expiresIn * 1_000,
    };
  }

  return {
    status: result.status,
    identity: result.status === 'authenticated' ? adoptSession(result) : null,
    secondFactorExpiresAt: null,
  };
};

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
export const useLoginMutation = (): UseMutationResult<LoginOutcome, Error, LoginAttempt> =>
  useMutation({
    // The answer is taken apart above so the access token never reaches the cache. `state.variables`
    // is reachable through `self.__TSR_ROUTER__` exactly like `state.data`, so the *arguments* get
    // the same treatment — but by never carrying the password, not by `gcTime`. `gcTime: 0` is kept
    // because it disposes of the entry the moment nothing watches it; on its own it was not enough,
    // since the second-factor step keeps an observer mounted while the password sat in `variables`
    // (`lib/login-attempt.util.ts` tells that story in full).
    gcTime: 0,

    mutationFn: async (attempt: LoginAttempt) => {
      const password = attempt.takePassword();

      if (password === null) {
        // Not a retry: mutations here are not retried. Two reads mean two callers thought they owned
        // this attempt, and re-sending a spent password would hide that rather than surface it.
        throw new Error('login attempt has already been spent');
      }

      const credentials: LoginCredentials = { email: attempt.email, password };

      // Sending a password ends whatever step was in progress, whichever way this request goes: the
      // answer supersedes it, and a refusal leaves nobody on a screen that could spend it. Clearing
      // before the request rather than after means there is no window in which a token nothing owns
      // is still readable — including the window a failed request would otherwise leave open for
      // good.
      clearMfaToken();

      return adoptLoginResult(await login(credentials));
    },

    onSuccess: (outcome) => {
      if (outcome.identity === null) return;

      authSession.start(outcome.identity);
      emitAuthEvent('logged-in');
    },
  });
