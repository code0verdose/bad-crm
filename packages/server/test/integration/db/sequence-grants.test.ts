import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { closePools, createPools, reapplyGrants, type HarnessPools } from './db-harness.util.js';

/**
 * Sequences follow the table they belong to.
 *
 * `01-grants.sql` classifies *tables* carefully — partition leaves are revoked, journals get
 * `SELECT, INSERT`, everything without row-level security stays invisible to `app_user` — and then
 * handed `USAGE, SELECT` to `app_user` on **every** sequence in the schema, including sequences of
 * the tables it had just decided the application must not see. `USAGE` on a foreign sequence lets
 * `nextval()` move it; `SELECT` reads `last_value`, which is an estimate of how much data lives in
 * a table the application cannot open. Nothing breaks, and the rule the rest of the file spells out
 * quietly stops being a rule (technical debt of EPIC-001, recorded in STORY-005-05).
 *
 * The schema has no sequences today — every key is a uuid — so the rule is asserted against
 * sequences created here: one owned by a table `app_user` may read, one owned by a table it may
 * not. Both directions matter, and the positive control is the half that proves the file is doing
 * anything at all.
 */

const APP_VISIBLE_TABLE = 'teams';
/**
 * A table of this suite's own making, without row-level security — the shape `01-grants.sql` leaves
 * invisible to `app_user`.
 *
 * It used to be `_prisma_migrations`, and that stopped being true on 2026-08-05: the readiness
 * probe runs as `app_user` and needs to read it, so the file now grants `SELECT` on it. Borrowing a
 * real table as the example of «invisible» tied this suite to a decision made elsewhere; a table
 * created here cannot be taken away by one.
 */
const APP_INVISIBLE_TABLE = 'test_table_invisible_to_app';

const SEQUENCE_ON_VISIBLE = 'test_seq_on_teams';
const SEQUENCE_ON_INVISIBLE = 'test_seq_on_invisible';

let pools: HarnessPools;

beforeAll(async () => {
  pools = createPools();
  // No row-level security and no entry in `global_read`: the classifier grants `app_user` nothing.
  await pools.owner.query(
    `CREATE TABLE IF NOT EXISTS public.${APP_INVISIBLE_TABLE} (id uuid PRIMARY KEY)`,
  );
});

afterAll(async () => {
  await pools.owner.query(`DROP TABLE IF EXISTS public.${APP_INVISIBLE_TABLE} CASCADE`);
  await closePools(pools);
});

afterEach(async () => {
  await pools.owner.query(`DROP SEQUENCE IF EXISTS public.${SEQUENCE_ON_VISIBLE}`);
  await pools.owner.query(`DROP SEQUENCE IF EXISTS public.${SEQUENCE_ON_INVISIBLE}`);
});

/**
 * A sequence owned by a column of `table`, which is the shape `serial`/`GENERATED AS IDENTITY`
 * produces and the shape `pg_depend` records the ownership of.
 */
const createSequenceOwnedBy = async (sequence: string, table: string): Promise<void> => {
  await pools.owner.query(`CREATE SEQUENCE public.${sequence}`);
  // Both tables have an `id`; ownership is what `pg_depend` records, not the column type.
  await pools.owner.query(`ALTER SEQUENCE public.${sequence} OWNED BY public.${table}.id`);
};

const privilegesOn = async (sequence: string, role: string): Promise<string[]> => {
  const { rows } = await pools.owner.query<{ privilege: string }>(
    `SELECT p.privilege
       FROM unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(privilege)
      WHERE has_sequence_privilege($1, format('public.%I', $2::text)::regclass, p.privilege)
      ORDER BY p.privilege`,
    [role, sequence],
  );

  return rows.map((row) => row.privilege);
};

describe('01-grants.sql on sequences', () => {
  it('CONTROL: gives app_user the sequence of a table it may read', async () => {
    await createSequenceOwnedBy(SEQUENCE_ON_VISIBLE, APP_VISIBLE_TABLE);
    await reapplyGrants(pools.owner);

    expect(await privilegesOn(SEQUENCE_ON_VISIBLE, 'app_user')).toEqual(['SELECT', 'USAGE']);
  });

  it('gives app_user nothing on the sequence of a table it may not read', async () => {
    await createSequenceOwnedBy(SEQUENCE_ON_INVISIBLE, APP_INVISIBLE_TABLE);
    await reapplyGrants(pools.owner);

    expect(await privilegesOn(SEQUENCE_ON_INVISIBLE, 'app_user')).toEqual([]);
  });

  /**
   * The repair direction, and the reason `REVOKE` is used rather than "simply do not grant": this
   * file also runs after a restore and after a hand-made change, so a privilege somebody granted by
   * mistake has to be taken back rather than merely not re-added.
   */
  it('takes back a grant on a foreign sequence that somebody added by hand', async () => {
    await createSequenceOwnedBy(SEQUENCE_ON_INVISIBLE, APP_INVISIBLE_TABLE);
    await pools.owner.query(
      `GRANT USAGE, SELECT ON SEQUENCE public.${SEQUENCE_ON_INVISIBLE} TO app_user`,
    );

    expect(await privilegesOn(SEQUENCE_ON_INVISIBLE, 'app_user')).not.toEqual([]);

    await reapplyGrants(pools.owner);

    expect(await privilegesOn(SEQUENCE_ON_INVISIBLE, 'app_user')).toEqual([]);
  });

  /**
   * `pg_dump` reads `last_value` out of every sequence and stops on the first one it may not read,
   * so the narrowing above must not reach `backup_role`: its `SELECT` stays on all of them.
   */
  it('keeps backup_role reading every sequence, which pg_dump requires', async () => {
    await createSequenceOwnedBy(SEQUENCE_ON_VISIBLE, APP_VISIBLE_TABLE);
    await createSequenceOwnedBy(SEQUENCE_ON_INVISIBLE, APP_INVISIBLE_TABLE);
    await reapplyGrants(pools.owner);

    expect(await privilegesOn(SEQUENCE_ON_VISIBLE, 'backup_role')).toContain('SELECT');
    expect(await privilegesOn(SEQUENCE_ON_INVISIBLE, 'backup_role')).toContain('SELECT');
  });

  it('gives backup_role no way to move a sequence it can read', async () => {
    await createSequenceOwnedBy(SEQUENCE_ON_VISIBLE, APP_VISIBLE_TABLE);
    await reapplyGrants(pools.owner);

    expect(await privilegesOn(SEQUENCE_ON_VISIBLE, 'backup_role')).toEqual(['SELECT']);
  });
});
