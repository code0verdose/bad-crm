-- EPIC-006 — the organization's owner, and the three resolvers of the org-less authentication path.
--
-- An EXPAND step (`rules/db-migrations.mdc`, 2): one nullable column and three new functions. Nothing
-- is dropped, renamed or narrowed, so the previous release keeps running against this schema.
--
-- TWO THINGS LIVE HERE AND THEY ARE RELATED
--
--   1. `organizations.owner_id` — the account that administers the organization, written by the
--      registration use-case one statement after it creates the owner (STORY-006-01). Nullable
--      because the row it points at does not exist at the moment the organization is inserted.
--
--   2. `auth_lookup_users_by_email`, `auth_lookup_user`, `auth_lookup_session` — the whole surface
--      of the `app_auth` role. They are what makes sign-in and refresh possible at all: reading
--      `users` needs `app.organization_id`, and learning `app.organization_id` needs to read
--      `users` (`docs/security/rls-design.md`, «Особые пути», path 1).
--
-- WHY THE FUNCTIONS ARE WRITTEN THE WAY THEY ARE — every line below is a documented requirement of
-- `docs/security/rls-design.md`, and each one closes a real hole:
--
--   * `SECURITY DEFINER` + `OWNER TO app_auth_definer` — the body runs as a NOLOGIN role that has
--     BYPASSRLS and `SELECT` on exactly the three tables these functions read. It is **not**
--     `app_auth`, the role the application connects as: a function runs with its owner's
--     privileges, and BYPASSRLS skips policies rather than privilege checks, so an owner without
--     `SELECT` answers `permission denied for table users` from inside the function — while giving
--     that `SELECT` to the connecting role would make `DATABASE_AUTH_URL` a credential that dumps
--     every account of every organization. Owner and caller are therefore two roles
--     (`prisma/sql/00-bootstrap-roles.sql`, «app_auth_definer»). The owner is set explicitly at all
--     because `CREATE FUNCTION` makes the *migrator* the owner, and the migrator owns every table.
--     `app_auth` holds no BYPASSRLS of its own: the attribute belongs to the role the bodies run
--     as, and giving it to the connecting role as well would buy nothing and cost the second line
--     of defence the day any `GRANT … TO app_auth` is written.
--   * `COMMENT ON FUNCTION … IS 'bad-crm:auth-resolver …'` — the marker `prisma/sql/01-grants.sql`
--     classifies by. It repairs ownership and privileges after a restore, and it must be able to
--     tell this project's resolvers from a `SECURITY DEFINER` function an extension installed into
--     `public`: acting on one of those either aborts the whole grant run (`permission denied to set
--     role`, when the owner is the cluster superuser) or silently hands `app_auth` `EXECUTE` on a
--     function that was never part of its surface. A comment is the only one of the three
--     properties — owner, ACL, comment — that survives `pg_restore --no-privileges`, which is
--     precisely the state that file exists to repair.
--   * `SET search_path = pg_catalog, public` — without it a caller can put a table named `users` on
--     an earlier schema of their own `search_path` and have this function read it with the owner's
--     rights. That is the classic `SECURITY DEFINER` vulnerability, not a theoretical one.
--   * `STABLE`, not `VOLATILE` — none of the three writes anything. Rotation and revocation happen
--     under `app_user`, inside `withTenant`, once the organization is known.
--   * `REVOKE ALL … FROM PUBLIC` **before** the `GRANT` — PostgreSQL grants `EXECUTE` on a new
--     function to `PUBLIC` by default. A forgotten REVOKE means `app_user` can call it, and so can
--     an SQL injection under `app_user` — which would hand it a cross-tenant read of every account.
--   * Only the columns a decision needs. A privileged surface that returns `*` puts everything it
--     selected one careless log line away from disclosure.
--
-- `prisma/sql/01-grants.sql` re-applies the owner, the REVOKE and the GRANT after every restore.
-- That step is not decoration: `pg_restore --no-privileges` drops privileges, and for a table that
-- is fail-closed (the application dies on `permission denied`) while for a function it is
-- **fail-open** — the restored function is `EXECUTE`-able by PUBLIC and owned by whoever ran the
-- restore. The gap is named in the header of that file and closed by it as of this migration.

-- `SET LOCAL`, not `SET` — and this file is the one where it matters most, because the migration
-- applied straight after it builds an index `CONCURRENTLY`. Prisma applies every pending migration
-- of one `migrate deploy` over a single connection, and a session-level `SET` outlives the COMMIT
-- of its own file: a plain `SET statement_timeout = '5min'` here would cap the concurrent build in
-- `20260729130000_index_sessions_org_family`, which by rule 6 may carry nothing but the index
-- statement and so has no way to raise it. Measured with a probe migration on PostgreSQL 16
-- (pgvector/pgvector:0.8.5-pg16) and Prisma 6.19.3: `PROBE statement_timeout=5min lock_timeout=3s`
-- with the session form, `PROBE statement_timeout=0 lock_timeout=5s` with this one. The `LOCAL`
-- form still applies inside this file — Prisma runs it in a transaction, which is what makes the
-- setting take and what makes it end at the semicolon after the last statement.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

