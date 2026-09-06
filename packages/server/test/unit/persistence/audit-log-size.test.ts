import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  AUDIT_LOG_BYTES_SQL,
  createAuditLogBytesReader,
} from '../../../src/infrastructure/persistence/prisma/audit-log-size.adapter.js';

/**
 * The shape of the reading, in the two places it can go wrong without a database noticing.
 *
 * The statement itself is asserted against a live PostgreSQL as `app_user`
 * (`test/integration/db/audit-log-size.test.ts`) — privileges and the partitioned parent's zero are
 * not properties a stub can hold an opinion about. What is left here is the part between the driver
 * and the gauge, and it is the part that turns a correct query into a wrong series: `bigint` arrives
 * as a string, and a Prometheus gauge takes a number.
 */
describe('reading the size of the audit trail', () => {
  it('turns the bigint PostgreSQL answers into a number', async () => {
    const client = { $queryRaw: vi.fn().mockResolvedValue([{ bytes: '11476992' }]) };

    const bytes = await createAuditLogBytesReader(client)();

    // `'11476992'` is what the driver hands over, and a gauge given that publishes a series whose
    // value is the string — or, on a version that coerces, silently loses precision at the top.
    expect(bytes).toBe(11_476_992);
    expect(client.$queryRaw).toHaveBeenCalledWith(Prisma.raw(AUDIT_LOG_BYTES_SQL));
  });

  it('answers zero when the trail has no partitions at all', async () => {
    const client = { $queryRaw: vi.fn().mockResolvedValue([]) };

    // Not `NaN`, which is what `Number(undefined)` would put on the gauge — a value Prometheus
    // renders as `NaN` and every dashboard shows as a gap.
    await expect(createAuditLogBytesReader(client)()).resolves.toBe(0);
  });
});
