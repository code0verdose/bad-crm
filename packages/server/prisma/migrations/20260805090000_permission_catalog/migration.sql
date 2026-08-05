SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

-- The catalogue of permission keys: the one global reference table of this schema.
--
-- No `organization_id` and no row-level security, deliberately (docs/architecture/data-model.md,
-- group 2): the catalogue is defined by the **code** — `vault_item:decrypt` exists because a
-- use-case checks it — so a tenant cannot invent a permission and has nothing to hang one on. It is
-- read by every organization and written only by the seed, which runs as app_migrator; `app_user`
-- gets SELECT and nothing else through `prisma/sql/01-grants.sql`.
--
-- References point at `key`, not at a uuid: a human-readable identifier survives a rebuild of the
-- catalogue and keeps dumps readable (`RolePermission`, `UserPermissionOverride` — EPIC-011).
CREATE TABLE "permissions" (
    "key"           TEXT        NOT NULL,
    "resource"      TEXT        NOT NULL,
    "action"        TEXT        NOT NULL,
    "category"      TEXT        NOT NULL,
    "is_dangerous"  BOOLEAN     NOT NULL DEFAULT false,
    -- A key removed from the code is marked, never deleted: rows elsewhere point here, and dropping
    -- the row would break every installation where an administrator had already granted it.
    "deprecated_at" TIMESTAMPTZ(6),
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"    TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_permissions" PRIMARY KEY ("key")
);

-- Index names come from `docs/architecture/data-model.md`, group 2 — it is the source of truth for
-- names, and `test/infra/data-model-indexes.test.ts` compares the two in both directions.
--
-- The key is `<resource>:<action>` and both halves are stored, so a screen can group by resource
-- without parsing strings.
CREATE INDEX "idx_permissions_resource" ON "permissions" ("resource", "action");

-- The role-matrix screen lists the live catalogue by category; partial, because a deprecated key is
-- never offered there.
CREATE INDEX "idx_permissions_active" ON "permissions" ("category") WHERE "deprecated_at" IS NULL;
