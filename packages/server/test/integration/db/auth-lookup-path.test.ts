import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  appUserPrivileges,
  asMaintenance,
  closePools,
  createPools,
  reapplyGrants,
  reapplyGrantsCollectingNotices,
  truncateAll,
  type HarnessPools,
} from './db-harness.util.js';

/**
 * The org-less authentication path, against the database it actually runs on.
 *
 * `docs/security/rls-design.md` («Особые пути», path 1) allows exactly one construction to read a
 * tenant table before the tenant is known: a `SECURITY DEFINER` function owned by `app_auth_definer`.
 * That is a genuine hole in the isolation of the whole product, and the only thing that keeps it from
 * being one in practice is how *narrow* it is. Narrowness is not a property of the TypeScript that
 * calls it — it is a property of the catalog, so it is asserted here.
 *
 * What "narrow" has to mean, and what each block below proves:
 *
 *   1. the role the application connects as can read **nothing** directly — no table, no view — and
 *      bypasses no policy either: `app_auth` is NOBYPASSRLS, the attribute belongs to the NOLOGIN
 *      role the function bodies execute as;
 *   2. the three functions are the whole of its reachable surface, and each returns one thing:
 *      one account by an address, one account by an address and a slug, one session by a digest;
 *   3. nobody else may call them — not `PUBLIC`, not `app_user`, which is the role an SQL injection
 *      would be running as;
 *   4. each has a pinned `search_path` and is owned by `app_auth_definer` — **not** by `app_auth`,
 *      the role the connection uses. `SECURITY DEFINER` runs with the owner's privileges, so the
 *      owner is the role that needs `SELECT` on the three tables; giving that to the role behind
 *      `DATABASE_AUTH_URL` would turn the credential into one that dumps every account of every
 *      organization on its own. The owner is therefore `NOLOGIN`: privileges belong to a role
 *      nobody can connect as, and the connecting role holds nothing but `EXECUTE`.
 *      `01-grants.sql` puts both the ownership and the `search_path` back after a restore has
 *      quietly moved them.
 *
 * The positive control runs first in each block: a suite that only proves things are unreachable
 * passes just as well on a broken connection.
 */

let pools: HarnessPools;

/** One organization with one account and one live session, written as the owner in maintenance mode. */
interface Fixture {
  readonly organizationId: string;
  readonly otherOrganizationId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly refreshHash: Buffer;
}

const seed = async (): Promise<Fixture> => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const refreshHash = createHash('sha256').update(randomBytes(32)).digest();

  return asMaintenance(pools.owner, async (client) => {
    for (const [id, slug] of [
      [organizationId, 'bad-company'],
      [otherOrganizationId, 'side-project'],
    ] as const) {
      await client.query(
        `INSERT INTO organizations (id, slug, name, updated_at) VALUES ($1, $2, $3, now())`,
        [id, slug, slug === 'bad-company' ? 'Bad Company' : 'Side Project'],
      );
    }

    const { rows: users } = await client.query<{ id: string }>(
      `INSERT INTO users (organization_id, email, password_hash, status, locale, timezone, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', 'en', 'Europe/Berlin', now())
       RETURNING id`,
      [organizationId, 'Ada@Example.COM', '$argon2id$placeholder-not-a-credential'],
    );

    // The same address in the other organization: the pair is unique, the address alone is not.
    await client.query(
      `INSERT INTO users (organization_id, email, password_hash, status, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', now())`,
      [otherOrganizationId, 'ada@example.com', '$argon2id$placeholder-not-a-credential'],
    );

    const userId = users[0]?.id ?? '';

    const { rows: sessions } = await client.query<{ id: string }>(
      `INSERT INTO sessions (organization_id, user_id, family_id, refresh_token_hash, user_agent,
                             ip_hash, ip_masked, expires_at, updated_at)
         VALUES ($1, $2, $3, $4, 'integration-suite', 'hmac', '203.0.113.0/24',
                 now() + interval '30 days', now())
       RETURNING id`,
      [organizationId, userId, randomUUID(), refreshHash],
    );

    return {
      organizationId,
      otherOrganizationId,
      userId,
      sessionId: sessions[0]?.id ?? '',
      refreshHash,
    };
  });
};

