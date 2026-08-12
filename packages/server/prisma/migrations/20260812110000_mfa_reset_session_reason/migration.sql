-- EPIC-013, STORY-013-04 — a distinct session_revoked_reason for an administrator's MFA reset.
--
-- EXPAND (`rules/db-migrations.mdc`, rule 2): adding an enum value is purely additive. Every value
-- this column already holds keeps meaning exactly what it did, every caller that writes one of the
-- six existing members keeps working unmodified, and the column is read as an opaque label
-- everywhere in this codebase today (`session.repository.ts`, `end-session.use-case.ts`) — nothing
-- exhaustively switches over `SessionRevokedReason` in a way a seventh member could break.
--
-- `OFFBOARDING` is not reused for this: its own docstring in `schema.prisma` ties it to an account
-- that "stopped being able to hold sessions" — suspended, deactivated or soft-deleted. An
-- administrator's MFA reset does none of that; the account stays ACTIVE and can open a new session
-- immediately. Reusing `OFFBOARDING` here would make that comment false for a class of rows it does
-- not describe.
--
-- Postgres 12+ allows `ALTER TYPE ... ADD VALUE` inside a transaction as long as the new value is
-- not referenced by the same transaction, which this migration does not do — it only adds the label.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

ALTER TYPE "session_revoked_reason" ADD VALUE 'MFA_RESET_BY_ADMIN';
