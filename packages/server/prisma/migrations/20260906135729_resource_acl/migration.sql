-- STORY-011-06 — resource-scoped ACL: one grant, on one object, to one subject (layer 4 of the
-- permission model), plus the three enums that close its vocabulary.
--
-- An EXPAND step (`rules/db-migrations.mdc`, 2): three new types, one new table. Nothing is
-- dropped, renamed or narrowed by this file.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Three enums, each mirroring a closed list in `packages/shared/src/permissions`.
--
-- Enums rather than text with a CHECK, unlike `team_role` and `project_role` next door, and the
-- difference is the rule (`rules/polymorphic-access.mdc`, 2): a discriminator of a polymorphic pair
-- has one job — refuse a value nobody reviewed — and the resource list is closed and complete by
-- design. Adding a label is DDL on the type; that is the price and the point.
CREATE TYPE "acl_resource_type" AS ENUM (
  'ORGANIZATION', 'PROJECT', 'BOARD', 'TASK', 'DOC_PAGE', 'KB_SPACE', 'KB_NOTE',
  'FILE', 'FILE_FOLDER', 'CHANNEL', 'VAULT', 'DASHBOARD'
);

CREATE TYPE "acl_subject_type" AS ENUM ('USER', 'ROLE', 'TEAM');

CREATE TYPE "access_level" AS ENUM ('NONE', 'VIEWER', 'COMMENTER', 'EDITOR', 'MANAGER');

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- resource_acl — «этот субъект имеет этот уровень на этом объекте»
--
-- Polymorphic on both ends, on purpose: no foreign key from `resource_id` and none from
-- `subject_id`, because the mechanism has to serve kinds of object that do not exist yet
-- (`data-model.md`, «Полиморфные связи», the `ResourceAcl` row). Hence `organization_id` is a column
-- of its own and not derived — without a key the database cannot know the object exists, let alone
-- whose it is — and the policy below compares it directly.
CREATE TABLE "resource_acl" (
    "id"              UUID                NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID                NOT NULL,
    "resource_type"   "acl_resource_type" NOT NULL,
    "resource_id"     UUID                NOT NULL,
    "subject_type"    "acl_subject_type"  NOT NULL,
    "subject_id"      UUID                NOT NULL,
    "access_level"    "access_level"      NOT NULL,
    -- The one real reference. SET NULL rather than CASCADE: the grant outlives the person who
    -- made it, and the audit trail — not this column — is where «who gave this» is kept. The
    -- column-list form below is what makes that true — see the constraint.
    "granted_by_id"   UUID,
    "granted_at"      TIMESTAMPTZ(6)      NOT NULL DEFAULT now(),
    "expires_at"      TIMESTAMPTZ(6),
    "created_at"      TIMESTAMPTZ(6)      NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6)      NOT NULL,

    CONSTRAINT "pk_resource_acl" PRIMARY KEY ("id"),
    CONSTRAINT "fk_resource_acl_organization_id" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    -- Composite, like every reference in this schema: foreign key checks bypass row-level
    -- security, so a grantor named by `users (id)` alone could be a person of another tenant.
    -- `SET NULL ("granted_by_id")`, the PostgreSQL 15 column-list form, and not a bare `SET NULL`:
    -- the bare form nulls **every** column of the key, `organization_id` included, and that column
    -- is NOT NULL — so deleting a grantor would fail with a not-null violation on this table and
    -- the grant would not outlive anybody (measured on 16.14 by the review of this migration;
    -- `sessions.rotated_from_id` took the same form for the same reason).
    CONSTRAINT "fk_resource_acl_granted_by_id" FOREIGN KEY ("organization_id", "granted_by_id")
        REFERENCES "users" ("organization_id", "id")
        ON DELETE SET NULL ("granted_by_id") ON UPDATE NO ACTION
);

-- One index for two jobs: one opinion per (object, subject), and the hot path of the whole model.
--
-- **Uniqueness.** Two levels for one subject on one object would be the conflict the resolution
-- rules were written to make impossible; with this index a re-grant is an upsert rather than a
-- read-then-decide. `organization_id` is part of the key on purpose: neither `resource_id` nor
-- `subject_id` is a foreign key, so without it a pair of uuids that happened to exist in another
-- tenant would make this tenant's insert fail on a row it cannot see — a 409 out of nowhere, and
-- a faint oracle for what exists elsewhere. Inside one tenant the quadruple is still the key.
--
-- **The lookup.** `PrismaAclReader.entriesAlong` (`acl-reader.adapter.ts`) joins the ancestor
-- chain against this index, one query per decision, and `find`/`remove` by the full key use it
-- too. The column order is measured, not
-- assumed: `enum_eq` is not marked LEAKPROOF (`SELECT proleakproof FROM pg_proc WHERE proname =
-- 'enum_eq'` → f), and under row-level security the planner refuses to evaluate a non-leakproof
-- operator before the policy — so for `app_user` an equality on an enum column can never be an
-- index condition, only a filter after the fetch. An index led by `(organization_id,
-- resource_type, resource_id)` gave the resolver a sequential scan of 347 buffers in 2.2 ms on
-- 20 000 rows as `app_user` (and an index scan as the owner, who bypasses the policy); with the
-- uuids leading, an index scan of 11 buffers in 0.17 ms (PostgreSQL 16.14;
-- `resource-acl-reader.test.ts` holds the plan). Hence uuid, enum, uuid, enum — each enum right
-- after the uuid it qualifies, where it costs nothing and is still part of the key.
CREATE UNIQUE INDEX "uq_resource_acl" ON "resource_acl" ("organization_id", "resource_id", "resource_type", "subject_id", "subject_type");

-- The reverse question — «what does this subject see» — for the list path that computes the set of
-- accessible parents once, and for taking every grant of a role or a team away in one statement.
-- The same order for the same reason: the uuid is the key, the enums qualify it.
CREATE INDEX "idx_resource_acl_subject" ON "resource_acl" ("organization_id", "subject_id", "subject_type", "resource_type");

-- The cleaner's index: partial, because most grants never expire and a full index would be mostly
-- a column of NULLs. Prisma cannot express a partial index, so it lives here only — the same
-- arrangement as `idx_upo_expires`.
CREATE INDEX "idx_resource_acl_expires" ON "resource_acl" ("expires_at") WHERE "expires_at" IS NOT NULL;

ALTER TABLE "resource_acl" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resource_acl" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "resource_acl"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "resource_acl"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

-- UPDATE because a re-grant replaces the level in place (`ON CONFLICT … DO UPDATE`); DELETE
-- because a revocation removes the row — a grant that ended is not a grant with a flag, and a
-- filter everybody has to remember is a filter somebody forgets.
GRANT SELECT, INSERT, UPDATE, DELETE ON "resource_acl" TO app_user;
GRANT SELECT ON "resource_acl" TO backup_role;

CREATE TRIGGER "trg_resource_acl_updated_at" BEFORE UPDATE ON "resource_acl"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
