-- 00-bootstrap-roles.sql · database roles of Bad CRM (docs/security/rls-design.md).
--
-- Executed by a superuser, once per installation, BEFORE the first Prisma migration: Prisma
-- connects as app_migrator, which therefore has to exist already. This is not a Prisma migration.
--
-- Idempotent: safe to re-run against an existing cluster. In development it is executed by
-- initdb/00-bootstrap-roles.sh when the pgdata volume is initialised, and on demand by
-- `pnpm db:bootstrap` against a running container; in a self-host install the operator runs it by
-- hand (or via the installer) against a managed PostgreSQL — hence the psql variables instead of
-- hardcoded values.
--
--   psql -v ON_ERROR_STOP=1 \
--        -v db_name=bad_crm \
--        -v migrator_pw="$APP_MIGRATOR_PASSWORD" \
--        -v app_pw="$APP_USER_PASSWORD" \
--        -v auth_pw="$APP_AUTH_PASSWORD" \
--        -v backup_pw="$BACKUP_ROLE_PASSWORD" \
--        -f 00-bootstrap-roles.sql
--
-- Prefer feeding those values over stdin (`\set` inside the stream) rather than on the command
-- line, as initdb/00-bootstrap-roles.sh does: argv is world-readable through `ps`.
--
-- Four roles, four reasons (docs/security/rls-design.md):
--   app_user     — the application process. Subject to RLS, owns nothing.
--   app_migrator — owns the schema and every object, runs migrations. Never used at runtime.
--   app_auth     — BYPASSRLS, but reaches no domain table: it only owns SECURITY DEFINER resolvers.
--   backup_role  — BYPASSRLS, read-only. pg_dump taken as the table owner under FORCE ROW LEVEL
--                  SECURITY silently produces a partial dump (docs/runbooks/backup-restore.md).

\set ON_ERROR_STOP on

-- Guard against a run with missing variables. psql substitutes an undefined variable with its own
-- literal text, so without this block a hand-run would happily set a password to `:'migrator_pw'`.
-- The failure is a RAISE and not `\quit 1`: psql (16) does not accept an exit code for `\quit`, it
-- prints `warning: \quit: extra argument "1" ignored` and terminates with status 0 — a guard that
-- reports success is worse than no guard. RAISE + ON_ERROR_STOP exits 3.
\if :{?db_name}
\else
DO $guard$ BEGIN RAISE EXCEPTION 'db_name is not set: pass -v db_name=<database>'; END $guard$;
\endif
\if :{?migrator_pw}
\else
DO $guard$ BEGIN RAISE EXCEPTION 'migrator_pw is not set: pass -v migrator_pw=<password>'; END $guard$;
\endif
\if :{?app_pw}
\else
DO $guard$ BEGIN RAISE EXCEPTION 'app_pw is not set: pass -v app_pw=<password>'; END $guard$;
\endif
\if :{?auth_pw}
\else
DO $guard$ BEGIN RAISE EXCEPTION 'auth_pw is not set: pass -v auth_pw=<password>'; END $guard$;
\endif
\if :{?backup_pw}
\else
DO $guard$ BEGIN RAISE EXCEPTION 'backup_pw is not set: pass -v backup_pw=<password>'; END $guard$;
\endif

-- Creation only creates. Every attribute that matters is (re-)applied unconditionally below.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user     LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    CREATE ROLE app_auth     LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_role') THEN
    CREATE ROLE backup_role  LOGIN;
  END IF;
END $$;

-- Attributes are asserted on EVERY run, not only at creation, and that is the whole point of this
-- block. A managed PostgreSQL instance gets reused: the roles may already exist, created by an
-- earlier install or by a human. A conditional `CREATE ROLE … NOINHERIT BYPASSRLS` skips silently in
-- that case and reports success, while app_user keeps whatever it had — INHERIT, possibly BYPASSRLS,
-- possibly a membership in app_migrator. That is a working `SET ROLE app_migrator` and no tenant
-- isolation at all, on an installation whose bootstrap printed nothing but green.
--
-- NOINHERIT plus the absence of mutual membership is the invariant: no role can `SET ROLE` into
-- another. The only way to obtain app_migrator's rights is to know its password, which lives in the
-- deploy pipeline and not in the application environment.
ALTER ROLE app_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
ALTER ROLE app_user     LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
ALTER ROLE app_auth     LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION   BYPASSRLS;
ALTER ROLE backup_role  LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION   BYPASSRLS;

