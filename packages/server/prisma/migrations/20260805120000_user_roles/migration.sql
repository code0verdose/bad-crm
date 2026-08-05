SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

-- Which person holds which role — layer 2 of the permission model, applied to people.
--
-- The row carries **who granted it and when**, and that is not bookkeeping: «why does this person
-- have access to finances» is answered from here plus the trail, and an assignment with no grantor
-- makes the question unanswerable the day the person who made it leaves.
--
-- `expires_at` is what makes a temporary grant temporary. It is enforced where the effective
-- permissions are assembled — `(expires_at IS NULL OR expires_at > now())` in the query, not only in
-- a cleanup job — because a job that has not run yet must not mean an expired role that still works.
CREATE TABLE "user_roles" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID           NOT NULL,
    "user_id"         UUID           NOT NULL,
    "role_id"         UUID           NOT NULL,
    -- Nullable: the owner's role is granted by the registration itself, which has no actor yet.
    "granted_by_id"   UUID,
    "granted_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "expires_at"      TIMESTAMPTZ(6),
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_user_roles" PRIMARY KEY ("id"),
    -- Composite, like every reference in this schema: foreign key checks bypass row-level security,
    -- so a child pointing at `users (id)` alone could name a person of another organization.
    CONSTRAINT "fk_user_roles_user_id" FOREIGN KEY ("organization_id", "user_id")
        REFERENCES "users" ("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "fk_user_roles_role_id" FOREIGN KEY ("organization_id", "role_id")
        REFERENCES "roles" ("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    -- The grantor is a person of the same organization, and the assignment outlives them: their
    -- account is deactivated rather than deleted, and if it ever is deleted the record of who
    -- granted what must not disappear with it.
    CONSTRAINT "fk_user_roles_granted_by_id" FOREIGN KEY ("organization_id", "granted_by_id")
        REFERENCES "users" ("organization_id", "id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "fk_user_roles_organization_id" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- One row per pair: assigning a role twice is the same assignment, not a second one. The uniqueness
-- is what makes the operation idempotent without the use-case reading first.
CREATE UNIQUE INDEX "uq_user_roles" ON "user_roles" ("user_id", "role_id");
-- The hot path: «what may this person do», asked on every request that is not cached.
CREATE INDEX "idx_user_roles_org_user" ON "user_roles" ("organization_id", "user_id");

ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "user_roles"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "user_roles"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_roles" TO app_user;
GRANT SELECT ON "user_roles" TO backup_role;

CREATE TRIGGER "trg_user_roles_updated_at" BEFORE UPDATE ON "user_roles"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
