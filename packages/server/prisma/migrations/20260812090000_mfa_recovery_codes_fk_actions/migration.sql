-- EPIC-013, STORY-013-02 — the two foreign keys of `mfa_recovery_codes` take the action this project
-- chose, and the table keeps one index instead of two.
--
-- Both defects came from the previous migration accepting a default. `ON UPDATE CASCADE` is what
-- Prisma writes for a relation that declares nothing; `docs/architecture/data-model.md` («Про
-- `Organization.ownerId`») closed that question on 2026-07-30 and every key added since declares
-- `ON UPDATE NO ACTION` explicitly. A file is history and is not edited (`rules/db-migrations.mdc`,
-- 12), so the repair is this migration.
--
-- **What the cascade would do, and why nothing observes it.** The user reference targets the pair
-- `(organization_id, id)`. Under CASCADE an `UPDATE users SET organization_id = …` — a support fix,
-- a backfill, a transfer of an account we do not have yet — rewrites `organization_id` on this
-- table's rows as well, moving the material of somebody's second factor into another tenant.
-- Foreign key checks are executed as the owner of the table and bypass row-level security
-- (`rules/tenancy-rls.mdc`, 7), so neither `USING` nor `WITH CHECK` is consulted and no policy test
-- can see it happen. With NO ACTION PostgreSQL refuses the `UPDATE` and names this table.
--
-- **Why a plain `ADD CONSTRAINT` and not `NOT VALID` + `VALIDATE`.** Re-adding a foreign key
-- validates the table under SHARE ROW EXCLUSIVE. This table was created empty by the migration two
-- files back and no release has shipped it, so the scan reads nothing and blocks nobody
-- (`rules/db-migrations.mdc`, 2 — the pre-release proviso, which expires with the first version tag).
-- After that tag the same edit has to arrive as `ADD CONSTRAINT … NOT VALID` followed by
-- `VALIDATE CONSTRAINT` in a separate statement.
--
-- Nothing is dropped that the previous release reads: the constraint names, the columns and the
-- delete actions are unchanged, so the code running against this schema cannot tell the difference —
-- which is exactly why the defect needed reading the catalog to find.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "mfa_recovery_codes" DROP CONSTRAINT IF EXISTS "fk_mfa_recovery_codes_organization_id";
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "fk_mfa_recovery_codes_organization_id"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- `ON DELETE CASCADE` is kept, and only the update action changes: a code without the account it
-- recovers is not a row anybody reads, and offboarding should not have to remember this table.
ALTER TABLE "mfa_recovery_codes" DROP CONSTRAINT IF EXISTS "fk_mfa_recovery_codes_user_id";
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "fk_mfa_recovery_codes_user_id"
  FOREIGN KEY ("organization_id", "user_id") REFERENCES "users" ("organization_id", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- The partial index, removed as a duplicate of the full one.
--
-- Its stated reason was that it "stays small as codes are spent" — which has nothing to work on: a
-- batch is ten codes, and a regeneration deletes the whole set rather than letting spent rows
-- accumulate (STORY-013-02, acceptance 7), so both indexes pointed at the same ≤10 rows of an
-- account. The cost was real: `used_at` sits in the predicate, so spending a code could never be a
-- HOT update and had to touch both indexes, and issuing a batch wrote twenty index tuples instead of
-- ten. It also did not serve the reads it was justified by — `{ total, remaining }` counts `total`
-- *without* `used_at`, and the bulk delete removes spent rows too.
--
-- `idx_mfa_recovery_codes_org_user` stays: it is the index `ON DELETE CASCADE` from `users` uses, and
-- a partial index cannot serve a cascade (the same reason `idx_password_reset_tokens_org_user` is
-- not partial). Dropping an index takes ACCESS EXCLUSIVE on the table for the duration; on this
-- empty, unreleased table that is the time it takes to delete a catalog entry.
DROP INDEX IF EXISTS "idx_mfa_recovery_codes_org_user_unused";
