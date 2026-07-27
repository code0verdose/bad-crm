import { type ApiDescription } from '@/application/platform/use-cases/describe-api.use-case.js';

export interface ApiMetaResponse {
  readonly apiVersion: string;
  readonly serverTime: string;
}

/**
 * Use-case result → the `ApiMeta` schema of `docs/api/openapi.yaml`.
 *
 * The one place the wire shape of this operation is decided, so it is the one place that has to
 * agree with the specification — the same division of labour as `health.serializer.ts`. `Date`
 * becomes an explicit ISO string here rather than being left to `JSON.stringify`, so the format is
 * a decision in the code and not a property of whichever serializer happens to run.
 */
export const serializeApiMeta = (description: ApiDescription): ApiMetaResponse => ({
  apiVersion: description.apiVersion,
  serverTime: description.serverTime.toISOString(),
});
