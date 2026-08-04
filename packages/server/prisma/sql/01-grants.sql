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
-- FUNCTIONS — WHY THEY ARE HERE AND WHY THEY MATTER MORE THAN TABLES
--   For a table `--no-privileges` is fail-closed: no GRANT survives, the application dies on
--   `permission denied`, and the loop above repairs it. For a function it is **fail-open**.
--   PostgreSQL grants `EXECUTE` on a function to PUBLIC by default, and `pg_restore` recreates it
--   owned by the role running the restore — app_migrator, the owner of the schema. A restored
--   SECURITY DEFINER resolver is therefore callable by anybody, including app_user, and its body
--   runs with the rights of the role that owns every table in the database.
--   The loop below closes that: every SECURITY DEFINER function **of this project** in `public` is
--   put back under app_auth_definer, REVOKEd from PUBLIC and GRANTed to the roles named in
--   `security_definer_grantees`.
--   It also *refuses* a function without a fixed `search_path` — any such function, ours or not,
--   which is the other half of the same vulnerability and the one a restore cannot introduce but a
--   careless migration can.
--
-- "OF THIS PROJECT", AND WHY THE CLASSIFIER IS NOT `prosecdef` ALONE
--   `prosecdef` is true of every SECURITY DEFINER function in the schema, including the ones an
--   extension installs into `public`. Acting on those is not a theoretical mistake; both branches
--   were reproduced on PostgreSQL 16.14:
--     * owned by the cluster superuser — which is how the objects of an extension are owned —
--       `SET LOCAL ROLE <owner>` answers `permission denied to set role`. This file is one
--       transaction, so the *whole* run rolls back, and the step whose only job is to restore
--       privileges after a restore is the step that leaves the database without any;
--     * owned by a role app_migrator can `SET ROLE` into, the transfer succeeds — and an unrelated
--       function is silently re-owned by app_auth_definer and granted `EXECUTE` to app_auth, which
--       widens `DATABASE_AUTH_URL` beyond the three resolvers it is documented to have.
--   So the project's own resolvers are marked, in the migration that creates them, with
--   `COMMENT ON FUNCTION … IS 'bad-crm:auth-resolver …'`. A comment is part of a dump and survives
--   `--no-privileges`, so it is still there in exactly the state this file exists to repair — unlike
--   ownership and the ACL, which are the two things a restore destroys. Adding a resolver therefore
--   means adding one COMMENT line next to it; `test/integration/db/auth-lookup-path.test.ts` fails
--   when a SECURITY DEFINER function in this schema carries no marker.
--   (Technical debt of EPIC-001, closed by STORY-006-02 together with the first three such
--   functions: auth_lookup_user, auth_lookup_users_by_email, auth_lookup_session.)
--
-- AND WHY THE ABSENCE OF THE MARKER IS AN ERROR, NOT A SKIP
--   Narrowing the classifier to a comment made the safety of this file depend on a property that
--   **one `pg_dump` flag erases**: `--no-comments`. Reproduced on PostgreSQL 16.14 — a restore from
--   `pg_dump -Fc --no-owner --no-privileges --no-comments` left the three resolvers owned by
--   app_migrator with `proacl = NULL`, i.e. `EXECUTE` for PUBLIC; step 7b matched nothing, this file
--   printed `0 security definer functions` and exited 0; and `app_user` — the role every request
--   runs as — could call `auth_lookup_users_by_email` and, under `SET app.maintenance = 'on'`, read
--   every account of every organization with its `password_hash`. Silent, successful, fail-open.
--   Step 7a therefore refuses: an unmarked SECURITY DEFINER function of this schema stops the
--   deployment instead of quietly widening the surface. See 7a for the three branches and for the
--   one case that is a warning rather than a refusal — a function an extension owns, which no
--   operator can fix and which must not make the repair path unavailable.
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

  -- Roles allowed to call a SECURITY DEFINER function. Exactly one today, and the list is written
  -- out rather than derived: `EXECUTE` on a function whose body bypasses row-level security is the
  -- single widest privilege this file can hand out, so adding a role to it has to be an edit
  -- somebody makes on purpose and a reviewer sees (docs/security/rls-design.md, «Особые пути»).
  security_definer_grantees CONSTANT text[] := ARRAY['app_auth'];

  -- The role SECURITY DEFINER functions run as, and the tables it may read.
  --
  -- It is not `app_auth`: a function executes with the privileges of its owner, and BYPASSRLS skips
  -- policies rather than privilege checks — so the owner needs SELECT, and giving that to the role
  -- the application connects as would turn DATABASE_AUTH_URL into a dump of every account. The owner
  -- is therefore a NOLOGIN role, and these privileges are reachable only through the functions
  -- (00-bootstrap-roles.sql, «app_auth_definer»).
  --
  -- Written out rather than derived: `SELECT` for a role that bypasses row-level security is the
  -- widest read this file hands out, and a table joins the list only when a resolver needs it.
  --
  -- `password_reset_tokens` joined the list in STORY-006-08 together with
  -- `auth_lookup_password_reset`: the reset link is opened by somebody who cannot sign in, so the
  -- row has to be resolved to its organization before any tenant scope can be opened. The resolver
  -- returns the id, the organization and the user — never `used_at` or `expires_at`, so the read
  -- this GRANT enables cannot answer whether a token is still usable.
  definer_reads CONSTANT text[] := ARRAY[
    'users', 'organizations', 'sessions', 'password_reset_tokens'
  ];

  -- The marker a migration puts on a SECURITY DEFINER function of this project, and the whole of
  -- the classifier for the loop in step 7. See «"OF THIS PROJECT"» in the header.
  resolver_marker CONSTANT text := 'bad-crm:auth-resolver';

  rel record;
  grantee text;
  granted_tables    int := 0;
  granted_sequences int := 0;
  granted_functions int := 0;
  -- Counted so the summary says so: a `RAISE WARNING` scrolls past in a deploy log, and step 7a
  -- lets an extension's unpinned `search_path` through on purpose.
  unpinned_extension_functions int := 0;