beforeAll(() => {
  pools = createPools();
});

afterAll(async () => {
  await closePools(pools);
});

beforeEach(async () => {
  await truncateAll(pools.owner);
});

describe('the app_auth connection', () => {
  it('CONTROL: resolves a session through its function, so the assertions below are not vacuous', async () => {
    const fixture = await seed();

    const { rows } = await pools.auth.query<{ session_id: string; organization_id: string }>(
      'SELECT * FROM auth_lookup_session($1)',
      [fixture.refreshHash],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: fixture.sessionId,
      organization_id: fixture.organizationId,
    });
  });

  /**
   * The property the whole design rests on: the role holds no privilege on any table, so there is
   * nothing it can ask outside the three functions. Its NOBYPASSRLS is the second line rather than
   * the first — the privilege check refuses before a policy is ever reached — and it is the line
   * that starts mattering the day somebody writes a `GRANT` against this role.
   */
  it.each(['users', 'sessions', 'organizations', 'password_reset_tokens', 'teams'])(
    'cannot read %s directly',
    async (table) => {
      await seed();

      await expect(pools.auth.query(`SELECT * FROM ${table}`)).rejects.toThrow(
        /permission denied/i,
      );
    },
  );

  it('cannot write to a table either', async () => {
    const fixture = await seed();

    await expect(
      pools.auth.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [fixture.sessionId]),
    ).rejects.toThrow(/permission denied/i);
  });

  /**
   * And the functions are not a way around that. Each answers exactly one question, so the reachable
   * surface is three rows shaped by the migration rather than "whatever a query asks for".
   */
  it('reads one session by its digest and nothing for any other digest', async () => {
    const fixture = await seed();

    const other = createHash('sha256').update(randomBytes(32)).digest();
    const { rows } = await pools.auth.query('SELECT * FROM auth_lookup_session($1)', [other]);

    expect(rows).toEqual([]);
    expect(fixture.sessionId).not.toBe('');
  });

  it('returns only the session columns the refresh path needs', async () => {
    const fixture = await seed();

    const { rows } = await pools.auth.query<Record<string, unknown>>(
      'SELECT * FROM auth_lookup_session($1)',
      [fixture.refreshHash],
    );

    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'expires_at',
      'family_id',
      'organization_id',
      'revoked_at',
      'revoked_reason',
      'session_id',
      'user_id',
    ]);
  });

  it('never returns the refresh digest it was asked about', async () => {
    const fixture = await seed();

    const { rows } = await pools.auth.query<Record<string, unknown>>(
      'SELECT * FROM auth_lookup_session($1)',
      [fixture.refreshHash],
    );

    expect(JSON.stringify(rows)).not.toContain(fixture.refreshHash.toString('hex'));
  });

  it('resolves an account inside one organization, case-insensitively', async () => {
    const fixture = await seed();

    const { rows } = await pools.auth.query<{ user_id: string; organization_slug: string }>(
      'SELECT * FROM auth_lookup_user($1::citext, $2)',
      ['  ADA@example.com  '.trim(), 'bad-company'],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: fixture.userId,
      organization_slug: 'bad-company',
    });
  });

  it('answers nothing for an organization slug that does not exist', async () => {
    await seed();

    const { rows } = await pools.auth.query('SELECT * FROM auth_lookup_user($1::citext, $2)', [
      'ada@example.com',
      'no-such-company',
    ]);

    expect(rows).toEqual([]);
  });

  it('lists every organization the address has an account in, for the use-case to filter', async () => {
    await seed();

    const { rows } = await pools.auth.query<{ organization_slug: string }>(
      'SELECT * FROM auth_lookup_users_by_email($1::citext)',
      ['ada@example.com'],
    );

    expect(rows.map((row) => row.organization_slug)).toEqual(['bad-company', 'side-project']);
  });

  it('hides a soft-deleted account from both resolvers', async () => {
    const fixture = await seed();

    await asMaintenance(pools.owner, (client) =>
      client.query('UPDATE users SET deleted_at = now() WHERE id = $1', [fixture.userId]),
    );

    const byEmail = await pools.auth.query('SELECT * FROM auth_lookup_users_by_email($1::citext)', [
      'ada@example.com',
    ]);
    const bySlug = await pools.auth.query('SELECT * FROM auth_lookup_user($1::citext, $2)', [
      'ada@example.com',
      'bad-company',
    ]);

    expect(
      byEmail.rows.map((row) => (row as { organization_slug: string }).organization_slug),
    ).toEqual(['side-project']);
    expect(bySlug.rows).toEqual([]);
  });
});

