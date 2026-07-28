/**
 * The transport layer, and the only place in the client where the network physically lives
 * (`rules/frontend-fsd.mdc`, «Исключения»).
 *
 * `api-schema.d.ts` is generated from `docs/api/openapi.yaml` by `pnpm api:gen` and is never edited
 * by hand; everything else here is written against it.
 */
export type * from './schemas/api-schema.js';

export * from './abort.util.js';
export * from './api-result.util.js';
export * from './auth-middleware.util.js';
export * from './error-message-key.util.js';
export * from './http.client.js';
export * from './idempotency-middleware.util.js';
export * from './optimistic.util.js';
export * from './problem.errors.js';
export * from './query-client.config.js';
export * from './session-refresh.api.js';