-- ─── organizations.owner_id ───────────────────────────────────────────────────────────────────

ALTER TABLE "organizations" ADD COLUMN "owner_id" UUID;

-- Composite, like every reference between tenant tables — with the twist that `organizations` is the
-- tenant root, so its *own primary key* is the tenant column. `(id, owner_id)` against
-- `users (organization_id, id)` is therefore the same guarantee an ordinary child gets from
-- `(organization_id, parent_id)`: an owner from another organization cannot be named. Foreign key
-- checks run as the table owner and bypass row-level security, so without the pair the constraint
-- would happily confirm a user of a tenant this one cannot see (rules/tenancy-rls.mdc, 7).
--
-- `ON DELETE SET NULL (owner_id)` — the PostgreSQL 15 column list. A bare `SET NULL` would null both
-- columns, including the primary key, and die on its NOT NULL; the list nulls only the nullable half.
-- The same construction and the same reason as `fk_sessions_rotated_from_id`.
--
-- No index is added: the referencing side is searched by `(id, owner_id)`, whose leading column is
-- the primary key, and `pk_organizations` already serves it.
ALTER TABLE "organizations" ADD CONSTRAINT "fk_organizations_owner_id"
  FOREIGN KEY ("id", "owner_id") REFERENCES "users" ("organization_id", "id")
  ON DELETE SET NULL ("owner_id") ON UPDATE CASCADE;

-- ─── the app_auth resolvers ───────────────────────────────────────────────────────────────────
--
-- Sign-in, when the caller named the organization. The pair `(organization_id, email)` is what
-- `uq_users_org_email` is unique on, so this returns at most one row — and a slug nobody has is an
-- empty result, which the use-case answers exactly like a wrong password.

