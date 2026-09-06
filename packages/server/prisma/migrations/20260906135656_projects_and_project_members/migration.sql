-- EPIC-014 — the two tables everything else in the epic stands on: a project, and who is on it.
--
-- An EXPAND step (`rules/db-migrations.mdc`, 2): two new tables and nothing else. Nothing is
-- dropped, renamed or narrowed by this file. Indexes are created without CONCURRENTLY because both
-- tables are born here and empty (rule 6 is about a table that is not; rule 13 says the indexes
-- come with the table).
--
-- Names, columns and indexes follow `docs/architecture/data-model.md` §3 («Проекты»). Two things
-- the model names are deliberately absent, and both are recorded there and in STORY-014-01:
--   * `client_id` and `idx_projects_org_client` — the `clients` table arrives with STORY-014-07,
--     and a uuid column with no composite key to point at would be a reference nothing checks
--     (`rules/tenancy-rls.mdc`, 7). Adding a nullable column later is a pure expand step.
--   * the global `deleted_at IS NULL` filter via Prisma `$extends` — the tree has none; the
--     repositories filter explicitly and the unit suite holds the filter in place.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- projects
CREATE TABLE "projects" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID           NOT NULL,
    -- Stored **normalized**: upper-case, no whitespace, `^[A-Z][A-Z0-9]{1,9}$`. The value object of
    -- STORY-014-01 trims and upper-cases what the client sent; the CHECK is what stops a raw write
    -- from storing `bad` beside `BAD` and defeating the unique index below. Never updated: the key is
    -- half of every task number (`BAD-14`).
    "key"             TEXT           NOT NULL,
    "name"            TEXT           NOT NULL,
    "description"     TEXT,
    -- Text with a CHECK rather than a PostgreSQL enum, the choice `team_role` made: adding a value to
    -- an enum is DDL on a type every table using it depends on. The lists are the model's, verbatim.
    "status"          TEXT           NOT NULL DEFAULT 'ACTIVE',
    "visibility"      TEXT           NOT NULL DEFAULT 'PUBLIC_ORG',
    "lead_id"         UUID           NOT NULL,
    "started_at"      TIMESTAMPTZ(6),
    "due_at"          TIMESTAMPTZ(6),
    "color"           TEXT           NOT NULL,
    -- Incremented by `UPDATE … SET task_counter = task_counter + 1 RETURNING task_counter` in the
    -- transaction that inserts a task. Not a sequence: a sequence is global and leaves holes on
    -- rollback, and `BAD-14` must not vanish because a neighbour's transaction failed.
    "task_counter"    INTEGER        NOT NULL DEFAULT 0,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6) NOT NULL,
    "deleted_at"      TIMESTAMPTZ(6),

    CONSTRAINT "pk_projects" PRIMARY KEY ("id"),
    CONSTRAINT "ck_projects_key_format" CHECK ("key" ~ '^[A-Z][A-Z0-9]{1,9}$'),
    CONSTRAINT "ck_projects_status" CHECK ("status" IN ('ACTIVE', 'ON_HOLD', 'ARCHIVED', 'CLOSED')),
    CONSTRAINT "ck_projects_visibility" CHECK ("visibility" IN ('PUBLIC_ORG', 'PRIVATE')),
    CONSTRAINT "ck_projects_task_counter" CHECK ("task_counter" >= 0),
    -- The target every composite foreign key into this table points at: a child referencing
    -- `projects (id)` alone could name a project of another organization, because foreign key
    -- checks run as the table owner and bypass row-level security (rules/tenancy-rls.mdc, 7).
    CONSTRAINT "uq_projects_org_id" UNIQUE ("organization_id", "id"),
    -- Composite for the same reason, and NO ACTION both ways like the owner of an organization: a
    -- person who leads a project is not deleted, the lead is transferred first. ON UPDATE is
    -- NO ACTION because the referenced key is an immutable uuid and a cascade could only ever move
    -- this row across a tenant boundary unseen (`migrations.test.ts`, «foreign keys»).
    CONSTRAINT "fk_projects_lead_id" FOREIGN KEY ("organization_id", "lead_id")
        REFERENCES "users" ("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "fk_projects_organization_id" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- Partial: a key freed by deleting the project is usable again, while «unique inside the
-- organization» still holds among live projects. Unique with `organization_id`, never globally —
-- only a server-generated value may be globally unique (`rls-design.md`, restriction 7), and a
-- global key would tell one tenant which names another had taken.
CREATE UNIQUE INDEX "uq_projects_org_key" ON "projects" ("organization_id", "key")
    WHERE "deleted_at" IS NULL;
-- The list screen's question: «the live projects of this organization, by status».
CREATE INDEX "idx_projects_org_status" ON "projects" ("organization_id", "status")
    WHERE "deleted_at" IS NULL;
-- The foreign key, indexed (rules/db-migrations.mdc, 13): «which projects does this person lead»
-- is asked by offboarding and by lead transfer.
CREATE INDEX "idx_projects_org_lead" ON "projects" ("organization_id", "lead_id");

ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "projects"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "projects"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "projects" TO app_user;
GRANT SELECT ON "projects" TO backup_role;

CREATE TRIGGER "trg_projects_updated_at" BEFORE UPDATE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- project_members — «this person is on this project, in this role»
--
-- Unlike `team_members`, a row here is never deleted by the product: a membership **ends**
-- (`left_at`), because the row is history and a link target — time entries, comments and the
-- audit trail will point at it (`data-model.md` §3). What «the team» means is therefore always
-- `left_at IS NULL`, and the unique index below is partial on exactly that so the same person can
-- come back as a new row.
CREATE TABLE "project_members" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID           NOT NULL,
    "project_id"      UUID           NOT NULL,
    "user_id"         UUID           NOT NULL,
    -- `LEAD` | `MEMBER` | `REVIEWER` | `OBSERVER` — the source of the implicit access level
    -- (`permission-model.md` §5). The mapping to a level is the policy's, not the column's.
    "project_role"    TEXT           NOT NULL DEFAULT 'MEMBER',
    -- 0…100. The sum across a person's projects is not limited in M2 (STORY-014-02, 9).
    "allocation_pct"  INTEGER        NOT NULL DEFAULT 100,
    "joined_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "left_at"         TIMESTAMPTZ(6),
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_project_members" PRIMARY KEY ("id"),
    CONSTRAINT "ck_project_members_role"
        CHECK ("project_role" IN ('LEAD', 'MEMBER', 'REVIEWER', 'OBSERVER')),
    CONSTRAINT "ck_project_members_allocation"
        CHECK ("allocation_pct" BETWEEN 0 AND 100),
    -- Composite, like every reference in this schema: foreign key checks bypass row-level security,
    -- so a child pointing at `projects (id)` alone could name a project of another organization.
    -- CASCADE from the project: the product soft-deletes projects, so this fires only under the
    -- migrator's physical removal, and a membership of a project that no longer exists is not worth
    -- keeping.
    CONSTRAINT "fk_project_members_project_id" FOREIGN KEY ("organization_id", "project_id")
        REFERENCES "projects" ("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    -- CASCADE from the person as well, as `team_members` does: a deleted account leaves no
    -- membership behind.
    CONSTRAINT "fk_project_members_user_id" FOREIGN KEY ("organization_id", "user_id")
        REFERENCES "users" ("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "fk_project_members_organization_id" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- One **live** row per pair. Partial on `left_at IS NULL`: joining twice is the same membership,
-- leaving and coming back is a second row. The repository's `INSERT … ON CONFLICT (project_id,
-- user_id) WHERE left_at IS NULL DO NOTHING` names this predicate — that is how PostgreSQL infers a
-- partial index — and is what makes two concurrent adds of one pair leave exactly one row.
CREATE UNIQUE INDEX "uq_project_members" ON "project_members" ("project_id", "user_id")
    WHERE "left_at" IS NULL;
-- «My projects»: the question the sidebar and the access policy ask on every request.
CREATE INDEX "idx_project_members_org_user" ON "project_members" ("organization_id", "user_id");

ALTER TABLE "project_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_members" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "project_members"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "project_members"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "project_members" TO app_user;
GRANT SELECT ON "project_members" TO backup_role;

CREATE TRIGGER "trg_project_members_updated_at" BEFORE UPDATE ON "project_members"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
