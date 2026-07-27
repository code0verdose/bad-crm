import { z } from 'zod';

/**
 * `GET /api/v1/meta` declares no query parameters — and rejects the ones it was not given.
 *
 * `strictObject` rather than an omitted schema: an endpoint that silently ignores unknown query
 * parameters is how a client ships `?perPage=50` against an operation that paginates with
 * `?limit=`, gets 200 and the first page every time, and finds out in production. The same
 * reasoning is why input schemas in `docs/api/openapi.yaml` carry `additionalProperties: false`.
 *
 * It is also the smallest possible demonstration of the shape every later validator has: a schema
 * per source, in `presentation/http/validators/`, consumed by `validate()` and nowhere else.
 */
export const metaQuerySchema = z.strictObject({});

export type MetaQuery = z.output<typeof metaQuerySchema>;
