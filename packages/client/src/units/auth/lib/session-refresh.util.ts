import { createSessionRefresher, type RefreshOutcome } from '@shared/api';
import { clientEnv } from '@shared/config';
import { type SessionIdentity } from '@units/auth/model';

import { adoptSession } from './adopt-session.util.js';
import { clearAccessToken } from './auth-token-storage.util.js';

export interface SessionRefreshDeps {
  /** One rotation against the API. Injected so the gate below can be tested without a transport. */
  readonly exchange: () => Promise<RefreshOutcome>;
}

/**
 * The rotation as the rest of the unit sees it: an identity, a refusal, or no answer about it.
 *
 * `identity` rather than the whole session, because `adoptSession` has already put the access token
 * in memory by the time this is returned — the token is deliberately not in this shape, so nothing
 * downstream can put it in a store, a cache or a log.
 */
export type SessionRotation =
  | { readonly kind: 'session'; readonly identity: SessionIdentity }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unavailable' };

/**
 * One rotation at a time, for the whole tab.
 *
 * The refresh token rotates on every use: the presented one is marked spent and a new one issued.
 * Present it twice and the server cannot tell a race from a theft, so it assumes theft — the family
 * is revoked, an audit event is written and the user is signed out of every device
 * (`docs/api/openapi.yaml` → `POST /auth/refresh`). The client's job is to make sure only one
 * exchange is ever in flight.
 *
 * `shared/api/auth-middleware.util.ts` already deduplicates the refreshes *it* starts, and that is
 * not enough: the session bootstrap starts one at load, from outside the middleware, at exactly the
 * moment several requests are flying with no access token yet. The gate has to be where both
 * callers meet, which is here — the middleware is wired to this function, and so is the store.
 *
 * The gate opens again once the answer is in. An access token lives fifteen minutes; a tab has to
 * be able to rotate more than once.
 */
export const createSessionRefresh = ({
  exchange,
}: SessionRefreshDeps): (() => Promise<SessionRotation>) => {
  let inFlight: Promise<SessionRotation> | null = null;

  const rotate = async (): Promise<SessionRotation> => {
    const outcome = await exchange();

    // A refusal takes the token with it: the session is over, so a token still sitting in memory is
    // only good for one more rejected request. An `unavailable` rotation deliberately leaves it
    // alone — nothing was learned, so nothing is thrown away, and the next attempt starts from
    // exactly the state this one found.
    if (outcome.kind === 'refused') {
      clearAccessToken();

      return outcome;
    }

    if (outcome.kind === 'unavailable') return outcome;

    const identity = adoptSession(outcome.session);

    // `adoptSession` is the one place the token leaves the answer, and it returns `null` if the
    // payload it is handed is not a session after all. That is a contract violation like any other,
    // so it says «unavailable» rather than «refused» — it is not the server ending the session.
    return identity === null ? { kind: 'unavailable' } : { kind: 'session', identity };
  };

  return () =>
    (inFlight ??= rotate().finally(() => {
      inFlight = null;
    }));
};

/**
 * The instance the application uses.
 *
 * The transport client is built per call rather than once at module load, and the reason is not
 * frugality — it is that `openapi-fetch` captures `globalThis.fetch` when the client is created.
 * Built once here, the module would pin whatever transport existed at import time, which is the
 * difference between a suite that stubs the network and one that quietly reaches it. The object is
 * a closure over a base URL; building it costs nothing.
 */
export const refreshSession = createSessionRefresh({
  exchange: () => createSessionRefresher({ baseUrl: clientEnv.VITE_API_BASE_URL })(),
});
