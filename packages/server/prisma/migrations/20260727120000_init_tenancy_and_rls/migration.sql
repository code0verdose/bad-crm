-- bad-crm:initial-migration
--
-- The first migration of Bad CRM: extensions, the tenant root and one tenant-scoped table, each
-- with the complete row-level-security block of `docs/security/rls-design.md`.
--
-- The marker on the first line is read by the migration linter
-- (`test/support/migration-lint.util.ts`): it exempts this file — and only this file — from the
-- `CREATE INDEX CONCURRENTLY` requirement, because an index on an empty schema blocks nothing
-- (rules/db-migrations.mdc, «Исключения»). Every later migration builds indexes concurrently, in
-- a file of its own.
--
-- Applied by `app_migrator` through `prisma migrate deploy` (DATABASE_MIGRATION_URL). The roles it
-- grants to are created before the first migration by `prisma/sql/00-bootstrap-roles.sql`; the
-- grants below are repeated — and extended to partitions and sequences — by
-- `prisma/sql/01-grants.sql`, which is the source of truth for privileges and is re-run after
-- every migration and after every restore.

-- A lock wait is what turns a millisecond of catalog DDL into a two-minute outage: `ALTER TABLE`
-- queues behind a running query, and every statement behind it queues behind the `ALTER`. Better
-- to fail after three seconds and retry the deploy (rules/db-migrations.mdc, 7).
SET lock_timeout = '3s';
SET statement_timeout = '5min';

-- ─── extensions ───────────────────────────────────────────────────────────────────────────────
--
-- Asserted here, created for real by `prisma/sql/initdb/01-extensions.sql` under the superuser:
-- `vector` is not a trusted extension and cannot be created by `app_migrator`. `IF NOT EXISTS`
-- returns before any privilege check when the extension is already installed, so this is a no-op
-- on a bootstrapped database and a loud failure (`permission denied to create extension`) on one
-- where the bootstrap never ran — which is exactly the diagnosis wanted at that point.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── organizations ────────────────────────────────────────────────────────────────────────────

CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "default_currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_organizations" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_organizations_slug" ON "organizations" ("slug");

-- Partial, and therefore hand-written: Prisma cannot declare a `WHERE` clause on an index. It
-- serves the only list that exists over this table — live organizations — and stays small forever
-- (docs/architecture/data-model.md, «Мягкое удаление»).
CREATE INDEX "idx_organizations_deleted_at" ON "organizations" ("deleted_at")
  WHERE "deleted_at" IS NULL;

-- ─── teams ────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "teams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_teams" PRIMARY KEY ("id")
);

ALTER TABLE "teams" ADD CONSTRAINT "fk_teams_organization_id"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The target a future composite foreign key `(organization_id, team_id)` points at. Foreign key
-- checks run as the table owner and bypass RLS, so a child referencing `teams (id)` alone would be
-- allowed to point at a team of another organization (docs/security/rls-design.md, «Таблицы, у
-- которых organization_id есть только через родителя»).
CREATE UNIQUE INDEX "uq_teams_org_id" ON "teams" ("organization_id", "id");

-- Tenant-scoped uniqueness, partial because the table is softly deleted: a slug freed by deleting
-- a team has to be reusable.
CREATE UNIQUE INDEX "uq_teams_org_slug" ON "teams" ("organization_id", "slug")
  WHERE "deleted_at" IS NULL;

-- `organization_id` first: the RLS predicate is an equality on that column and is present in every
-- single query against this table, so the index that serves the application filter serves the
-- policy in the same pass (docs/security/rls-design.md, «Производительность»).
CREATE INDEX "idx_teams_org_name" ON "teams" ("organization_id", "name");

-- ─── row level security ───────────────────────────────────────────────────────────────────────
--
-- Created in the same migration as the tables, without exception. Between `CREATE TABLE` and
-- `CREATE POLICY` there must be no state in which the table exists and the isolation does not: a
-- deploy, a rollback or a seeder landing in that window reads across tenants
-- (rules/tenancy-rls.mdc, 3).

-- organizations: the tenant root has no `organization_id`, so the predicate is its own primary
-- key. `DELETE` is not granted — deleting an organization is an `app_migrator` operation.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
-- Without FORCE the owner ignores its own policies, silently. A connection made as the owner —
-- a wrong DATABASE_URL, a manual psql, a maintenance script — then reads every organization, and
-- nothing anywhere reports it (invariant 1 of CLAUDE.md).
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_self" ON "organizations"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "organizations"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

GRANT SELECT, INSERT, UPDATE ON "organizations" TO app_user;
-- BYPASSRLS skips policies, not privilege checks, and ALTER DEFAULT PRIVILEGES is forbidden here.
-- Without this line `pg_dump` fails on `LOCK TABLE` and the table is missing from the backup.
GRANT SELECT ON "organizations" TO backup_role;

-- teams: the canonical five-block template. Read `WITH CHECK` as the half that keeps a row from
-- being written into — or moved into — another organization; `USING` alone only hides rows.
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "teams" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "teams"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "teams"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

-- TRUNCATE is never granted to anybody: it ignores row-level security entirely, so one statement
-- would empty a table for every organization at once.
GRANT SELECT, INSERT, UPDATE, DELETE ON "teams" TO app_user;
GRANT SELECT ON "teams" TO backup_role;
