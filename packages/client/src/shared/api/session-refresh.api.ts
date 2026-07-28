/** The platform transport, injectable so that no test in this repository reaches the network. */
export type FetchLike = typeof globalThis.fetch;

export interface SessionRefresherOptions {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
}

/**
 * The one call in this client that does not go through the typed client, for two reasons.
 *
 * The first is temporary and is a gap, not a decision: `POST /auth/refresh` is not in
 * `docs/api/openapi.yaml`. The contract publishes `GET /meta` and nothing else so far — the auth
 * operations arrive with EPIC-006 — and `openapi-fetch` cannot address a path the contract does not
 * declare. `shared/api` is the one directory where a raw `fetch` is allowed to exist
 * (`rules/api-contract.mdc`, «Исключения»), and this is what that exception is for. When the
 * operation is published, this module becomes a call on `apiClient` and nothing else changes.
 *
 * The second is permanent: the refresh must not travel through the client that carries the auth
 * middleware. A refused refresh would be a 401, and a 401 triggers a refresh.
 *
 * Nothing is read from the response but the access token. The refresh token itself never appears
 * here — it lives in an httpOnly cookie scoped to `/api/v1/auth`, which `credentials: 'include'`
 * sends and no script in this bundle can read (CLAUDE.md invariant 3).
 */
export const createSessionRefresher = (
  options: SessionRefresherOptions,
): (() => Promise<string | null>) => {
  const transport = options.fetch ?? fetch;

  return async () => {
    try {
      const response = await transport(`${options.baseUrl}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) return null;

      const body = (await response.json()) as { accessToken?: unknown };

      return typeof body.accessToken === 'string' ? body.accessToken : null;
    } catch {
      // Every failure means the same thing to the caller — there is no session to continue. The
      // distinction between "refused", "unparsable" and "offline" belongs to a log, not to a branch
      // in the middleware that awaits this.
      return null;
    }
  };
};
