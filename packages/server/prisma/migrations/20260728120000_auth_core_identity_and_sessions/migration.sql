-- EPIC-006 — the identity tables: users, their sessions and their password-reset tokens.
--
-- An EXPAND step in the sense of `rules/db-migrations.mdc` (2): it only adds. No existing column is
-- dropped, renamed or narrowed, so the previous release keeps running against this schema and a
-- rollback of the application does not need a rollback of the database.
--
-- Every table here is [T] (`docs/architecture/data-model.md` §1) and carries the complete block of
-- `docs/security/rls-design.md` in this same file: ENABLE, FORCE, a tenant policy with both
-- predicates, the maintenance switch, and explicit grants. There is deliberately no moment in which
-- the table exists and its isolation does not (rules/tenancy-rls.mdc, 3).
--
-- Applied by `app_migrator` through `prisma migrate deploy`. `prisma/sql/01-grants.sql` remains the
-- source of truth for privileges and re-applies the grants below after every migration and every
-- restore; it needs no edit for these tables — its classifier keys on `relrowsecurity`, so a table
-- that turns row-level security on is granted as an ordinary tenant table.

-- An ALTER waiting for a lock queues every query behind it, including the reads
-- (rules/db-migrations.mdc, 7). `SET LOCAL` and not `SET`: one `migrate deploy` applies every
-- pending migration over one connection, and a session-level setting outlives the COMMIT of its own
-- file — the `LOCAL` form keeps this preamble from becoming the preamble of the migrations after it.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

-- ─── enums ────────────────────────────────────────────────────────────────────────────────────
--
-- Closed sets defined by code and changed only by a release, which is the criterion of
-- `docs/architecture/data-model.md` («Enum в Prisma vs строка/справочник»). A value can be added
-- later with ADD VALUE; it can never be renamed or removed without recreating the type, so both
-- lists below are the ones EPIC-006 actually uses rather than a guess at the future.

CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'INVITED');

-- `OFFBOARDING` and not `USER_DELETED`: the same reason closes the sessions of an account that was
-- only suspended, where nothing was deleted, and STORY-012-05 asks for exactly this value for the
-- one deactivation operation that covers suspension and leaving alike
-- (docs/architecture/data-model.md, «Про каскады»). A label is a one-way door — renaming one means
-- recreating the type and rewriting every column that uses it — so it is chosen here, while the
-- table is empty.
CREATE TYPE "session_revoked_reason" AS ENUM (
  'ROTATED', 'REUSE_DETECTED', 'LOGOUT', 'REVOKED_BY_USER', 'PASSWORD_CHANGED', 'OFFBOARDING'
);

-- ─── updated_at ───────────────────────────────────────────────────────────────────────────────
--
-- Prisma's `@updatedAt` is a client-side attribute: it is a value Prisma puts into the statements
-- Prisma builds. This model prescribes writes that do not go through it — the family revocation of
-- «Про refresh-семейства» and the offboarding update of «Про каскады» are both written as raw
-- `UPDATE … WHERE …` — and those would leave `updated_at` holding a timestamp that is wrong rather
-- than one that is missing. A trigger is the only writer every statement passes through.
--
-- Applied to the two tables of the previous migration as well, so the invariant is "every table
-- with this column" rather than "the tables EPIC-006 happened to add"; the check in
-- `test/integration/db/migrations.test.ts` walks the whole tenant registry.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  -- No SECURITY DEFINER: the function needs no privileges of its own, and one that has them is one
  -- more thing a restore can hand to the wrong role (prisma/sql/01-grants.sql).
  AS $set_updated_at$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$set_updated_at$;

-- ─── users ────────────────────────────────────────────────────────────────────────────────────
--
-- Not one plaintext credential: `password_hash` is an argon2id digest, `totp_secret_enc` is
-- AES-256-GCM ciphertext, and the two `auth_verifier_*` columns hold the vault's proof of knowledge
-- (a salt and an argon2id digest over it), never the master password itself
-- (docs/security/e2ee-design.md).

CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,

    -- citext: address comparison is case-insensitive in the place that decides it. Folding done in
    -- the application is folding one caller forgets (STORY-006-01).
    "email" CITEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "password_hash" TEXT NOT NULL,

    "totp_secret_enc" TEXT,
    "totp_enabled_at" TIMESTAMPTZ(6),

    -- Carried in the access token as `pv`; a token behind the row is stale and the rights are
    -- re-read. Immediate revocation without keeping a list of issued tokens.
    "permissions_version" INTEGER NOT NULL DEFAULT 1,

    -- No default: a row is created either by registration (ACTIVE) or by an invitation (INVITED),
    -- and a default would make that decision for whichever path forgets to.
    "status" "user_status" NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6),
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',

    "auth_verifier_salt" BYTEA,
    "auth_verifier_hash" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_users" PRIMARY KEY ("id")
);