BEGIN
  -- A missing role turns every GRANT below into an error that names the object rather than the
  -- cause. Fail once, with the real reason: the bootstrap has not been run against this cluster.
  FOR rel IN
    SELECT r.name FROM unnest(ARRAY['app_user', 'app_auth', 'app_auth_definer', 'backup_role'])
           AS r(name)
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

    -- 1b. The authentication resolvers read three tables and must keep reading them after a
    --     restore. REVOKE on everything else, because this role bypasses row-level security: a
    --     table that drifted onto its list would be readable across every organization at once.
    IF rel.relname = ANY (definer_reads) THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO app_auth_definer', rel.relname);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM app_auth_definer', rel.relname);
    END IF;

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

    ELSIF rel.relname = '_prisma_migrations' THEN
      -- 4b. Prisma's own bookkeeping, and the one non-tenant table the application reads.
      --
      --     The readiness probe runs as app_user and asks whether the shape this build expects is
      --     applied (`migration-readiness.adapter.ts`). Without this GRANT the query fails with
      --     `permission denied`, so a correctly installed, fully migrated installation answered
      --     `/ready` with `migrations: down` for ever and never entered the load balancer's
      --     rotation. The unit tests could not see it: they pass a fake client that answers with
      --     rows, and the failure is in the privilege of the connection, not in the comparison.
      --
      --     SELECT and nothing else. An application that could write this table could mark a failed
      --     migration as finished — hiding the state from the probe whose whole job is to notice it.
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO app_user', rel.relname);
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM app_user',
                     rel.relname);

    ELSIF rel.is_tenant_table OR rel.relname = ANY (global_read) THEN
      -- 5. Ordinary tenant table. TRUNCATE is never granted: it ignores row-level security, so one
      --    TRUNCATE would empty the table for every organization at once.
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO app_user',
                     rel.relname);
      EXECUTE format('REVOKE TRUNCATE ON TABLE public.%I FROM app_user', rel.relname);
    END IF;
    -- Anything else (a table with row-level security disabled and no entry in global_read) is
    -- readable by the backup and invisible to the application. Since 2026-08-05 there is no such
    -- table: `_prisma_migrations` is handled by 4b above, and it was the only one.
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

  -- 7a. The audit of **every** SECURITY DEFINER function in `public`, and the two ways it stops.
  --
  --     Every such function is a piece of borrowed authority, so each one is classified here before
  --     anything is modified. Three properties decide what happens: whether it belongs to an
  --     extension, whether its `search_path` is pinned, and whether it carries this project's
  --     marker.
  --
  --     (1) NOT AN EXTENSION'S, NO PINNED `search_path` → refuse.
  --         The caller can put their own table in front of the one the body names and have it read
  --         with the owner's rights. No ALTER this file could issue would make that safe, so it
  --         stops the deployment.
  --
  --     (2) NOT AN EXTENSION'S, NO MARKER → refuse. **This is the fail-closed step.**
  --         The marker is the whole of the classifier in 7b, and a marker is a COMMENT — one
  --         `pg_dump --no-comments` removes it. That flag is not exotic: the restore procedure
  --         already filters `COMMENT ON EXTENSION` records out of the dump's table of contents, and
  --         `--no-comments` is the obvious-looking shortcut for the same problem.
  --
  --         Reproduced on PostgreSQL 16.14 before this branch existed. A restore from
  --         `pg_dump -Fc --no-owner --no-privileges --no-comments` leaves all three resolvers owned
  --         by app_migrator with `proacl = NULL` — which is `EXECUTE` for PUBLIC. 7b then matched
  --         nothing, this file printed `grants applied: 6 tables, 0 sequences, 0 security definer
  --         functions` and **exited 0**. `app_user` — the role every HTTP request runs as, and the
  --         role an SQL injection runs as — could call `auth_lookup_users_by_email`; under
  --         `SET app.maintenance = 'on'` the body, now executing as app_migrator, returned every
  --         account of every organization together with its `password_hash`.
  --
  --         So the loss of the property this file's safety rests on must stop the deployment rather
  --         than be reported as success. The same branch catches a `SECURITY DEFINER` function this
  --         project did not write: this file cannot tell the two apart, and neither may be left in
  --         `public` executable by PUBLIC.
  --
  --     (3) AN EXTENSION'S → never refuse; warn if the `search_path` is not pinned.
  --         An unpinned `search_path` is the same defect whoever wrote it, but an operator cannot
  --         fix an extension's function: `ALTER FUNCTION` on it is undone by the next
  --         `ALTER EXTENSION … UPDATE`, and dropping it drops the extension. Refusing made
  --         `pnpm db:grants` unrunnable for as long as pgaudit / pg_cron / postgis was installed —
  --         and this file is the *only* way privileges come back after a restore. The database would
  --         return with all its data, the application would see no table at all, and the repair
  --         would be unavailable. Measured on PostgreSQL 16.14 with such a function added to an
  --         extension by `ALTER EXTENSION … ADD FUNCTION`: the whole run aborted. A warning that
  --         reaches the operator and a finished repair is strictly better than neither.
  --
  --         An extension's function is not required to carry the marker: 7b excludes extension
  --         members from the repair anyway, so there is nothing to classify.
  FOR rel IN
    SELECT p.oid::regprocedure::text        AS signature,
           pg_get_userbyid(p.proowner)      AS owner,
           (SELECT e.extname
              FROM pg_depend d
              JOIN pg_extension e ON e.oid = d.refobjid
             WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
                                            AS extension,
           (p.proconfig IS NOT NULL
            AND EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c(setting)
                         WHERE c.setting LIKE 'search\_path=%'))
                                            AS search_path_pinned,
           coalesce(obj_description(p.oid, 'pg_proc'), '') LIKE '%' || resolver_marker || '%'
                                            AS marked
    FROM   pg_proc p
    JOIN   pg_namespace n ON n.oid = p.pronamespace
    WHERE  n.nspname = 'public'
      AND  p.prosecdef
    ORDER  BY 1
  LOOP
    IF rel.extension IS NOT NULL THEN
      IF NOT rel.search_path_pinned THEN
        unpinned_extension_functions := unpinned_extension_functions + 1;

        RAISE WARNING
          'SECURITY DEFINER function % (owner %, from extension %) has no fixed search_path. Not repaired and not refused: an extension owns it, so no ALTER survives the next extension update — and refusing would leave this database with no privileges at all. Treat it as a finding against that extension (docs/security/rls-design.md).',
          rel.signature,
          rel.owner,
          rel.extension;
      END IF;

      CONTINUE;
    END IF;

    IF NOT rel.search_path_pinned THEN
      RAISE EXCEPTION
        'SECURITY DEFINER function % (owner %, not from an extension) has no fixed search_path — add SET search_path = pg_catalog, public (docs/security/rls-design.md)',
        rel.signature,
        rel.owner;
    END IF;

    IF NOT rel.marked THEN
      RAISE EXCEPTION
        'SECURITY DEFINER function % (owner %, not from an extension) carries no % marker, so this file cannot tell whether it is one of this project''s resolvers or somebody else''s function — and either way it is EXECUTE-able by PUBLIC by default. If it is ours, a restore stripped the COMMENT: restore the dump without --no-comments, or re-apply the COMMENT ON FUNCTION line from the migration that creates it. If it is not ours, it does not belong in public unrevoked. Refusing rather than reporting success (docs/security/rls-design.md).',
        rel.signature,
        rel.owner,
        resolver_marker;
    END IF;
  END LOOP;

  -- 7b. The repair, over this project's own resolvers.
  --
  --     PostgreSQL requires the *new* owner to hold CREATE on the function's schema, and app_auth
  --     deliberately holds only USAGE: a BYPASSRLS role able to create objects is a wider credential
  --     than this one is meant to be. So the privilege is taken for the duration of the loop and
  --     given back — this file is one transaction, so nothing outside it ever sees the grant.
  --
  --     Still walked out of the catalog rather than listed by name: a resolver added by a future
  --     migration is covered the moment it exists, provided it carries the marker comment the
  --     header describes. The extension exclusion is belt and braces next to that — nothing an
  --     extension ships would carry this project's marker, and the day one somehow does, this file
  --     must not take ownership of it.
  EXECUTE 'GRANT CREATE ON SCHEMA public TO app_auth_definer';

  FOR rel IN
    SELECT p.oid,
           p.proname,
           p.oid::regprocedure::text   AS signature,
           pg_get_userbyid(p.proowner) AS owner
    FROM   pg_proc p
    JOIN   pg_namespace n ON n.oid = p.pronamespace
    WHERE  n.nspname = 'public'
      AND  p.prosecdef
      AND  coalesce(obj_description(p.oid, 'pg_proc'), '') LIKE '%' || resolver_marker || '%'
      AND  NOT EXISTS (SELECT 1
                         FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass
                          AND d.objid   = p.oid
                          AND d.deptype = 'e')
    ORDER  BY p.proname
  LOOP
    -- Privileges are issued by whoever owns the function *right now*, which is app_migrator on a
    -- freshly restored database and app_auth_definer on a healthy one. `SET LOCAL ROLE` picks the
    -- one that can, instead of this file working only in the state it was written against —
    -- `REVOKE` on a function you do not own is `42501`, and the restore path is exactly the path
    -- nobody rehearses. Both of those owners are roles app_migrator may become; the classifier
    -- above is what keeps a third one, which it may not, out of this statement.
    --
    -- A third owner is possible in one situation only — a restore run by somebody other than
    -- app_migrator — and it must not surface as a bare `permission denied to set role` from inside
    -- a DO block. Named here instead, with the fix: re-own the function, or re-run the restore as
    -- the role that owns the schema.
    IF rel.owner NOT IN ('app_migrator', 'app_auth_definer') THEN
      RAISE EXCEPTION
        'resolver % is owned by % — this file can only re-own objects held by app_migrator or app_auth_definer. Restore the dump as app_migrator, or ALTER FUNCTION % OWNER TO app_migrator first.',
        rel.signature, rel.owner, rel.signature;
    END IF;

    EXECUTE format('SET LOCAL ROLE %I', rel.owner);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', rel.signature);

    FOREACH grantee IN ARRAY security_definer_grantees LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', rel.signature, grantee);
    END LOOP;

    RESET ROLE;

    -- Ownership last, and only when it moved: `ALTER … OWNER TO` also requires being the owner, so
    -- doing it first would leave the statements above unable to run. PostgreSQL rewrites the ACL on
    -- transfer, substituting the new owner for the old one, so the grants just made survive it.
    IF rel.owner <> 'app_auth_definer' THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO app_auth_definer', rel.signature);
    END IF;

    granted_functions := granted_functions + 1;
  END LOOP;

  EXECUTE 'REVOKE CREATE ON SCHEMA public FROM app_auth_definer';

  RAISE NOTICE 'grants applied: % tables, % sequences, % security definer functions',
    granted_tables, granted_sequences, granted_functions;

  IF unpinned_extension_functions > 0 THEN
    RAISE NOTICE
      '% SECURITY DEFINER function(s) of installed extensions have no fixed search_path — see the warnings above',
      unpinned_extension_functions;
  END IF;
END $grants$;

COMMIT;
