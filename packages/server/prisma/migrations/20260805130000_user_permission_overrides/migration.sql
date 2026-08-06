SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

-- Layer 3 of the permission model: one exception, for one person, on one permission.
--
-- This is what closes «custom per user» without inventing a role for every difference — the failure
-- mode of RBAC where an organization ends up with `manager_without_finance_2` and nobody can say
-- what any of the forty roles mean.
--
-- Four properties are enforced by the schema rather than by agreement:
--
--   * **one opinion per key.** `uq_user_permission_overrides (user_id, permission_key)` makes «two
--     different opinions about the same right» impossible, so «which one wins» is never asked;
--   * **a reason, and a real one.** `CHECK (length(btrim(reason)) >= 10)`: without it nobody
--     remembers six months later why somebody lost a right, and every override becomes permanent;
--   * **no DENY on the owner.** The trigger below refuses it even from a direct SQL session — the
--     use-case refuses it too, and the trigger is what makes «the organization cannot be locked out
--     of itself» a property of the database rather than of the code that happens to run;
--   * **expiry is data, not a job.** The partial index serves the cleaner; the filter that makes an
--     expired override stop granting lives in the query that assembles permissions.
CREATE TYPE "OverrideEffect" AS ENUM ('ALLOW', 'DENY');

CREATE TABLE "user_permission_overrides" (
    "id"              UUID             NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID             NOT NULL,
    "user_id"         UUID             NOT NULL,
    -- References the catalogue by name, like `role_permissions`: a readable identifier survives a
    -- rebuilt catalogue, and a key removed from the code is marked deprecated rather than deleted
    -- precisely so rows like this one keep their target.
    "permission_key"  TEXT             NOT NULL,
    "effect"          "OverrideEffect" NOT NULL,
    "reason"          TEXT             NOT NULL,
    -- Nullable for the same reason as in `user_roles`: the record outlives the account that made it.
    "granted_by_id"   UUID,
    "granted_at"      TIMESTAMPTZ(6)   NOT NULL DEFAULT now(),
    "expires_at"      TIMESTAMPTZ(6),
    "created_at"      TIMESTAMPTZ(6)   NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6)   NOT NULL,

    CONSTRAINT "pk_user_permission_overrides" PRIMARY KEY ("id"),
    CONSTRAINT "ck_user_permission_overrides_reason" CHECK (length(btrim("reason")) >= 10),
    CONSTRAINT "fk_upo_user_id" FOREIGN KEY ("organization_id", "user_id")
        REFERENCES "users" ("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "fk_upo_granted_by_id" FOREIGN KEY ("organization_id", "granted_by_id")
        REFERENCES "users" ("organization_id", "id") ON DELETE SET NULL ON UPDATE NO ACTION,
    CONSTRAINT "fk_upo_organization_id" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "fk_upo_permission_key" FOREIGN KEY ("permission_key")
        REFERENCES "permissions" ("key") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- Also the index for «every exception of this person»: `user_id` leads it, so a second index on the
-- same leading column would cost every write and answer nothing new (`data-model.md` names exactly
-- these two, and the registry test refuses a third).
-- One line each, deliberately: the migration linter exempts an index from `CONCURRENTLY` only when
-- the `ON <table>` clause sits on the same line and names a table this file just created. A split
-- statement is reported, and the rule is fail-closed on purpose — an index built without
-- `CONCURRENTLY` on a table that already has rows locks it for writes.
CREATE UNIQUE INDEX "uq_user_permission_overrides" ON "user_permission_overrides" ("user_id", "permission_key");
-- Partial: the cleaner asks «what has expired», and rows without an expiry are never the answer.
CREATE INDEX "idx_upo_expires" ON "user_permission_overrides" ("expires_at") WHERE "expires_at" IS NOT NULL;

/**
 * The owner cannot be denied anything — enforced where the code cannot get around it.
 *
 * §5 of the permission model states it twice, and the second time is this trigger: a DENY on the
 * owner would make «owner неотзываем» false, and the way an organization becomes unadministrable is
 * one row written by a script, a restore, or a use-case somebody edited without reading the model.
 * Ownership is read from `organizations.owner_id`, which is the same source the policy layer uses.
 */
CREATE OR REPLACE FUNCTION refuse_owner_deny()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.effect = 'DENY'
     AND NEW.user_id = (SELECT owner_id FROM organizations WHERE id = NEW.organization_id) THEN
    RAISE EXCEPTION 'owner_immutable: a DENY override cannot be written for the owner of the organization'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION refuse_owner_deny() IS
  'bad-crm:override-guard — refuses a DENY override on the owner (permission-model.md, §5)';

CREATE TRIGGER "ck_upo_not_owner"
  BEFORE INSERT OR UPDATE ON "user_permission_overrides"
  FOR EACH ROW EXECUTE FUNCTION refuse_owner_deny();

ALTER TABLE "user_permission_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_permission_overrides" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "user_permission_overrides"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "user_permission_overrides"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "user_permission_overrides" TO app_user;
GRANT SELECT ON "user_permission_overrides" TO backup_role;

CREATE TRIGGER "trg_user_permission_overrides_updated_at"
  BEFORE UPDATE ON "user_permission_overrides"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