ALTER TABLE "users" ADD CONSTRAINT "fk_users_organization_id"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The target of every composite foreign key into this table. Foreign key checks run as the table
-- owner and bypass row-level security, so a child referencing `users (id)` alone would be allowed
-- to name a user of another organization — and the success of that insert would double as an oracle
-- for the existence of a foreign id (docs/security/rls-design.md, «Таблицы, у которых
-- organization_id есть только через родителя»).
ALTER TABLE "users" ADD CONSTRAINT "uq_users_org_id" UNIQUE ("organization_id", "id");

-- Partial, so a soft-deleted account frees its address: the pair, not the address alone. One person
-- may hold accounts in two self-hosted organizations and that is not a conflict
-- (docs/architecture/data-model.md §1).
CREATE UNIQUE INDEX "uq_users_org_email" ON "users" ("organization_id", "email")
  WHERE "deleted_at" IS NULL;

-- `organization_id` first, as on every composite index of a tenant table: the policy predicate is an
-- equality on that column and is present in every single query, so one index serves the filter and
-- the policy in the same pass. It also serves the foreign key above.
CREATE INDEX "idx_users_org_status" ON "users" ("organization_id", "status");

-- ─── sessions ─────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    "family_id" UUID NOT NULL,
    "rotated_from_id" UUID,

    -- The SHA-256 of the token, never the token. 32 bytes, so BYTEA and not TEXT: the value is a
    -- digest, and storing it as hex would invite comparing it as a string.
    "refresh_token_hash" BYTEA NOT NULL,
    "user_agent" TEXT NOT NULL,
    -- A hash of the address, not the address: it answers "same address as that session" and cannot
    -- be read back (docs/architecture/data-model.md, STORY-006-04).
    "ip_hash" TEXT NOT NULL,
    -- And the half that *can* be read back, because `/settings/security` has to show something a
    -- person recognises as not their own network: IPv4 truncated to /24, IPv6 to /48, computed
    -- before the insert by `src/domain/identity/mask-ip-address.util.ts`. The full address is
    -- stored nowhere, which is stricter than the model was — an address is personal data
    -- (CLAUDE.md, «Персональные данные»).
    --
    -- NOT NULL while the table is empty and the product unreleased. Afterwards the column would be
    -- nullable for good — `SET NOT NULL` on a populated table is the ACCESS EXCLUSIVE rewrite of
    -- rules/db-migrations.mdc (4) — and the API field it feeds optional with it. The function
    -- answers `unknown` for input it cannot read, so there is a value for every row.
    "ip_masked" TEXT NOT NULL,

    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" "session_revoked_reason",

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_sessions" PRIMARY KEY ("id")
);

