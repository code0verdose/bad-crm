import { type Middleware } from 'openapi-fetch';

/**
 * Marks a request that is already the replay of a refused one.
 *
 * Two readers. The server, which can tell a replay from a first attempt in its logs; and this
 * middleware, which refuses to refresh for a request that arrives carrying the marker — a caller
 * replaying a request by hand must not be able to start a refresh cycle.
 */
export const AUTH_RETRY_HEADER = 'X-Auth-Retry';

const HTTP_UNAUTHORIZED = 401;

export interface AuthMiddlewareDeps {
  /** The access token of this tab, from memory. Never from Web Storage — CLAUDE.md invariant 3. */
  readonly readAccessToken: () => string | null;
  /** Exchanges the httpOnly refresh cookie for a new access token, or answers `null`. */
  readonly refreshSession: () => Promise<string | null>;
  /** Announces that the session is over. This layer must not know what happens next. */
  readonly onSessionLost: () => void;
}

/**
 * Bearer credentials on the way out, one refresh and one replay on the way back.
 *
 * The deduplication is the point. Three requests in flight against an expired token produce three
 * 401s within a few milliseconds of each other; without a shared promise each starts its own
 * `POST /auth/refresh`. The refresh token rotates on every use, so the second and third arrive with
 * a token that has just been spent — reuse detection fires, the whole family is revoked, and a
 * legitimate user is signed out of every device by a security response working exactly as designed.
 * The failure is not a duplicated request.
 *
 * The dependencies are injected rather than imported because `shared` carries no domain knowledge
 * (`rules/frontend-fsd.mdc` rule 8): where the token lives and who reacts to a lost session belong
 * to `units/auth`, and the navigation that follows belongs to `app/`. An import of the router here
 * would invert the layer direction and make every one of these cases untestable without mounting one.
 */
export const createAuthMiddleware = (deps: AuthMiddlewareDeps): Middleware => {
  /**
   * A pristine copy of each in-flight request, keyed by the id openapi-fetch assigns it.
   *
   * `fetch(request)` consumes the body, so the original can never be sent twice: a replayed `POST`
   * would arrive empty and the server would answer 422 instead of doing the work. The clone is taken
   * before the send, and removed by whichever of `onResponse`/`onError` ends the request.
   */
  const replays = new Map<string, Request>();

  let refreshInFlight: Promise<string | null> | null = null;
  let sessionLost = false;

  const refreshOnce = (): Promise<string | null> => {
    refreshInFlight ??= deps.refreshSession().finally(() => {
      refreshInFlight = null;
    });

    return refreshInFlight;
  };

  return {
    onRequest: ({ request, id }) => {
      const token = deps.readAccessToken();

      if (token !== null) request.headers.set('Authorization', `Bearer ${token}`);
      replays.set(id, request.clone());

      return request;
    },

    onResponse: async ({ request, response, id, options }) => {
      // `onResponse` runs only for a request that passed through `onRequest` of this same
      // middleware: openapi-fetch skips the whole response phase when an earlier middleware
      // short-circuits with a Response. The entry is therefore always the one stored above.
      const replay = replays.get(id) as Request;
      replays.delete(id);

      if (response.status !== HTTP_UNAUTHORIZED) return undefined;
      if (request.headers.has(AUTH_RETRY_HEADER)) return undefined;

      // A refresh that has already failed is terminal until somebody signs in again — the token in
      // memory is the evidence that they did. Without this, a tab left open overnight starts a
      // refresh on every poll of a session it no longer has.
      if (sessionLost && deps.readAccessToken() === null) return undefined;

      const token = await refreshOnce();

      if (token === null) {
        sessionLost = true;
        deps.onSessionLost();

        return undefined;
      }

      sessionLost = false;

      const headers = new Headers(replay.headers);
      headers.set('Authorization', `Bearer ${token}`);
      headers.set(AUTH_RETRY_HEADER, '1');

      return options.fetch(new Request(replay, { headers }));
    },

    onError: ({ id }) => {
      replays.delete(id);
    },
  };
};
