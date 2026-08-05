SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

-- Layer 2 of the permission model: roles, and what each of them grants.
--
-- Two tenant tables, both under the canonical five-block template of
-- `20260727120000_init_tenancy_and_rls` — `ENABLE` + `FORCE`, a policy with **both** predicates, an
-- explicit maintenance policy and explicit grants. `USING` alone hides rows; `WITH CHECK` is the
-- half that stops one being written into, or moved into, another organization.
--
-- `role_permissions` carries `organization_id` of its own rather than reaching it through `role_id`:
-- a policy that had to join would be a policy that can be defeated by a join, and the composite
-- foreign key below is what keeps the pair honest — foreign key checks bypass row-level security, so
-- a child referencing `roles (id)` alone could name a role of another organization.
CREATE TABLE "roles" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID           NOT NULL,
    "key"             TEXT           NOT NULL,
    "name"            TEXT           NOT NULL,
    "description"     TEXT,
    -- A system role is code, not data: its composition comes from `SYSTEM_ROLE_PERMISSIONS` and is
    -- re-applied on upgrade. The interface refuses to edit or delete one (`system_role_immutable`).
    "is_system"       BOOLEAN        NOT NULL DEFAULT false,
    -- The role a new member gets when nobody chooses one. At most one per organization.
    "is_default"      BOOLEAN        NOT NULL DEFAULT false,
    "priority"        INTEGER        NOT NULL DEFAULT 0,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_roles" PRIMARY KEY ("id"),
    CONSTRAINT "fk_roles_organization_id" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "uq_roles_org_key" ON "roles" ("organization_id", "key");
-- Partial: the question it answers is «which role is the default one», and it has one answer.
CREATE UNIQUE INDEX "idx_roles_org_default" ON "roles" ("organization_id") WHERE "is_default";
-- The target of every composite foreign key into this table (see `role_permissions` below).
CREATE UNIQUE INDEX "uq_roles_org_id" ON "roles" ("organization_id", "id");

CREATE TABLE "role_permissions" (
    -- A surrogate key, like every other table of this schema. The row is *identified* by the pair
    -- it joins — `uq_role_permissions` below is the real constraint — but the isolation proofs are
    -- generated from the registry and address a row by `id`, so a join table without one would be a
    -- tenant table nothing proves anything about (`docs/security/rls-design.md`, «Генератор
    -- isolation-тестов»).
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID           NOT NULL,
    "role_id"         UUID           NOT NULL,
    -- References the catalogue by name, not by uuid: a human-readable identifier survives a rebuild
    -- of the catalogue and keeps dumps readable (`docs/architecture/data-model.md`, group 2).
    "permission_key"  TEXT           NOT NULL,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    -- Every table in this schema carries both stamps (`docs/architecture/data-model.md`,
    -- «Timestamps и аудит строки»), and the isolation suite writes through it: a tenant table the
    -- application may update is a tenant table whose update has to be proven to stay inside.
    "updated_at"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_role_permissions" PRIMARY KEY ("id"),
    CONSTRAINT "fk_role_permissions_role_id" FOREIGN KEY ("organization_id", "role_id")
        REFERENCES "roles" ("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    -- Anchored to the organization directly as well: every tenant table names the organization it
    -- belongs to, and the composite key above proves the *role* is of that organization, not that
    -- the organization exists.
    CONSTRAINT "fk_role_permissions_organization_id" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    -- `NO ACTION` on the catalogue: a permission removed from the code is marked deprecated and kept
    -- precisely so that rows like this one survive (`docs/architecture/data-model.md`, group 2).
    CONSTRAINT "fk_role_permissions_permission_key" FOREIGN KEY ("permission_key")
        REFERENCES "permissions" ("key") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "uq_role_permissions" ON "role_permissions" ("role_id", "permission_key");
-- Plain, not covering. `INCLUDE (permission_key)` was the intention (`data-model.md` said
-- «покрывающий»), and Prisma's datamodel cannot express it: the schema and the migrations would then
-- disagree for ever, and every future `prisma migrate dev` would offer to drop and recreate this
-- index. A permanent drift between the two sources of the schema costs more than one index-only
-- scan, so the document was corrected instead.
CREATE INDEX "idx_role_permissions_org_role" ON "role_permissions" ("organization_id", "role_id");

ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "roles"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "roles"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "role_permissions"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "role_permissions"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

-- TRUNCATE is never granted: it ignores row-level security, so one statement would empty the table
-- for every organization at once.
GRANT SELECT, INSERT, UPDATE, DELETE ON "roles" TO app_user;
GRANT SELECT ON "roles" TO backup_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON "role_permissions" TO app_user;
GRANT SELECT ON "role_permissions" TO backup_role;

-- `updated_at` is kept by the database, not by the client: a row written by anything other than the
-- application — a repair statement, a restore, a future job — still carries the truth about when it
-- last changed. The function itself was created by
-- `20260728120000_auth_core_identity_and_sessions`.
CREATE TRIGGER "trg_roles_updated_at" BEFORE UPDATE ON "roles"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER "trg_role_permissions_updated_at" BEFORE UPDATE ON "role_permissions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
