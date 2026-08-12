-- EPIC-013, STORY-013-02 — the ten argon2id-hashed recovery codes issued alongside TOTP enrolment.
--
-- An EXPAND step (`rules/db-migrations.mdc`, rule 2): one new table, created empty, so every block
-- below — including the two indexes — runs without CONCURRENTLY (rule 6's exception: a table this
-- migration itself creates has no rows to block a scan against). Nothing is dropped, renamed or
-- narrowed, so the previous release keeps running against this schema.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE "mfa_recovery_codes" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID           NOT NULL,
    "user_id"         UUID           NOT NULL,

    -- argon2id, never the plaintext. `docs/security/e2ee-design.md` does not apply here — these are
    -- not vault secrets — but the same rule `CLAUDE.md` states for TOTP secrets and API keys does:
    -- decrypted (or, here, un-hashed) material never lands in a column.
    "code_hash"       TEXT           NOT NULL,
    "used_at"         TIMESTAMPTZ(6),

    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_mfa_recovery_codes" PRIMARY KEY ("id"),
    CONSTRAINT "fk_mfa_recovery_codes_organization_id" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Composite, like every reference in this schema: foreign key checks run as the table owner and
    -- bypass row-level security, so a single-column reference could name an account of another
    -- organization (rules/tenancy-rls.mdc, rule 7). CASCADE: a code without the account it recovers
    -- is not a row anybody reads, and offboarding an account should not have to remember this table.
    CONSTRAINT "fk_mfa_recovery_codes_user_id" FOREIGN KEY ("organization_id", "user_id")
        REFERENCES "users" ("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The predicate every read of this table filters by: "this account's still-usable codes" — the
-- consume loop, the {total, remaining} counter and the bulk delete on regeneration all start here.
CREATE INDEX "idx_mfa_recovery_codes_org_user" ON "mfa_recovery_codes" ("organization_id", "user_id");
-- Partial, so it stays small as codes are spent and never grows for accounts that keep regenerating —
-- Prisma cannot express a partial index, which is why this one is not declared in schema.prisma.
CREATE INDEX "idx_mfa_recovery_codes_org_user_unused" ON "mfa_recovery_codes" ("organization_id", "user_id") WHERE "used_at" IS NULL;

ALTER TABLE "mfa_recovery_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_recovery_codes" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "mfa_recovery_codes"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "mfa_recovery_codes"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

-- UPDATE is granted, deliberately, unlike the append-only journals: `used_at` has to be settable by
-- the application — that write *is* the atomic consume this table exists for
-- (`RecoveryCodeRepositoryPort.markUsed`, `UPDATE ... WHERE id = $1 AND used_at IS NULL RETURNING
-- id`) — and DELETE is granted for the bulk invalidation a regeneration performs in the same
-- transaction as issuing the new batch (STORY-013-02, acceptance 7).
GRANT SELECT, INSERT, UPDATE, DELETE ON "mfa_recovery_codes" TO app_user;
GRANT SELECT ON "mfa_recovery_codes" TO backup_role;

CREATE TRIGGER "trg_mfa_recovery_codes_updated_at"
  BEFORE UPDATE ON "mfa_recovery_codes"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
