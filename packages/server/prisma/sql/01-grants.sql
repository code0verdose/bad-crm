-- 01-grants.sql · the one place that decides which role may touch which object.
--
-- Executed by app_migrator (the owner of every object — GRANT requires ownership, not superuser):
--
--   psql -v ON_ERROR_STOP=1 -U app_migrator -d bad_crm -f 01-grants.sql
--   pnpm db:grants                                    # the same thing against the dev container
--
-- WHEN IT RUNS
--   * after every `prisma migrate deploy` — a migration that forgot its GRANT lines is corrected
--     here instead of silently dropping the new table out of the backup;
--   * after every `pg_restore` — `--no-privileges` on both sides of the backup cycle means not a
--     single GRANT survives the round trip. Without this step the restored database has all its
--     data and no access to it: app_user sees nothing, backup_role cannot take the next dump.
--
-- WHY NOT `prisma migrate deploy` FOR THE RESTORE CASE
--   `migrate deploy` applies *pending* migrations only. After a restore the `_prisma_migrations`
--   table comes back from the dump with every migration already marked applied, so the command
--   reports "No pending migrations to apply", exits 0 and re-applies nothing. Prisma migrations are
--   also plain `CREATE TABLE`, not `CREATE TABLE IF NOT EXISTS` — re-running them is not idempotent
--   even when they do run.
--
-- WHY IT WALKS THE CATALOG
--   Every alternative is a list of table names maintained by hand, which is wrong the first time
--   somebody adds a table and does not read this file. The rules below are expressed against
--   pg_class/pg_attribute, so a table created by a future migration is covered the moment it exists.
--
-- WHAT THIS FILE DOES NOT COVER YET — FUNCTIONS
--   Only tables and sequences below. That is a gap with a direction: for a table `--no-privileges`
--   is fail-closed (no GRANT, the application dies on `permission denied`, this file repairs it),
--   while for a function it is fail-open. PostgreSQL grants `EXECUTE` on a new function to PUBLIC
--   by default, and `pg_restore` recreates it owned by the role running the restore — app_migrator,
--   the owner of the schema. A restored SECURITY DEFINER resolver is therefore callable by anybody
--   and runs with more rights than it was written for.
--   No such function exists today. The first one arrives with the pre-organization user resolver of
--   EPIC-006 (STORY-006-02, epics/epic-006-auth-core/stories/story-006-02-login-access-and-refresh-cookie.md),
--   and that story carries the task of extending this file over pg_proc: OWNER TO app_auth,
--   REVOKE ALL FROM PUBLIC, GRANT EXECUTE to the one role that needs it.
--
-- Idempotent: GRANT of a privilege already held is a no-op, and the whole file is one transaction —
-- a failure half way through leaves the previous state rather than a half-granted database.

\set ON_ERROR_STOP on

BEGIN;

DO $grants$
DECLARE
  -- Append-only journals: the application inserts and reads, never updates or deletes. Same list as
  -- check 4d in docs/security/rls-design.md — the two must be changed together.
  append_only  CONSTANT text[] := ARRAY[
    'audit_logs', 'activity_events', 'vault_access_logs', 'secure_link_views'
  ];

  -- Tables without organization_id that the application still has to read (reference data shared by
  -- every organization). Deliberately empty: today no such table exists, and a migration that adds
  -- one adds it here, in the open, rather than hiding a cross-tenant read behind a bare GRANT.
  global_read  CONSTANT text[] := ARRAY[]::text[];

  -- Tenant tables the application may never DELETE from. Removing an organization is an offboarding
  -- procedure with its own path — export, key revocation, retention — not a statement the request
  -- handler is allowed to issue.
  --
  -- Mirrors `appUserPrivileges` in
  -- `src/infrastructure/persistence/prisma/tenant-tables.constant.ts`. SQL cannot read that
  -- registry, so the two are kept in step by `test/unit/persistence/grants-registry.test.ts`, which
  -- parses this list and fails when it disagrees.
  no_delete    CONSTANT text[] := ARRAY['organizations'];

  rel record;
  granted_tables    int := 0;
  granted_sequences int := 0;
