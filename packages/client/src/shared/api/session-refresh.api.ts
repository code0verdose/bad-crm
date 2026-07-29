import { createApiClient, type ApiClientOptions } from './http.client.js';
import type { components } from './schemas/api-schema.js';

export type SessionRefresherOptions = ApiClientOptions;

/**
 * What a rotation answers with, exactly as `docs/api/openapi.yaml` publishes it: the access token
 * for the next fifteen minutes, and who it belongs to.
 *
 * Named here rather than deep in the generated schema so that a unit can take the answer apart
 * without importing `components['schemas'][…]` by hand. The refresh token is not part of it and
 * never will be — it is a `Set-Cookie` the browser keeps and no script in this bundle can read.
 */
export type RefreshedSession = components['schemas']['AuthenticatedSession'];

/** The one status that ends a session rather than postponing it. */
const HTTP_UNAUTHORIZED = 401;

/**
 * The three things a rotation can tell the caller apart — and they are three, not two.
 *
 * `refused` is the server declining the presented cookie: the session is over and the tab has to
 * sign in again. `unavailable` is everything that is not an answer about the session — `5xx`, a
 * dropped connection, a body that does not match the contract. The distinction exists because the
 * two demand opposite handling: one clears the session, the other must leave it exactly as it was.
 */
export type RefreshOutcome =
  | { readonly kind: 'session'; readonly session: RefreshedSession }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unavailable' };

/**
 * Exchanges the httpOnly refresh cookie for a fresh access token.
 *
 * Made through a **second** client, built here and deliberately given no middleware. That is the
 * permanent half of what used to be a hand-written `fetch`: the refresh must not travel through the
 * client that carries the auth middleware, because a refused refresh is a 401 and a 401 is what
 * starts a refresh. A dedicated instance is cheaper than a flag threaded through every call site,
 * and it cannot be switched off by accident.
 *
 * The temporary half is gone. `POST /auth/refresh` is published in `docs/api/openapi.yaml`
 * (EPIC-006), so the typed client can address it and the exception in `rules/api-contract.mdc` that
 * allowed a raw `fetch` in this one module has nothing left to stand on — a wrong path or a wrong
 * method here is a compile error now, like everywhere else in the client.
 *
 * The refresh token itself never appears here: it lives in an httpOnly cookie scoped to
 * `/api/v1/auth`, which `credentials: 'include'` sends and no script in this bundle can read
 * (CLAUDE.md, «Чувствительность данных»).
 *
 * The whole session is handed back rather than only the token, because a rotation is also how a
 * reloaded tab learns *who* it is: without the identity the shell would have to ask a second
 * endpoint for something the first answer already carried. Taking it apart — token to memory,
 * identity to the state — is `units/auth`'s job, not the transport's.
 *
 * An answer that carries no `accessToken` is not a session, whatever its status line said.
 */
export const createSessionRefresher = (
  options: SessionRefresherOptions,
): (() => Promise<RefreshOutcome>) => {
  const client = createApiClient(options);

  return async () => {
    try {
      const { data, response } = await client.POST('/auth/refresh', {});

      if (typeof data?.accessToken === 'string') return { kind: 'session', session: data };

      // `401` is the only answer that ends a session: it says the cookie just presented will never
      // work again. Everything else is «ask again later».
      //
      // The earlier version of this function returned `null` for all of them, on the reasoning that
      // the caller cannot act on the difference. It can, and the cost of not doing so is concrete:
      // the server answers `5xx` rather than `401` on an infrastructure failure *specifically* so a
      // brief database outage stops signing everyone out, and collapsing it here reintroduced that
      // incident one layer up. A `docker compose up -d` from the upgrade runbook is enough.
      //
      // A `2xx` whose body is not the promised shape lands here too, and deliberately: it is a
      // contract violation, which is evidence about the deployment and no evidence at all about
      // whether this person is still signed in.
      return response.status === HTTP_UNAUTHORIZED ? { kind: 'refused' } : { kind: 'unavailable' };
    } catch {
      // Thrown, not answered: a dropped connection, DNS, a blocked request. Nothing about the
      // session is known, so nothing about it is claimed.
      return { kind: 'unavailable' };
    }
  };
};
