import { describe, expect, it } from 'vitest';

import { detachedTokenDenylist } from '@/infrastructure/redis/detached-token-denylist.adapter.js';

/**
 * The denylist a container gets when it was built without a Redis connection — used by the HTTP and
 * contract suites, which drive the application through supertest with no socket open. Both methods
 * refuse; see the module's own doc for why an `isRevoked` that answered `false` here would be the
 * worse failure mode.
 */
describe('the denylist of a container with no Redis', () => {
  it('refuses isRevoked with service_unavailable rather than answering not-spent', async () => {
    await expect(detachedTokenDenylist().isRevoked('mfa-pending-token:abc')).rejects.toMatchObject({
      code: 'service_unavailable',
      status: 503,
    });
  });

  it('refuses revoke with service_unavailable rather than doing nothing silently', async () => {
    await expect(
      detachedTokenDenylist().revoke('mfa-pending-token:abc', 300),
    ).rejects.toMatchObject({
      code: 'service_unavailable',
      status: 503,
    });
  });
});