-- Memberships granted by an earlier installation are removed here. NOINHERIT alone is not enough:
-- it only stops rights from being applied automatically — a member may still `SET ROLE` into the
-- granted role and get them, and `app_user` able to `SET ROLE app_migrator` is a full bypass of the
-- tenant isolation this whole file exists to establish.
--
-- Driven off pg_auth_members rather than written out as twelve `REVOKE a FROM b` statements: those
-- are idempotent too, but each one that has nothing to revoke prints a WARNING, so a clean install
-- would end with twelve warnings and nobody would read the thirteenth.
DO $memberships$
DECLARE
  membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
    FROM   pg_auth_members am
    JOIN   pg_roles granted ON granted.oid = am.roleid
    JOIN   pg_roles member  ON member.oid  = am.member
    WHERE  granted.rolname IN ('app_migrator', 'app_user', 'app_auth', 'backup_role')
      AND  member.rolname  IN ('app_migrator', 'app_user', 'app_auth', 'backup_role')
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.granted_role, membership.member_role);
    RAISE WARNING 'removed membership of % in % left by an earlier installation',
      membership.member_role, membership.granted_role;
  END LOOP;
END $memberships$;

-- `ALTER ROLE … PASSWORD '<value>'` is DDL, so a server running with `log_statement = ddl` (or
-- `all`) writes the four passwords into its log verbatim — verified against PostgreSQL 16.14. The
-- setting is silenced for this session only; a managed instance where the bootstrap runs without
-- superuser rights refuses the change, which is a NOTICE and not a reason to stop — the operator
-- then knows to rotate or to purge that log.
DO $silence$
BEGIN
  PERFORM set_config('log_statement', 'none', false);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'log_statement could not be silenced: role passwords may appear in the server log';
END $silence$;

-- Passwords are re-applied on every run: that makes rotation the same command as bootstrap.
-- The value stays on its own line, exactly as in docs/security/rls-design.md: `PASSWORD '<value>'`
-- on a single line is the shape secret scanners look for, and this file must stay scannable.
ALTER ROLE app_migrator PASSWORD
  :'migrator_pw';
ALTER ROLE app_user     PASSWORD
  :'app_pw';
ALTER ROLE app_auth     PASSWORD
  :'auth_pw';
ALTER ROLE backup_role  PASSWORD
  :'backup_pw';

-- Resource limits belong to the role, not to the application: then they also apply to a stray psql
-- session and to a forgotten script. An idle transaction holding app.organization_id is a security
-- problem, not only a performance one.
ALTER ROLE app_user     SET statement_timeout                   = '5s';
ALTER ROLE app_user     SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE app_user     SET lock_timeout                        = '3s';
ALTER ROLE app_user     SET search_path                         = public;

ALTER ROLE app_auth     SET statement_timeout                   = '3s';
ALTER ROLE app_auth     SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE app_auth     SET search_path                         = public;

ALTER ROLE app_migrator SET statement_timeout                   = 0;     -- migrations run long
ALTER ROLE app_migrator SET lock_timeout                        = '5s';  -- but never queue on a lock
ALTER ROLE app_migrator SET search_path                         = public;

-- A dump of a large database runs for minutes and must never be cut short by a timeout, so
-- backup_role gets none. It is read-only by grants, not by attributes.
ALTER ROLE backup_role  SET statement_timeout                   = 0;
ALTER ROLE backup_role  SET search_path                         = public;

-- The database belongs to the migrator and PUBLIC has nothing on it. CREATE DATABASE cannot run
-- inside a DO block, so the conditional create goes through \gexec; the ALTER below then makes the
-- ownership correct whether the database was just created or pre-existed (the Docker entrypoint
-- creates POSTGRES_DB before this script runs).
SELECT format('CREATE DATABASE %I OWNER app_migrator', :'db_name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name')\gexec

ALTER DATABASE :"db_name" OWNER TO app_migrator;
REVOKE ALL   ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO app_user, app_auth, backup_role;

\connect :"db_name"

ALTER SCHEMA public OWNER TO app_migrator;
REVOKE ALL   ON SCHEMA public FROM PUBLIC;  -- PG15+ already drops CREATE for PUBLIC; make it explicit
GRANT  USAGE ON SCHEMA public TO app_user, app_auth, backup_role;

-- backup_role deliberately receives no table grant here. BYPASSRLS skips the policies, not the
-- GRANT check, and ALTER DEFAULT PRIVILEGES is forbidden by docs/security/rls-design.md — so every
-- migration that creates a table carries its own `GRANT SELECT ON <table> TO backup_role;`, right
-- next to the ENABLE/FORCE/POLICY/GRANT block of the canonical template. Without that line the
-- table is missing from the dump, quietly.