describe('who may call the resolvers', () => {
  const FUNCTIONS = [
    'auth_lookup_user(citext, text)',
    'auth_lookup_users_by_email(citext)',
    'auth_lookup_session(bytea)',
  ];

  /**
   * `app_user` is the role every request runs as, and the role an SQL injection would be running as.
   * `EXECUTE` here would hand it a cross-tenant read of every account on the installation — which is
   * why `REVOKE ALL … FROM PUBLIC` before the `GRANT` is a documented requirement rather than tidying.
   */
  it.each(FUNCTIONS)('refuses %s to app_user', async (signature) => {
    await expect(pools.app.query(`SELECT * FROM ${callOf(signature)}`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it.each(FUNCTIONS)('grants %s to app_auth and to nobody else', async (signature) => {
    const { rows } = await pools.owner.query<{ grantee: string }>(
      `SELECT unnest(coalesce(p.proacl, '{}'::aclitem[]))::text AS grantee
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.oid = $1::regprocedure`,
      [signature],
    );

    const acl = rows.map((row) => row.grantee);

    // `=X/` is the shape of a grant to PUBLIC — the default PostgreSQL adds and the one the
    // migration revokes.
    expect(acl.filter((entry) => entry.startsWith('=X/'))).toEqual([]);
    expect(acl.some((entry) => entry.startsWith('app_auth=X/'))).toBe(true);
    expect(acl.filter((entry) => entry.startsWith('app_user='))).toEqual([]);
  });

  it.each(FUNCTIONS)('owns %s as app_auth, with a pinned search_path', async (signature) => {
    const { rows } = await pools.owner.query<{ owner: string; config: string[] | null }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
         FROM pg_proc p
        WHERE p.oid = $1::regprocedure`,
      [signature],
    );

    expect(rows[0]?.owner).toBe('app_auth_definer');
    expect(rows[0]?.config ?? []).toContain('search_path=pg_catalog, public');
  });

  it('has no SECURITY DEFINER function beyond the three', async () => {
    const { rows } = await pools.owner.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
        ORDER BY signature`,
    );

    expect(rows.map((row) => row.signature)).toEqual([
      'auth_lookup_session(bytea)',
      'auth_lookup_user(citext,text)',
      'auth_lookup_users_by_email(citext)',
    ]);
  });

  /**
   * The failure `01-grants.sql` was extended for.
   *
   * `pg_restore --no-privileges` drops every grant and recreates each function owned by the role
   * running the restore. For a table that is fail-closed — the application dies on `permission
   * denied` and somebody notices. For a function it is fail-open: PostgreSQL's default hands
   * `EXECUTE` to `PUBLIC`, so the restored resolver is callable by `app_user` and runs as the owner
   * of the schema. This reproduces that state and asserts the repair.
   */
  it('is put back by 01-grants.sql after a restore has widened it', async () => {
    const fixture = await seed();

    // As the superuser, because this is the state `pg_restore` leaves behind and no application
    // role is allowed to produce it — which is itself worth knowing.
    await pools.superuser.query(
      `ALTER FUNCTION auth_lookup_session(bytea) OWNER TO app_migrator;
       GRANT EXECUTE ON FUNCTION auth_lookup_session(bytea) TO PUBLIC;`,
    );

    // The damage is real: app_user can call it now.
    await expect(
      pools.app.query('SELECT * FROM auth_lookup_session($1)', [fixture.refreshHash]),
    ).resolves.toBeDefined();

    await reapplyGrants(pools.owner);

    const { rows } = await pools.owner.query<{ owner: string; acl: string | null }>(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl
         FROM pg_proc p
        WHERE p.oid = 'auth_lookup_session(bytea)'::regprocedure`,
    );

    expect(rows[0]?.owner).toBe('app_auth_definer');
    // An entry that *starts* with `=` is the grant to PUBLIC; `app_auth=X/…` also contains `=X/`.
    expect((rows[0]?.acl ?? '').replace(/[{}]/g, '').split(',')).not.toContain(
      '=X/app_auth_definer',
    );
    await expect(
      pools.app.query('SELECT * FROM auth_lookup_session($1)', [fixture.refreshHash]),
    ).rejects.toThrow(/permission denied/i);
  });

  /**
   * And the guard that a restore cannot introduce but a migration can: a SECURITY DEFINER function
   * whose `search_path` is not pinned is the classic privilege-escalation shape, so `01-grants.sql`
   * refuses to finish rather than repairing what it cannot make safe.
   */
  it('refuses to apply grants when a SECURITY DEFINER function has no fixed search_path', async () => {
    await pools.owner.query(
      `CREATE FUNCTION unsafe_resolver() RETURNS int
         LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT 1 $$`,
    );

    try {
      await expect(reapplyGrants(pools.owner)).rejects.toThrow(/search_path/i);
    } finally {
      await pools.owner.query('DROP FUNCTION unsafe_resolver()');
      await reapplyGrants(pools.owner);
    }
  });
});

/**
 * A `SECURITY DEFINER` function in `public` that this project did not write.
 *
 * `01-grants.sql` used to classify by `prosecdef` alone, and `prosecdef` is a property of every such
 * function in the schema — including the ones an extension brings. The schema has exactly three
 * today, so nothing was wrong in practice; the day pgaudit, pg_cron or postgis is installed, both
 * branches below fire, and one of them is worse than an outage.
 *
 * Reproduced against PostgreSQL 16.14 before the classifier was narrowed:
 *
 *   * owned by the cluster superuser (which is how objects of an extension are owned) —
 *     `SET LOCAL ROLE bad_crm` answers `permission denied to set role`, and because the file is one
 *     transaction the **whole** of `pnpm db:grants` rolls back. The step whose entire job is to put
 *     privileges back after a restore is then the step that leaves the database without any;
 *   * owned by a role app_migrator can `SET ROLE` into — the function is silently reassigned to
 *     `app_auth_definer` and granted `EXECUTE` to `app_auth`, which widens the surface of
 *     `DATABASE_AUTH_URL` beyond the three resolvers it is documented to have.
 *
 * The narrowed classifier repairs the project's own resolvers — the ones the migration marks with
 * `COMMENT ON FUNCTION … IS 'bad-crm:auth-resolver'` — and leaves everything else alone. What it
 * does **not** relax is the `search_path` guard: a foreign SECURITY DEFINER function without a
 * pinned `search_path` is a privilege-escalation shape whoever owns it, so it still stops the run.
 */
describe('a SECURITY DEFINER function this project does not own', () => {
  /** The privilege the repair path exists to restore; asserted before and after each branch. */
  const appUserSelectOnUsers = async (): Promise<string[]> =>
    appUserPrivileges(pools.owner, 'users');

  it('CONTROL: the repair path restores a table grant a restore dropped', async () => {
    await pools.owner.query('REVOKE ALL ON TABLE users FROM app_user');
    expect(await appUserSelectOnUsers()).toEqual([]);

    await reapplyGrants(pools.owner);

    expect(await appUserSelectOnUsers()).toContain('SELECT');
  });

  it('does not stop the repair path when it belongs to an extension', async () => {
    await withExtensionFunction(
      `CREATE FUNCTION extension_like_resolver() RETURNS int
         LANGUAGE sql STABLE SECURITY DEFINER
         SET search_path = pg_catalog, public AS $$ SELECT 1 $$`,
      'extension_like_resolver()',
      async () => {
        await pools.owner.query('REVOKE ALL ON TABLE users FROM app_user');
        await reapplyGrants(pools.owner);

        // The point of the test: the grants of every *other* object were applied, not rolled back.
        expect(await appUserSelectOnUsers()).toContain('SELECT');
      },
    );
  });

  /**
   * NEW-6, and the reason the `search_path` guard is not uniform.
   *
   * An extension is entitled to ship a `SECURITY DEFINER` function without a pinned `search_path`,
   * and an operator has no way to fix one: the function belongs to the extension, `ALTER FUNCTION`
   * on it is undone by the next `ALTER EXTENSION UPDATE`, and dropping it drops the extension. When
   * the guard treated that as a refusal, installing `pgaudit`, `pg_cron` or `postgis` made
   * `pnpm db:grants` unrunnable — measured on PostgreSQL 16 by adding such a function to `pgcrypto`
   * with `ALTER EXTENSION … ADD FUNCTION`: the whole file aborted with
   * `ERROR: SECURITY DEFINER function ext_audit_helper() (owner bad_crm, from extension pgcrypto)`.
   *
   * That is worse than the thing it was protecting against, because `01-grants.sql` is the *only*
   * way to put privileges back after a restore. The database would come back with all its data,
   * the application would see no table at all, and the operator could not repair it without
   * uninstalling the extension. So: warn, loudly, and finish the job.
   */
  it('warns but finishes when an extension ships one without a pinned search_path', async () => {
    await withExtensionFunction(
      `CREATE FUNCTION ext_audit_helper() RETURNS int
         LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT 1 $$`,
      'ext_audit_helper()',
      async () => {
        await pools.owner.query('REVOKE ALL ON TABLE users FROM app_user');

        const notices = await reapplyGrantsCollectingNotices(pools.owner);

        expect(await appUserSelectOnUsers()).toContain('SELECT');
        expect(
          notices.join('\n'),
          'the unpinned search_path of an extension function passed unremarked',
        ).toMatch(/ext_audit_helper\(\)[\s\S]*pgcrypto/);
      },
    );
  });

  /**
   * The other half of the narrowing, and the one that decides which way the file fails.
   *
   * A `SECURITY DEFINER` function in `public` that carries no marker and belongs to no extension is
   * one of two things, and this file cannot tell them apart: a resolver of this project whose
   * `COMMENT` something stripped, or somebody else's function. The first is a live
   * privilege-escalation surface — `EXECUTE` defaults to `PUBLIC` — and the second must not be
   * touched. Leaving it and reporting success is the fail-**open** answer, so the file refuses.
   */
  it('refuses an unmarked SECURITY DEFINER function it did not write', async () => {
    await pools.owner.query(
      `CREATE FUNCTION unrelated_helper() RETURNS int
         LANGUAGE sql STABLE SECURITY DEFINER
         SET search_path = pg_catalog, public AS $$ SELECT 42 $$`,
    );

    try {
      await expect(reapplyGrants(pools.owner)).rejects.toThrow(
        /unrelated_helper\(\)[\s\S]*marker/i,
      );

      const { rows } = await pools.owner.query<{ owner: string; acl: string | null }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl
           FROM pg_proc p
          WHERE p.oid = 'unrelated_helper()'::regprocedure`,
      );

      // It still refuses to *act* on it: the run stops, the object is left exactly as found.
      expect(rows[0]?.owner, 'ownership was taken over').toBe('app_migrator');
      expect(
        rows[0]?.acl ?? '',
        'app_auth was given EXECUTE on a function that is not a resolver',
      ).not.toContain('app_auth=');
    } finally {
      await pools.owner.query('DROP FUNCTION unrelated_helper()');
      await reapplyGrants(pools.owner);
    }
  });

  /**
   * The failure this whole marker scheme exists for, reproduced end to end.
   *
   * `pg_dump --no-comments` is one flag, it is suggested by the runbook's own neighbourhood (the
   * dump has to shed `COMMENT ON EXTENSION` records to restore under app_migrator at all), and it
   * removes the *only* property that distinguishes a resolver of this project from any other
   * `SECURITY DEFINER` function — because ownership and the ACL are the two things a restore has
   * already destroyed.
   *
   * Measured on PostgreSQL 16 (pgvector/pgvector:0.8.5-pg16) before this refusal existed: a restore
   * from `pg_dump -Fc --no-owner --no-privileges --no-comments` left all three resolvers owned by
   * `app_migrator` with `proacl = NULL`, `01-grants.sql` printed
   * `grants applied: 6 tables, 0 sequences, 0 security definer functions` and **exited 0**, and
   * `app_user` — the role every HTTP request runs as, and the role an SQL injection runs as — could
   * call `auth_lookup_users_by_email`. Under `SET app.maintenance = 'on'` the body, now running as
   * app_migrator, returned every account of every organization with its `password_hash`.
   *
   * So the loss of the marker has to stop the deployment, not be reported as success.
   */
  it('refuses when a restore stripped the markers off this project’s own resolvers', async () => {
    const fixture = await seed();

    // Exactly the state `pg_restore` leaves behind after a dump taken with `--no-comments`.
    await pools.superuser.query(
      `ALTER FUNCTION auth_lookup_users_by_email(citext) OWNER TO app_migrator;
       COMMENT ON FUNCTION auth_lookup_users_by_email(citext) IS NULL;
       GRANT EXECUTE ON FUNCTION auth_lookup_users_by_email(citext) TO PUBLIC;`,
    );

    try {
      // The hole is real while it lasts, and it is the reason the answer must not be "success".
      // `app.maintenance` is a setting any role may set, and the body now runs as app_migrator —
      // the role that policy is written for — so the two together are a full cross-tenant read.
      const leaked = await asMaintenance(pools.app, (client) =>
        client.query<{ password_hash: string; organization_slug: string }>(
          'SELECT organization_slug, password_hash FROM auth_lookup_users_by_email($1::citext)',
          ['ada@example.com'],
        ),
      );

      expect(
        leaked.rows.map((row) => row.organization_slug).sort(),
        'the reproduction is stale: app_user could not reach the widened resolver',
      ).toEqual(['bad-company', 'side-project']);

      await expect(reapplyGrants(pools.owner)).rejects.toThrow(
        /auth_lookup_users_by_email\(citext\)[\s\S]*marker/i,
      );
      await expect(reapplyGrants(pools.owner)).rejects.toThrow(/bad-crm:auth-resolver/);
      // And it says what to do about it, because the operator is mid-restore.
      await expect(reapplyGrants(pools.owner)).rejects.toThrow(/--no-comments/);

      expect(fixture.userId).not.toBe('');
    } finally {
      await pools.superuser.query(
        `COMMENT ON FUNCTION auth_lookup_users_by_email(citext) IS
           'bad-crm:auth-resolver — org-less sign-in without a named organization.';`,
      );
      await reapplyGrants(pools.owner);
    }
  });

  it('still refuses a foreign function without a pinned search_path', async () => {
    await pools.superuser.query(
      `CREATE FUNCTION foreign_unsafe() RETURNS int
         LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT 1 $$`,
    );

    try {
      await expect(reapplyGrants(pools.owner)).rejects.toThrow(/search_path/i);
      // The signature is printed as written — `%s` in a `RAISE EXCEPTION` format string is a literal
      // `s` after the substitution, and the message read `… function foreign_unsafe()s has no …`.
      await expect(reapplyGrants(pools.owner)).rejects.toThrow(/function foreign_unsafe\(\) \(/);
      // And it says whose it is, so an operator knows whether the fix is theirs to make.
      await expect(reapplyGrants(pools.owner)).rejects.toThrow(/not from an extension/);
    } finally {
      await pools.superuser.query('DROP FUNCTION foreign_unsafe()');
      await reapplyGrants(pools.owner);
    }
  });

  /**
   * The one case the repair loop cannot handle, named rather than left to surface as a bare
   * `permission denied to set role` from inside a DO block: a restore run by somebody other than
   * app_migrator leaves this project's own resolver owned by a role app_migrator cannot become.
   */
  it('names the owner it cannot take over instead of failing opaquely', async () => {
    await pools.superuser.query('ALTER FUNCTION auth_lookup_session(bytea) OWNER TO bad_crm');

    try {
      await expect(reapplyGrants(pools.owner)).rejects.toThrow(
        /auth_lookup_session\(bytea\) is owned by bad_crm/,
      );
    } finally {
      await pools.superuser.query(
        'ALTER FUNCTION auth_lookup_session(bytea) OWNER TO app_auth_definer',
      );
      await reapplyGrants(pools.owner);
    }
  });

  /**
   * The marker is what tells the repair path which functions are ours, so a resolver that lacks it
   * is a resolver a restore leaves owned by app_migrator and `EXECUTE`-able by PUBLIC — fail-open,
   * and invisible until somebody restores a backup.
   */
  it('marks every SECURITY DEFINER function of this schema as one of ours', async () => {
    const { rows } = await pools.owner.query<{ signature: string; marker: string | null }>(
      `SELECT p.oid::regprocedure::text AS signature, obj_description(p.oid, 'pg_proc') AS marker
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
        ORDER BY signature`,
    );

    expect(rows).toHaveLength(3);

    for (const row of rows) {
      expect(row.marker ?? '', `${row.signature} carries no project marker`).toContain(
        'bad-crm:auth-resolver',
      );
    }
  });
});

/**
 * Runs `body` while `signature` exists as a genuine member of an extension.
 *
 * `ALTER EXTENSION … ADD FUNCTION` is what makes it genuine: it writes the `pg_depend` row with
 * `deptype = 'e'` that `01-grants.sql` classifies on. A function merely *created by the superuser*
 * is not a member of anything, and a test built on one would assert the wrong branch — which is what
 * the previous version of this suite did, under the name `extension_like_resolver`.
 *
 * `pgcrypto` is borrowed because it is already installed by `initdb/01-extensions.sql` and its
 * membership list is restored the moment this function is dropped from it.
 */
const withExtensionFunction = async (
  createSql: string,
  signature: string,
  body: () => Promise<void>,
): Promise<void> => {
  await pools.superuser.query(createSql);
  await pools.superuser.query(`ALTER EXTENSION pgcrypto ADD FUNCTION ${signature}`);

  try {
    await body();
  } finally {
    await pools.superuser.query(`ALTER EXTENSION pgcrypto DROP FUNCTION ${signature}`);
    await pools.superuser.query(`DROP FUNCTION ${signature}`);
    await reapplyGrants(pools.owner);
  }
};

/** `auth_lookup_user(citext, text)` → a call with placeholder arguments of the right types. */
const callOf = (signature: string): string => {
  if (signature.startsWith('auth_lookup_user(')) return `auth_lookup_user(''::citext, '')`;
  if (signature.startsWith('auth_lookup_users_by_email')) {
    return `auth_lookup_users_by_email(''::citext)`;
  }

  return `auth_lookup_session('\\x00'::bytea)`;
};
