import { type Middleware } from 'openapi-fetch';

/** `docs/api/openapi.yaml` → `components.parameters.IdempotencyKey`. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * The methods that change something. A read has nothing to replay, and a key on it would only give
 * the server a row to store.
 */
const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const randomIdempotencyKey = (): string => crypto.randomUUID();

/**
 * The header, as the *type* of an operation that declares it demands it.
 *
 * `components.parameters.IdempotencyKey` is `required: true` in the contract, so `openapi-fetch`
 * refuses a call to `POST /auth/forgot-password` — or to anything else that declares it — without
 * one. The middleware below fills it in for every unsafe request, but a middleware is a runtime
 * fact and the generated types cannot see it; the call site still has to satisfy the signature.
 *
 * The value comes from the same generator the middleware uses rather than from a second one, and
 * the middleware then leaves it alone — «a key the caller chose is never overwritten» — so one call
 * still means one key, including across the replay this client performs after a token refresh.
 */
export const idempotencyParams = (): {
  readonly params: { readonly header: { readonly 'Idempotency-Key': string } };
} => ({ params: { header: { [IDEMPOTENCY_KEY_HEADER]: randomIdempotencyKey() } } });

/**
 * Attaches `Idempotency-Key` to every unsafe request, so that no call site can forget it.
 *
 * The server stores `(organization_id, key, endpoint, request_hash)` for 24 hours and answers a
 * replay with the stored response (`rules/api-contract.mdc` §10). What that buys is the case nobody
 * tests by hand: a connection dropped after the request left and before the answer arrived. Without
 * the header the retry creates a second task and spends a second batch of AI tokens; with it, the
 * retry gets the first answer back.
 *
 * A key the caller chose is never overwritten — that is how one logical action keeps one key across
 * every replay of it, including the replay this client performs after a token refresh.
 */
export const createIdempotencyMiddleware = (
  newKey: () => string = randomIdempotencyKey,
): Middleware => ({
  onRequest: ({ request }) => {
    if (!UNSAFE_METHODS.has(request.method)) return undefined;
    if (request.headers.has(IDEMPOTENCY_KEY_HEADER)) return undefined;

    request.headers.set(IDEMPOTENCY_KEY_HEADER, newKey());

    return request;
  },
});