ALTER TABLE "sessions" ADD CONSTRAINT "fk_sessions_organization_id"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite, and CASCADE: a session has no meaning without the account it belongs to, and a
-- single-column reference would let a session of this organization name a user of another one.
--
-- CASCADE covers the *physical* removal of a user, which is a maintenance operation. It says nothing
-- about the soft delete (`users.deleted_at`), which changes no row here at all — that invariant is
-- the use-case's: setting `deleted_at`, or `status = 'SUSPENDED'`, revokes the user's sessions and
-- bumps `permissions_version` in the same transaction, or a "deleted" account keeps working until
-- its refresh token expires (docs/architecture/data-model.md, «Про каскады»).
ALTER TABLE "sessions" ADD CONSTRAINT "fk_sessions_user_id"
  FOREIGN KEY ("organization_id", "user_id") REFERENCES "users" ("organization_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The rotation chain refers to this table, so this table needs the composite target too.
ALTER TABLE "sessions" ADD CONSTRAINT "uq_sessions_org_id" UNIQUE ("organization_id", "id");

-- The self-reference, composite for exactly the reason above: a rotation chain must not be able to
-- cross into another organization, and a plain `REFERENCES sessions (id)` would confirm that a
-- foreign session exists.
--
-- `SET NULL (rotated_from_id)` — the PostgreSQL 15 column list — and not a bare `SET NULL`: the
-- referencing pair includes `organization_id`, which is NOT NULL, so nulling the whole pair would
-- fail on the constraint instead of clearing the link. CASCADE would be worse than wrong: every
-- rotation extends `expires_at`, so the ancestor is always the first row the cleanup job deletes,
-- and cascading would take the live descendants of the family with it.
ALTER TABLE "sessions" ADD CONSTRAINT "fk_sessions_rotated_from_id"
  FOREIGN KEY ("organization_id", "rotated_from_id") REFERENCES "sessions" ("organization_id", "id")
  ON DELETE SET NULL ("rotated_from_id") ON UPDATE CASCADE;

-- Global on purpose, and the one unique key of the model that is. The refresh path resolves a
-- session by this value alone — the cookie arrives before any organization is known — so uniqueness
-- scoped per tenant would admit two rows with the same digest and make that lookup ambiguous. It is
-- safe as a global key because the value is server-generated and unguessable, which is the rule
-- residual risk 7 of docs/security/rls-design.md states; user input never gets a global unique key
-- (hence `uq_users_org_email` above).
ALTER TABLE "sessions" ADD CONSTRAINT "uq_sessions_refresh_hash" UNIQUE ("refresh_token_hash");

-- Serves three reads at once: the active sessions of a user, the revocation of a whole family on
-- reuse detection (`... WHERE organization_id = $1 AND user_id = $2 AND family_id = $3`), and the
-- foreign key to `users`.
CREATE INDEX "idx_sessions_org_user_family" ON "sessions"
  ("organization_id", "user_id", "family_id");

-- The cleanup job. Partial, because a revoked session is never a candidate: the index holds only
-- the rows the job is looking for. Tenant-first, because that job iterates organizations and opens
-- `withTenant` on each rather than sweeping the table (rules/tenancy-rls.mdc, 12).
CREATE INDEX "idx_sessions_org_expires" ON "sessions" ("organization_id", "expires_at")
  WHERE "revoked_at" IS NULL;

-- Every foreign key is indexed — PostgreSQL creates no index for one on its own, and the referencing
-- side is what `ON DELETE SET NULL` has to find. Partial: only rotated sessions carry the link.
CREATE INDEX "idx_sessions_org_rotated_from" ON "sessions"
  ("organization_id", "rotated_from_id")
  WHERE "rotated_from_id" IS NOT NULL;

-- ─── password_reset_tokens ────────────────────────────────────────────────────────────────────
--
-- Only the digest of the token is here; the token itself lives in the mail and in the URL. Spending
-- one is `UPDATE ... SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`, so the
-- second click on a link loses the race rather than resetting the password twice, and a spent token
-- is refused by the row itself rather than by a check the caller might skip (STORY-006-08).

CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "requested_ip_hash" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_password_reset_tokens" PRIMARY KEY ("id")
);

ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "fk_password_reset_tokens_organization_id"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "fk_password_reset_tokens_user_id"
  FOREIGN KEY ("organization_id", "user_id") REFERENCES "users" ("organization_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Global, for the same reason as the refresh digest: the link is opened by somebody who is not
-- signed in, so the lookup has nothing but this value to go on.
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "uq_password_reset_tokens_hash"
  UNIQUE ("token_hash");

-- Not partial, unlike the one below: this index is also what the composite foreign key above uses
-- when a user row is removed, and a partial index cannot serve a cascade.
CREATE INDEX "idx_password_reset_tokens_org_user" ON "password_reset_tokens"
  ("organization_id", "user_id");

-- The cleanup job and the "does this user already have a live request" read. A spent token is
-- neither, so it stays out of the index.
CREATE INDEX "idx_password_reset_tokens_org_expires" ON "password_reset_tokens"
  ("organization_id", "expires_at")
  WHERE "used_at" IS NULL;

-- ─── row level security ───────────────────────────────────────────────────────────────────────
--
-- The canonical five-block template of docs/security/rls-design.md, once per table. `WITH CHECK` is
-- written out even though PostgreSQL would substitute `USING` on a FOR ALL policy: the substitution
-- reads as NULL in `pg_policy`, so no automated check could tell "relied on the default" from
-- "forgot it", and the substitution disappears the moment a policy is split per command.

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
-- Without FORCE the owner ignores its own policies, silently: a connection made as the owner — a
-- wrong DATABASE_URL, a manual psql, a maintenance script — reads every organization and nothing
-- reports it (invariant 1 of CLAUDE.md).
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "users"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "users"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

-- TRUNCATE is granted to nobody, anywhere: it ignores row-level security, so one statement would
-- empty the table for every organization at once.
GRANT SELECT, INSERT, UPDATE, DELETE ON "users" TO app_user;
-- BYPASSRLS skips policies, not privilege checks. Without this line `pg_dump` fails on LOCK TABLE
-- and the table is missing from the backup.
GRANT SELECT ON "users" TO backup_role;

ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "sessions"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "sessions"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

-- DELETE, because expiry is enforced by removing the row: the cleanup job runs as the application,
-- per organization, inside `withTenant`.
GRANT SELECT, INSERT, UPDATE, DELETE ON "sessions" TO app_user;
GRANT SELECT ON "sessions" TO backup_role;

ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_tokens" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "password_reset_tokens"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "password_reset_tokens"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "password_reset_tokens" TO app_user;
GRANT SELECT ON "password_reset_tokens" TO backup_role;

-- ─── updated_at triggers ──────────────────────────────────────────────────────────────────────
--
-- One per table with the column, `organizations` and `teams` of the first migration included: the
-- rule is "the database maintains `updated_at`", and a rule that holds for three tables out of five
-- is a rule the next reader has to check before trusting the column.
--
-- BEFORE UPDATE and not BEFORE INSERT OR UPDATE: on insert the column has no previous value to go
-- stale, Prisma supplies one, and a row created by a migration or a restore keeps the timestamp it
-- was created with.

CREATE TRIGGER "trg_organizations_updated_at" BEFORE UPDATE ON "organizations"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER "trg_teams_updated_at" BEFORE UPDATE ON "teams"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER "trg_users_updated_at" BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER "trg_sessions_updated_at" BEFORE UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER "trg_password_reset_tokens_updated_at" BEFORE UPDATE ON "password_reset_tokens"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
