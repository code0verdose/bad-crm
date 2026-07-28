import { SharedApi } from '@shared';

import { AuthLib } from '@units/auth';

/**
 * Attaches the transport middleware to the one API client, in the one order that works.
 *
 * The order is not a preference and is proven by `test/api/idempotency.test.ts`: the idempotency
 * middleware has to see the request first, so that the key it generates belongs to the *logical*
 * operation. Register it after the auth middleware and a request replayed after a token refresh
 * gets a fresh key — which is precisely the case idempotency exists to protect, so the failure
 * appears only when the token expires mid-mutation and shows up as a duplicated invoice.
 *
 * It lives in `app/` because it is composition: `shared/api` must not import `units/auth`, and the
 * unit must not decide when the transport is wired.
 */
export const installApiMiddleware = (): void => {
  SharedApi.apiClient.use(SharedApi.createIdempotencyMiddleware());
  SharedApi.apiClient.use(AuthLib.createSessionAuthMiddleware());
};
