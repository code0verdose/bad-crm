import { createApiClient, type ApiClientOptions } from './http.client.js';

export type SessionRefresherOptions = ApiClientOptions;

/**
 * The configured base, made absolute against the current origin.
 *
 * `VITE_API_BASE_URL` is a same-origin path by default and `clientEnv` guarantees it is either that
 * or an absolute URL (`shared/config/env.schema.ts`). The typed client turns a call into a
 * `Request`, and `Request` will not accept a relative URL outside a document — so the resolution a
 * browser would do implicitly is done here explicitly, which also makes this module behave the same
 * under the test runner as it does in a tab.
 */
const absoluteBaseUrl = (baseUrl: string): string => {
  const origin = globalThis.location?.origin;

  return baseUrl.startsWith('/') && origin !== undefined ? `${origin}${baseUrl}` : baseUrl;
};

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
 * Nothing is read from the answer but the access token. The refresh token itself never appears here:
 * it lives in an httpOnly cookie scoped to `/api/v1/auth`, which `credentials: 'include'` sends and
 * no script in this bundle can read (CLAUDE.md, «Чувствительность данных»).
 */
export const createSessionRefresher = (
  options: SessionRefresherOptions,
): (() => Promise<string | null>) => {
  const client = createApiClient({ ...options, baseUrl: absoluteBaseUrl(options.baseUrl) });

  return async () => {
    try {
      const { data } = await client.POST('/auth/refresh', {});

      return typeof data?.accessToken === 'string' ? data.accessToken : null;
    } catch {
      // Every failure means the same thing to the caller — there is no session to continue. The
      // distinction between "refused", "unparsable" and "offline" belongs to a log, not to a branch
      // in the middleware that awaits this.
      return null;
    }
  };
};
