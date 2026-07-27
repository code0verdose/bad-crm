import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  asMaintenance,
  closePools,
  createPools,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';
import { ROW_FACTORIES } from './row-factories.util.js';

/**
 * Isolation *between tests*, which is a different property from isolation between tenants and is
 * just as easy to lose: one container is shared by the whole run, so a test that leaves rows behind
 * makes the next one pass or fail for reasons it never states.
 *
 * The two tests below are ordered on purpose — the first writes, the second looks. Vitest runs the
 * tests of a file in order, and `fileParallelism` is off, so this is a real observation of the
 * cleanup rather than a restatement of it (rules/testing.mdc, 11).
 */

let pools: HarnessPools;

beforeAll(() => {
  pools = createPools();
});

afterAll(async () => {
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
});

const countOrganizations = async (): Promise<number> =>
  asMaintenance(pools.owner, async (client) =>
    Number(
      (await client.query<{ count: string }>('SELECT count(*) FROM organizations')).rows[0]?.count,
    ),
  );

describe('cleanup between tests', () => {
  it('leaves rows behind for the next test to trip over', async () => {
    await asMaintenance(pools.owner, async (client) => {
      const organizationId = randomUUID();

      await ROW_FACTORIES.organizations(client, organizationId);
      await ROW_FACTORIES.teams(client, organizationId);
    });

    expect(await countOrganizations()).toBe(1);
  });

  it('starts from an empty database anyway', async () => {
    expect(await countOrganizations()).toBe(0);
  });
});
