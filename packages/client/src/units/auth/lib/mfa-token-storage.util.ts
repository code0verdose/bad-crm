/**
 * The intermediate credential of a sign-in that is not finished, in memory and nowhere else.
 *
 * `POST /auth/login` answers `{ status: 'mfa_required', mfaToken }` when the account carries a
 * second factor: no access token, no refresh cookie, no session. The token that comes back is not a
 * session token — it is refused on every route but `POST /auth/2fa/verify` and carries no rights —
 * but it is one half of what a session costs, because whoever holds it and one code gets one. It is
 * therefore treated as a credential, and the two places a credential must not be are ruled out here
 * rather than by discipline at the call sites:
 *
 * - **not in a URL.** A query string is written to the access log of every proxy in front of the
 *   installation, handed to the next origin in `Referer`, and is the part of a URL people paste
 *   into support tickets (`docs/security/threat-model.md`, T-IAM-07). Nothing in this module can
 *   put it there, and the step it belongs to has no route of its own for it to travel in.
 * - **not in Web Storage.** `localStorage` and `sessionStorage` survive a tab close and are
 *   readable by any script that lands on the page (CLAUDE.md, invariant 3). A module variable dies
 *   with the tab, which is longer than this token's five minutes and shorter than everything else.
 *
 * It is also kept out of the TanStack `MutationCache`, which is not this module's doing but the
 * reason this module exists: whatever `mutationFn` resolves to is held in the cache, the
 * `QueryClient` travels in the router context, and `@tanstack/router-core` assigns
 * `self.__TSR_ROUTER__ = this` for every router built in a document. So `login.mutation.ts` takes
 * the answer apart and routes the token here, exactly as it already routes the access token to
 * `auth-token-storage.util.ts` — the same shape of fix, for the same reason, one file over.
 *
 * A module variable rather than a store, on the terms `rules/frontend-fsd.mdc` rule 16 sets for the
 * access token: nothing renders from it. What the screen renders from is the deadline, which is a
 * number and travels in the outcome; this value exists for one request, on one code path.
 */
let mfaToken: string | null = null;

export const setMfaToken = (token: string): void => {
  mfaToken = token;
};

export const clearMfaToken = (): void => {
  mfaToken = null;
};

/**
 * The token, or an exception — never an empty string.
 *
 * Reading with no step in progress is a bug in the caller rather than a state to render: the second
 * factor is only on screen while the answer that minted a token is the answer being shown. An empty
 * string would be *sent*, and the refusal it earned would read like a wrong code.
 */
export const readMfaToken = (): string => {
  if (mfaToken === null) {
    throw new Error('no second factor is in progress: nothing minted an mfaToken');
  }

  return mfaToken;
};
