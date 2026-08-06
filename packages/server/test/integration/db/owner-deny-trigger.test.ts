import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asMaintenance,
  asTenant,
  closePools,
  createPools,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * The owner cannot be denied anything — proved against the database, not against the use-case.
 *
 * `permission-override.policy.ts` refuses a DENY on the owner, and that refusal is the one a user
 * sees. This file is about the other half: the rule has to hold for a row nobody routed through the
 * application — a repair script, a restore, a use-case somebody edits without reading the model.
 * One such row makes «the owner cannot be locked out» false and leaves an organization nobody can
 * administer, which is not a state any screen can fix afterwards.
 */

let pools: HarnessPools;

const ORG = '00000000-0000-4000-8000-0000000000d1';
const CHECK_VIOLATION = '23514';
let ownerId = '';
let memberId = '';

beforeAll(async () => {
  pools = createPools();
  ownerId = randomUUID();
  memberId = randomUUID();

  await asMaintenance(pools.owner, async (client) => {
    await client.query(
      `WITH created_organization AS (
         INSERT INTO organizations (id, owner_id, slug, name, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Owner deny fixture', now())
         RETURNING id
       )
       INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
       SELECT $2::uuid, $1::uuid, $4, 'placeholder-not-a-credential', 'ACTIVE', now()
       FROM created_organization`,
      [ORG, ownerId, `owner-deny-${randomUUID().slice(0, 8)}`, `owner-${ownerId}@example.test`],
    );

    await client.query(
      `INSERT INTO users (id, organization_id, email, password_hash, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'placeholder-not-a-credential', 'ACTIVE', now())`,
      [memberId, ORG, `member-${memberId}@example.test`],
    );
  });
});

afterAll(async () => {
  await closePools(pools);
});

const writeOverride = (
  userId: string,
  effect: 'ALLOW' | 'DENY',
): Promise<unknown> =>
  asTenant(pools.app, ORG, (client) =>
    client.query(
      `INSERT INTO user_permission_overrides
         (organization_id, user_id, permission_key, effect, reason, updated_at)
       VALUES ($1::uuid, $2::uuid, 'task:read', $3, 'trigger fixture reason', now())`,
      [ORG, userId, effect],
    ),
  );

describe('a DENY exception aimed at the owner', () => {
  it('CONTROL: the same statement succeeds for anybody else', async () => {
    // Without this the refusal below could be a broken insert rather than the trigger doing its job.
    await expect(writeOverride(memberId, 'DENY')).resolves.toBeDefined();
  });

  it('is refused by the database, not only by the use-case', async () => {
    await expect(writeOverride(ownerId, 'DENY')).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
  });

  it('does not stand in the way of an ALLOW for the owner, which changes nothing', async () => {
    await expect(writeOverride(ownerId, 'ALLOW')).resolves.toBeDefined();
  });

  it('is refused on update as well, so a row cannot be flipped into one', async () => {
    // The `BEFORE INSERT OR UPDATE` half: writing an ALLOW and turning it into a DENY afterwards is
    // the obvious way around a check that only guards inserts.
    const attempt = asTenant(pools.app, ORG, (client) =>
      client.query(
        `UPDATE user_permission_overrides SET effect = 'DENY'
          WHERE user_id = $1::uuid AND permission_key = 'task:read'`,
        [ownerId],
      ),
    );

    await expect(attempt).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('refuses a reason nobody could read, whoever writes it', async () => {
    const attempt = asTenant(pools.app, ORG, (client) =>
      client.query(
        `INSERT INTO user_permission_overrides
           (organization_id, user_id, permission_key, effect, reason, updated_at)
         VALUES ($1::uuid, $2::uuid, 'task:update', 'ALLOW', '   short   ', now())`,
        [ORG, memberId],
      ),
    );

    await expect(attempt).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });
});
