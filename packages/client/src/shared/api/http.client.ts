import createFetchClient, { type Client, type ClientOptions, type Middleware } from 'openapi-fetch';
import createQueryHooks from 'openapi-react-query';

import { clientEnv } from '@shared/config';

// `import type`, not an inline type import: the target is a declaration file with no runtime module
// behind it, and `verbatimModuleSyntax` would emit the side-effect import for the latter.
import type { paths } from './schemas/api-schema.js';

/** The typed client, addressed by the paths of `docs/api/openapi.yaml`. */
export type ApiClient = Client<paths>;

/** Re-exported so that a unit can compose a middleware without importing the vendor itself. */
export type ApiMiddleware = Middleware;

export interface ApiClientOptions {
  readonly baseUrl: string;
  /** Injected by tests; production uses the platform transport. */
  readonly fetch?: ClientOptions['fetch'];
}

/**
 * The configured base, made absolute against the current origin.
 *
 * `VITE_API_BASE_URL` is a same-origin path by default and `clientEnv` guarantees it is either that
 * or an absolute URL (`shared/config/env.schema.ts`). A browser resolves the relative form against
 * the document, but `openapi-fetch` builds a `Request`, and a `Request` outside a document refuses
 * one outright — which is why the resolution a browser would do implicitly is done here explicitly.
 * Same bytes on the wire, and the client behaves the same under the test runner as in a tab.
 */
const absoluteBaseUrl = (baseUrl: string): string => {
  const origin = globalThis.location?.origin;

  return baseUrl.startsWith('/') && origin !== undefined ? `${origin}${baseUrl}` : baseUrl;
};

/**
 * The only door to the API (`rules/api-contract.mdc` §3).
 *
 * Everything is typed off the generated schema, so a path the contract does not publish, a query
 * parameter an operation never declared or a body of the wrong shape is a compile error rather than
 * a 400 in production. ESLint keeps the door shut from the other side: `fetch` and `XMLHttpRequest`
 * are banned everywhere but this directory.
 *
 * `credentials: 'include'` is not decoration. The refresh token lives in an httpOnly cookie scoped
 * to `/api/v1/auth`; a deployment that serves the SPA from a different origin than the API would
 * otherwise be unable to refresh at all, and every session would end after fifteen minutes.
 */
export const createApiClient = (options: ApiClientOptions): ApiClient =>
  createFetchClient<paths>({
    baseUrl: absoluteBaseUrl(options.baseUrl),
    credentials: 'include',
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

/**
 * The instance the application uses, pointed at the base URL of this installation.
 *
 * Middleware is attached by the composition root rather than here: the auth middleware needs the
 * token storage and the event bus of `units/auth`, and `shared` must not import a unit.
 */
export const apiClient = createApiClient({ baseUrl: clientEnv.VITE_API_BASE_URL });

/**
 * TanStack Query bindings over the same typed client — what the `queries` and `mutations` segments
 * of a unit build their hooks on, so that a hook is typed by the contract rather than by a
 * hand-written response interface.
 */
export const $api = createQueryHooks(apiClient);
