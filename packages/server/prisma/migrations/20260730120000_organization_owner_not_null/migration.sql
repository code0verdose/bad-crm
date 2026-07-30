-- Contract step for `organizations.owner_id`: «an organization always has an owner» moves out of the
-- registration transaction and into the schema.
--
-- ## Why this ships in the same pre-release cycle as its expand step
--
-- `rules/db-migrations.mdc` rule 2 asks for a release of daylight between expand and contract,
-- because a self-hosted upgrade runs old and new code against the same schema. That risk is about
-- *deployed installations*, and there are none: no version tag, no application image, nothing that
-- could be mid-upgrade. Shipping now is what puts the constraint into every database that will ever
-- exist instead of leaving the invariant on application code for the whole pre-1.0 period. The
-- exception is written into `rules/db-migrations.mdc` and expires with the first release.
--
-- ## The order, and why each step is cheap
--
--   1. `CHECK … NOT VALID` — a catalog write under `ACCESS EXCLUSIVE`; no scan, no rewrite.
--   2. `VALIDATE CONSTRAINT` — scans under `SHARE UPDATE EXCLUSIVE`, so reads and writes continue.
--      This is also the step that *reports* a violation by table and column, which is what an
--      operator needs if an organization has no owner (`docs/runbooks/upgrade.md` §7).
--   3. `SET NOT NULL` — would rewrite the table, except that PostgreSQL 12+ proves it from the
--      validated `CHECK` already in the catalog and skips the scan.
--
-- The `CHECK` is kept rather than dropped as redundant: it costs one catalog row, its failure message
-- is the useful one on upgrade, and a later `ALTER COLUMN … DROP NOT NULL` cannot quietly reopen the
-- hole while it stands.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "organizations"
  ADD CONSTRAINT "ck_organizations_owner_not_null" CHECK ("owner_id" IS NOT NULL) NOT VALID;

ALTER TABLE "organizations" VALIDATE CONSTRAINT "ck_organizations_owner_not_null";

ALTER TABLE "organizations" ALTER COLUMN "owner_id" SET NOT NULL;

-- ─── the foreign key actions, both of which had become unstatable ──────────────────────────────
--
-- `ON DELETE SET NULL ("owner_id")` was right while the column was nullable. Against a NOT NULL
-- column it is an action whose only possible outcome is an error about a constraint the reader was
-- not looking at. `NO ACTION` says the same thing directly: a user who owns an organization cannot be
-- deleted — transfer ownership first, which is the point of the invariant.
--
-- `ON UPDATE CASCADE` goes for the reason recorded in `docs/architecture/data-model.md`: the
-- referencing side includes `organizations.id`, so a cascade writes **both** columns of the pair, and
-- any future move of a user between organizations would fail naming `organizations` instead of the
-- row being moved. The referenced key is an immutable uuid; `NO ACTION` is what that means.
--
-- Dropping and re-adding is the only way to change an action, and the replacement is added `NOT VALID`
-- then validated separately: a plain `ADD CONSTRAINT` on a foreign key scans the referencing table
-- while holding `SHARE ROW EXCLUSIVE` on both sides, and the two-step form keeps that scan out of the
-- exclusive window.
ALTER TABLE "organizations" DROP CONSTRAINT "fk_organizations_owner_id";

ALTER TABLE "organizations" ADD CONSTRAINT "fk_organizations_owner_id"
  FOREIGN KEY ("id", "owner_id") REFERENCES "users" ("organization_id", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "organizations" VALIDATE CONSTRAINT "fk_organizations_owner_id";
