-- EPIC-012 — кадровая запись человека, отдельно от учётной записи.
--
-- An EXPAND step (`rules/db-migrations.mdc`, 2): one new table. Nothing is dropped, renamed or
-- narrowed, so the previous release keeps running against this schema.
--
-- WHY IT IS A SEPARATE TABLE — `docs/architecture/data-model.md`, «Почему `User` и
-- `EmployeeProfile` разделены», in one line: not every account is an employee. A contractor, a
-- client representative with access to one project and an integration bot have no `hired_at` and no
-- manager, and nullable HR columns on `users` would mean the schema does not say so.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE "employee_profiles" (
    "id"                    UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id"       UUID           NOT NULL,
    "user_id"               UUID           NOT NULL,

    -- The name of the person, and the only place it exists. `users` carries none: a name takes part
    -- in no decision about access, and every screen that shows a human reads this table anyway.
    -- Required — an empty string is not a name — while the fields below are not: a contractor has
    -- no job title and no hiring date.
    "first_name"            TEXT           NOT NULL,
    "last_name"             TEXT           NOT NULL,
    "job_title"             TEXT,
    "department"            TEXT,
    "manager_id"            UUID,

    -- Hours a week this person is planned against. `CHECK 0…80` here **and** in the Zod schema:
    -- the schema answers the person editing the form, the constraint answers everything else that
    -- can ever write to this column (`rules/zod-validation.mdc` — validation at the boundary, the
    -- invariant in the database).
    "weekly_capacity_hours" INTEGER        NOT NULL DEFAULT 40,
    -- `FULL_TIME` | `PART_TIME` | `CONTRACTOR` | `INTERN`. Text with a CHECK rather than a
    -- PostgreSQL enum: adding a value to an enum is DDL on a type every user of it depends on.
    "employment_type"       TEXT           NOT NULL DEFAULT 'FULL_TIME',
    "hired_at"              DATE,
    -- Set on offboarding (STORY-012-05). The account is suspended, never deleted: time entries,
    -- tasks, invoices and the audit trail reference this person for years.
    "terminated_at"         DATE,
    "timezone"              TEXT           NOT NULL DEFAULT 'UTC',
    -- Searchable «who knows postgres», not a nomenclature: an array with a GIN index rather than a
    -- join table, until levels or endorsements make it an entity of its own.
    "skills"                TEXT[]         NOT NULL DEFAULT '{}',

    -- **Ciphertext only.** `v1:<iv>:<tag>:<ciphertext>`, AES-256-GCM under `APP_ENCRYPTION_KEY`
    -- (`CLAUDE.md`, «Что шифруется»). There is no plaintext column and there never was one: an
    -- emergency contact is somebody else's personal data, held for one purpose, and a dump of this
    -- table must not be a list of relatives' phone numbers.
    "emergency_contact_enc" TEXT,

    "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"            TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_employee_profiles" PRIMARY KEY ("id"),
    CONSTRAINT "ck_employee_profiles_capacity" CHECK (
        "weekly_capacity_hours" BETWEEN 0 AND 80
    ),
    CONSTRAINT "ck_employee_profiles_employment_type" CHECK (
        "employment_type" IN ('FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'INTERN')
    ),
    -- Nobody manages themselves. The database says so because the check is free here and because a
    -- one-node cycle is the one case a recursive walk would have to special-case.
    CONSTRAINT "ck_employee_profiles_manager_not_self" CHECK ("manager_id" IS DISTINCT FROM "user_id"),
    -- A person cannot leave before they arrived.
    CONSTRAINT "ck_employee_profiles_employment_period" CHECK (
        "terminated_at" IS NULL OR "hired_at" IS NULL OR "terminated_at" >= "hired_at"
    ),
    CONSTRAINT "fk_employee_profiles_organization_id" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    -- Composite, like every reference in this schema: foreign key checks run as the table owner and
    -- bypass row-level security, so a single-column reference could name a person of another
    -- organization. CASCADE, because a profile without its account is a record about nobody.
    CONSTRAINT "fk_employee_profiles_user_id" FOREIGN KEY ("organization_id", "user_id")
        REFERENCES "users" ("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    -- The manager is a person of the same organization, and RESTRICT rather than SET NULL: an
    -- account that still manages somebody is not deleted quietly — reassign first. (SET NULL is not
    -- available anyway: the pair carries the non-nullable `organization_id`.)
    CONSTRAINT "fk_employee_profiles_manager_id" FOREIGN KEY ("organization_id", "manager_id")
        REFERENCES "users" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- 1:1 with the account, which is what makes «the profile of this person» a lookup rather than a
-- question about which row to take. The tenant leads the pair, like every composite index in this
-- schema (invariant 1 of CLAUDE.md): a person belongs to one organization, so the pair is exactly as
-- restrictive as `user_id` alone would be, and it is the key Prisma's 1:1 relation points at.
CREATE UNIQUE INDEX "uq_employee_profiles_user" ON "employee_profiles" ("organization_id", "user_id");
-- «Кто подчиняется этому человеку» — the org chart walks this in both directions.
CREATE INDEX "idx_employee_profiles_org_manager" ON "employee_profiles" ("organization_id", "manager_id");
-- The directory shows people who still work here, and that is most reads of this table.
CREATE INDEX "idx_employee_profiles_org_active" ON "employee_profiles" ("organization_id", "last_name") WHERE "terminated_at" IS NULL;
-- «Кто умеет postgres». GIN, because the predicate is `skills && ARRAY[...]` rather than equality.
CREATE INDEX "idx_employee_profiles_skills" ON "employee_profiles" USING gin ("skills");

ALTER TABLE "employee_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_profiles" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "employee_profiles"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "employee_profiles"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "employee_profiles" TO app_user;
GRANT SELECT ON "employee_profiles" TO backup_role;

CREATE TRIGGER "trg_employee_profiles_updated_at"
  BEFORE UPDATE ON "employee_profiles"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
