/**
 * The version of the product API this process serves, and the URL prefix it lives under.
 *
 * One constant, because the string appears in three places that must never disagree: the paths in
 * the route registry, the `servers` entry of `docs/api/openapi.yaml`, and the `apiVersion` field a
 * client reads from `GET /api/v1/meta` to decide whether it is talking to a server it understands.
 *
 * A breaking change does not edit this value — it adds `/api/v2` alongside, with `v1` kept for at
 * least one minor release (stack.md, «Версионирование»).
 */
export const API_VERSION = 'v1';

export const API_PREFIX = `/api/${API_VERSION}`;
