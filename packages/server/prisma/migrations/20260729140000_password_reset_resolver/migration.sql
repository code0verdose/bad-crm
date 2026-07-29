-- EPIC-006 — the fourth resolver of the org-less authentication path: the password-reset link.
--
-- An EXPAND step (`rules/db-migrations.mdc`, 2): one new function and one new GRANT. Nothing is
-- dropped, renamed or narrowed, so the previous release keeps running against this schema.
--
-- WHY IT IS NEEDED AT ALL
--
-- `/reset-password/<token>` is opened by somebody who by definition cannot sign in, so the request
-- carries nothing but the token — no organization, no session, no address. Reading
-- `password_reset_tokens` needs `app.organization_id`, and learning `app.organization_id` needs to
-- read `password_reset_tokens`: the same chicken-and-egg problem as sign-in and refresh, and
-- `docs/security/rls-design.md` («Особые пути») answers it the same way, with a narrow
-- `SECURITY DEFINER` function rather than a general escape hatch. `docs/architecture/data-model.md`
-- §1 («Резолв до организации») records this function as owed by STORY-006-08; this is it.
--
-- WHAT IT RETURNS, AND WHAT IT DELIBERATELY DOES NOT
--
-- Three columns: the row's id, its organization and its user. **Not `expires_at` and not `used_at`.**
-- Returning them would invite the caller to decide usability from a *read*, and two clicks on one
-- link would then both pass that decision under READ COMMITTED and reset the password twice — the
-- second time to whatever the slower request carried. Usability is decided by the conditional
-- `UPDATE … WHERE used_at IS NULL AND expires_at > $now RETURNING user_id` that spends the row,
-- issued under `app_user` inside `withTenant`
-- (`src/infrastructure/persistence/prisma/password-reset-token.repository.ts`).
--
-- Leaving them out has a second effect that matters as much: this privileged surface cannot answer
-- "has this token been used" or "when does it expire". Unknown, spent and expired are one answer to
-- the caller (`400 password_reset_token_invalid`), and there is now no read that could tell them
-- apart for anybody who reached the `app_auth` connection.
--
-- The function does **not** filter soft-deleted accounts, and the omission is deliberate: a row here
-- is short-lived and single-use, and the composite foreign key `(organization_id, user_id)` is
-- `ON DELETE CASCADE`, so a removed account has no tokens left to resolve. A `deleted_at IS NULL`
-- join against `users` would add a table to this function's reach for a case that cannot arise; the
-- password write that follows already runs under the policy and under `deleted_at IS NULL`.
--
-- EVERY OTHER LINE IS THE SAME REQUIREMENT AS THE FIRST THREE RESOLVERS
--
--   * `SECURITY DEFINER` + `OWNER TO app_auth_definer` — the body runs as a NOLOGIN role that has
--     BYPASSRLS and `SELECT` on the tables the resolvers read. Not `app_auth`: a function executes
--     with its *owner's* privileges, and `app_auth` holds no table privilege at all, so a function
--     it owned would answer `permission denied for table password_reset_tokens` from inside itself
--     (the correction recorded in `docs/architecture/data-model.md` on 2026-07-29).
--   * `SET search_path = pg_catalog, public` — without it a caller can put their own
--     `password_reset_tokens` earlier on their `search_path` and have it read with the owner's
--     rights. `prisma/sql/01-grants.sql` refuses to finish if any non-extension SECURITY DEFINER
--     function lacks it.
--   * `COMMENT ON FUNCTION … IS 'bad-crm:auth-resolver …'` — the marker `01-grants.sql` classifies
--     by. It is the only one of owner, ACL and comment that survives `pg_restore --no-privileges`,
--     which is precisely the state that file exists to repair; without it the repair loop matches
--     nothing and step 7a stops the deployment.
--   * `REVOKE ALL … FROM PUBLIC` **before** the `GRANT` — PostgreSQL grants `EXECUTE` on a new
--     function to `PUBLIC` by default, and a forgotten REVOKE hands it to `app_user`, which is the
--     role an SQL injection runs as.
--   * `STABLE` — it writes nothing. Spending the token happens under `app_user`.

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION auth_lookup_password_reset(p_token_hash bytea)
RETURNS TABLE (
  token_id        uuid,
  organization_id uuid,
  user_id         uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.organization_id, t.user_id
  FROM   password_reset_tokens t
  WHERE  t.token_hash = p_token_hash
$$;

COMMENT ON FUNCTION auth_lookup_password_reset(bytea) IS
  'bad-crm:auth-resolver — password reset: resolves a link to its organization by the digest of its token. Owned by app_auth_definer, EXECUTE granted to app_auth only.';

REVOKE ALL   ON FUNCTION auth_lookup_password_reset(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_password_reset(bytea) TO app_auth;

-- The owner needs `SELECT` on the table this function reads — BYPASSRLS skips policies, not
-- privilege checks — and `01-grants.sql` re-applies the same grant after a restore through its
-- `definer_reads` list, which gains `password_reset_tokens` in this change. The two are one rule in
-- two places, and both are needed: this file is what a fresh install runs, that one is what a
-- restored install runs.
GRANT SELECT ON TABLE password_reset_tokens TO app_auth_definer;

-- CREATE on the schema is required of the *new* owner and is taken and given back inside this
-- migration's single transaction, exactly as `20260729120000_auth_owner_and_lookup_functions` does:
-- a BYPASSRLS role that can create objects is a wider credential than app_auth_definer is meant to
-- be, so no standing privilege exists outside these statements.
GRANT CREATE ON SCHEMA public TO app_auth_definer;

ALTER FUNCTION auth_lookup_password_reset(bytea) OWNER TO app_auth_definer;

REVOKE CREATE ON SCHEMA public FROM app_auth_definer;