CREATE OR REPLACE FUNCTION auth_lookup_user(p_email citext, p_org_slug text)
RETURNS TABLE (
  user_id             uuid,
  email               text,
  locale              text,
  timezone            text,
  organization_id     uuid,
  organization_name   text,
  organization_slug   text,
  password_hash       text,
  status              text,
  permissions_version int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.email::text, u.locale, u.timezone,
         o.id, o.name, o.slug,
         u.password_hash, u.status::text, u.permissions_version
  FROM   users u
  JOIN   organizations o ON o.id = u.organization_id
  WHERE  u.email      = p_email
    AND  o.slug       = p_org_slug
    AND  u.deleted_at IS NULL
    AND  o.deleted_at IS NULL
$$;

-- Sign-in without a named organization — the fallback for an installation with one organization and
-- for a login form without a subdomain.
--
-- It returns **every** matching account rather than refusing when there is more than one, and the
-- difference from the sketch in `docs/security/rls-design.md` is deliberate and narrow: the contract
-- (`docs/api/openapi.yaml`, `OrganizationSelectionRequired`) requires the choice of organization to
-- be offered *only after the password verified*, which cannot be done without the digests. Nothing
-- about the multiplicity leaves the server: `LoginUseCase` verifies each candidate and describes only
-- the ones that matched, so a guesser learns nothing the single-row version would have hidden. The
-- residual difference is elapsed time, which grows with the number of organizations one address has
-- an account in — bounded below, and only observable to somebody who already holds a password.
--
-- LIMIT 8, so the cost of this call cannot be driven by how many accounts share an address.
CREATE OR REPLACE FUNCTION auth_lookup_users_by_email(p_email citext)
RETURNS TABLE (
  user_id             uuid,
  email               text,
  locale              text,
  timezone            text,
  organization_id     uuid,
  organization_name   text,
  organization_slug   text,
  password_hash       text,
  status              text,
  permissions_version int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.id, u.email::text, u.locale, u.timezone,
         o.id, o.name, o.slug,
         u.password_hash, u.status::text, u.permissions_version
  FROM   users u
  JOIN   organizations o ON o.id = u.organization_id
  WHERE  u.email      = p_email
    AND  u.deleted_at IS NULL
    AND  o.deleted_at IS NULL
  ORDER  BY o.slug
  LIMIT  8
$$;

-- Refresh: the third org-less path, and the one that is easy to forget. The cookie arrives without
-- an organization, so the session has to be resolved by the digest of the token alone — which is why
-- `uq_sessions_refresh_hash` is global (`docs/architecture/data-model.md`).
--
-- Read-only. Rotation and the revocation of a family both happen under `app_user` inside
-- `withTenant`, because by then the organization is known — and a privileged function that could
-- write would be a privileged function somebody eventually writes through.
CREATE OR REPLACE FUNCTION auth_lookup_session(p_refresh_hash bytea)
RETURNS TABLE (
  session_id      uuid,
  user_id         uuid,
  organization_id uuid,
  family_id       uuid,
  revoked_at      timestamptz,
  revoked_reason  text,
  expires_at      timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.user_id, s.organization_id, s.family_id,
         s.revoked_at, s.revoked_reason::text, s.expires_at
  FROM   sessions s
  WHERE  s.refresh_token_hash = p_refresh_hash
$$;

-- ─── ownership and privileges of the three ────────────────────────────────────────────────────
--
-- Applied here *and* re-applied by `prisma/sql/01-grants.sql`, which walks `pg_proc` for exactly
-- this shape. Two places for one rule, and both are necessary: this file is what a fresh install
-- runs, and that file is what a restored install runs — `migrate deploy` re-applies nothing after a
-- restore, because the dump brings `_prisma_migrations` back with every migration marked applied.
--
-- THE ORDER OF THE NEXT THREE BLOCKS IS LOAD-BEARING.
--
-- Privileges first, ownership last. `REVOKE`/`GRANT` on a function may only be issued by its owner,
-- and after `OWNER TO app_auth_definer` that is no longer app_migrator — the statements would fail,
-- or, if the ACL is still the implicit default, silently leave `PUBLIC` with `EXECUTE`. Doing it in
-- this order also survives the transfer: PostgreSQL rewrites an explicit ACL when the owner changes,
-- substituting the new owner for the old one, so `app_migrator=X/app_migrator` becomes
-- `app_auth_definer=X/app_auth_definer` and no `=X/` entry (the shape of a grant to PUBLIC) remains.
--
-- The owner is `app_auth_definer` and **not** `app_auth`, and the difference is the whole point of
-- the pair. A `SECURITY DEFINER` function runs with the privileges of its owner, so the owner is the
-- authority these three functions lend out — while `app_auth` is the role the application *connects*
-- as. Making the connecting role the owner would give a live connection every privilege the
-- functions were meant to hand out only through them; `app_auth` therefore holds `EXECUTE` and
-- nothing else, and the table `SELECT`s below belong to a role nobody can log in as.

-- The marker `01-grants.sql` classifies by; see the header. It is a documented contract between the
-- two files, so the text is fixed: the repair loop matches on `bad-crm:auth-resolver`.
COMMENT ON FUNCTION auth_lookup_user(citext, text) IS
  'bad-crm:auth-resolver — org-less sign-in when the organization was named. Owned by app_auth_definer, EXECUTE granted to app_auth only.';
COMMENT ON FUNCTION auth_lookup_users_by_email(citext) IS
  'bad-crm:auth-resolver — org-less sign-in without a named organization. Owned by app_auth_definer, EXECUTE granted to app_auth only.';
COMMENT ON FUNCTION auth_lookup_session(bytea) IS
  'bad-crm:auth-resolver — refresh: resolves a session by the digest of its token. Owned by app_auth_definer, EXECUTE granted to app_auth only.';

REVOKE ALL ON FUNCTION auth_lookup_user(citext, text)     FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_users_by_email(citext) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_lookup_session(bytea)         FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_lookup_user(citext, text)     TO app_auth;
GRANT EXECUTE ON FUNCTION auth_lookup_users_by_email(citext) TO app_auth;
GRANT EXECUTE ON FUNCTION auth_lookup_session(bytea)         TO app_auth;

-- PostgreSQL requires the *new* owner to hold CREATE on the function's schema, so the transfer needs
-- a privilege app_auth deliberately does not have: `00-bootstrap-roles.sql` gives it USAGE on
-- `public` and nothing else, because a BYPASSRLS role that can create objects is a wider credential
-- than this one is meant to be. The grant is therefore taken and given back within this migration —
-- which runs as one transaction — so no standing privilege exists outside these few statements.
-- `01-grants.sql` does the same around its own loop, for the restore path.
GRANT CREATE ON SCHEMA public TO app_auth_definer;

GRANT SELECT ON TABLE users         TO app_auth_definer;
GRANT SELECT ON TABLE organizations TO app_auth_definer;
GRANT SELECT ON TABLE sessions      TO app_auth_definer;

ALTER FUNCTION auth_lookup_user(citext, text)      OWNER TO app_auth_definer;
ALTER FUNCTION auth_lookup_users_by_email(citext)  OWNER TO app_auth_definer;
ALTER FUNCTION auth_lookup_session(bytea)          OWNER TO app_auth_definer;

REVOKE CREATE ON SCHEMA public FROM app_auth_definer;
