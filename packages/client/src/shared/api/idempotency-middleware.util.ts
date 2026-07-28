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
