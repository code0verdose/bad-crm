-- EPIC-013, STORY-013-01 — the two TOTP columns `data-model.md` group 1 was still missing.
--
-- An EXPAND step (`rules/db-migrations.mdc`, rule 2): two new nullable columns on an existing table,
-- neither read nor written by any code that ships before this migration. Old and new versions of the
-- process can run against this schema at once.
--
-- `totp_secret_enc` and `totp_enabled_at` already exist — they shipped with the very first identity
-- migration, ahead of this epic. Only the anti-replay counter and the draft expiry are new.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "users" ADD COLUMN "totp_last_counter" INTEGER;
ALTER TABLE "users" ADD COLUMN "totp_draft_expires_at" TIMESTAMPTZ(6);