BEGIN
  -- A missing role turns every GRANT below into an error that names the object rather than the
  -- cause. Fail once, with the real reason: the bootstrap has not been run against this cluster.
  FOR rel IN
    SELECT r.name FROM unnest(ARRAY['app_user', 'backup_role']) AS r(name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name)
  LOOP
    RAISE EXCEPTION 'role % does not exist — run the role bootstrap (00-bootstrap-roles.sql) first',
      rel.name;
  END LOOP;

  FOR rel IN
    SELECT c.oid,
           c.relname,
           c.relispartition,
           -- A tenant table is one whose rows are filtered by a policy — not one that happens to
           -- carry a column of a particular name.
           --
           -- Keying this on `organization_id` was a second source of truth for the same idea, and
           -- it disagreed with the first on the one table where the two differ: `organizations` is
           -- the tenant root, so it has no such column — its policy compares `id`. The classifier
           -- did not see it as a tenant table, granted app_user nothing on it, and because
           -- `pg_restore` runs with `--no-privileges`, every restore ended with the application
           -- unable to read the table that resolves the tenant. Not a leak: a total outage, and one
           -- this file was supposed to be the cure for.
           --
           -- `relrowsecurity` is the definition invariant 1 already gives: if the application may
           -- touch it, rows are filtered by policy. One source, derived from the thing that matters.
           c.relrowsecurity AS is_tenant_table
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'public'
      AND  c.relkind IN ('r', 'p')
    ORDER  BY c.relname
  LOOP
    -- 1. The backup reads everything, partition leaves included.
    --
    --    pg_dump dumps a partitioned table leaf by leaf and checks the privilege on the leaf: it
    --    takes an ACCESS SHARE lock on every leaf before it reads a single row, so one partition
    --    without this GRANT fails the whole dump with `permission denied for table
    --    audit_logs_2026_07`. BYPASSRLS does not help — it skips policies, not privilege checks.
    --    Verified against PostgreSQL 16.14.
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO backup_role', rel.relname);
    granted_tables := granted_tables + 1;

    IF rel.relispartition THEN
      -- 2. A partition leaf is never addressed by the application: policies and grants are not
      --    inherited, so a leaf reachable by app_user is a leaf with no tenant isolation at all.
      --    REVOKE rather than "do not grant": this file is also the repair path for a leaf that
      --    somebody granted by hand or that a partition-maintenance job granted by mistake.
      --    Checked independently by 4c in docs/security/rls-design.md.
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM app_user', rel.relname);

    ELSIF rel.is_tenant_table AND rel.relname = ANY (append_only) THEN
      -- 3. Journals: insert and read, nothing else. Not even the tenant policy can bring back a
      --    deleted audit record, so the privilege is where this is enforced.
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO app_user', rel.relname);
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM app_user', rel.relname);

    ELSIF rel.is_tenant_table AND rel.relname = ANY (no_delete) THEN
      -- 4. Tenant table the application must not delete from — today the tenant root itself.
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO app_user', rel.relname);
      EXECUTE format('REVOKE DELETE, TRUNCATE ON TABLE public.%I FROM app_user', rel.relname);

    ELSIF rel.is_tenant_table OR rel.relname = ANY (global_read) THEN
      -- 5. Ordinary tenant table. TRUNCATE is never granted: it ignores row-level security, so one
      --    TRUNCATE would empty the table for every organization at once.
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO app_user',
                     rel.relname);
      EXECUTE format('REVOKE TRUNCATE ON TABLE public.%I FROM app_user', rel.relname);
    END IF;
    -- Anything else (a table with row-level security disabled and no entry in global_read — today
    -- only Prisma's own _prisma_migrations) is readable by the backup and invisible to the
    -- application.
  END LOOP;

  -- 6. Sequences, and they follow the table they belong to.
  --
  --    backup_role reads all of them: pg_dump reads `last_value` out of every sequence and stops on
  --    the first one it may not read (`permission denied for sequence audit_logs_id_seq`), so one
  --    missing GRANT fails the whole dump.
  --
  --    app_user is a different question, and this loop used to get it wrong. It granted
  --    `USAGE, SELECT` to every sequence in the schema — including the sequences of tables the
  --    branches above had just decided the application must not see. `USAGE` on a foreign sequence
  --    lets `nextval()` move it; `SELECT` reads `last_value`, which estimates how much data lives
  --    in a table app_user cannot open. Nothing breaks, so the rule simply stopped being a rule
  --    (technical debt of EPIC-001, closed in STORY-005-05).
  --
  --    The test is the owning table, not the sequence name: `has_table_privilege(..., 'SELECT')` is
  --    asked *after* the table loop above, so it answers with the decision this very file has just
  --    made rather than with a second copy of the classification. A sequence with no owning table —
  --    a bare `CREATE SEQUENCE` — reaches the ELSE branch and app_user gets nothing, which fails
  --    loudly on first use instead of quietly widening access.
  --
  --    REVOKE rather than "do not grant", for the same reason as the partition leaves: this file is
  --    also the repair path after a restore and after a privilege somebody added by hand.
  FOR rel IN
    SELECT DISTINCT
           c.relname,
           dep.refobjid AS owning_table
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_depend dep
           ON dep.classid    = 'pg_class'::regclass
          AND dep.objid      = c.oid
          AND dep.refclassid = 'pg_class'::regclass
          AND dep.deptype IN ('a', 'i')
    WHERE  n.nspname = 'public' AND c.relkind = 'S'
    ORDER  BY c.relname
  LOOP
    EXECUTE format('GRANT SELECT ON SEQUENCE public.%I TO backup_role', rel.relname);

    IF rel.owning_table IS NOT NULL
       AND has_table_privilege('app_user', rel.owning_table, 'SELECT') THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO app_user', rel.relname);
    ELSE
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM app_user', rel.relname);
    END IF;

    granted_sequences := granted_sequences + 1;
  END LOOP;

  RAISE NOTICE 'grants applied: % tables, % sequences', granted_tables, granted_sequences;
END $grants$;

COMMIT;
