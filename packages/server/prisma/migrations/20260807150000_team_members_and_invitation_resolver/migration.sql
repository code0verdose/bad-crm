-- EPIC-012 — accepting an invitation: the membership rows it produces, and the resolver that finds
-- it before the organization is known.
--
-- An EXPAND step (`rules/db-migrations.mdc`, 2): one new table, one new function, one new grant.
-- Nothing is dropped, renamed or narrowed by this file.
-- (Note for the reader of the history: the delta that introduced it also edited the *applied*
--  migration `20260807100000_invitations` in place, changing `token_hash` from TEXT to BYTEA. That
--  is allowed only because no release exists yet — see `docs/runbooks/upgrade.md`, «Контрольные
--  суммы миграций». A database that already applied the earlier version answers `P3019` and is
--  reset, not upgraded.)

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- team_members — «этот человек в этой команде»
--
-- The invitation carries `team_ids` as a **draft**: a `uuid[]` nothing references, checked by
-- nothing, read once. Accepting it is where that draft becomes membership, and membership is a
-- table because everything else in the product asks questions of it — who is on this team, whose
-- board is this, who gets this notification — and an array answers none of them with an index.
CREATE TABLE "team_members" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID           NOT NULL,
    "team_id"         UUID           NOT NULL,
    "user_id"         UUID           NOT NULL,
    -- `MEMBER` | `LEAD`. Text with a CHECK rather than a PostgreSQL enum: adding a value to an enum
    -- is DDL on a type every table using it depends on, and `data-model.md` §1 names exactly two.
    "team_role"       TEXT           NOT NULL DEFAULT 'MEMBER',
    "joined_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"      TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_team_members" PRIMARY KEY ("id"),
    CONSTRAINT "ck_team_members_role" CHECK ("team_role" IN ('MEMBER', 'LEAD')),
    -- Composite, like every reference in this schema: foreign key checks bypass row-level security,
    -- so a child pointing at `teams (id)` alone could name a team of another organization.
    CONSTRAINT "fk_team_members_team_id" FOREIGN KEY ("organization_id", "team_id")
        REFERENCES "teams" ("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    -- CASCADE from the person as well: a deleted account leaves no membership behind, and there is
    -- nothing here worth keeping about somebody who no longer exists — unlike a role assignment,
    -- which records who granted what.
    CONSTRAINT "fk_team_members_user_id" FOREIGN KEY ("organization_id", "user_id")
        REFERENCES "users" ("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "fk_team_members_organization_id" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- One row per pair: joining a team twice is the same membership, not a second one. The uniqueness
-- is what makes acceptance idempotent without the use-case reading first — the same reason
-- `uq_user_roles` exists next door.
CREATE UNIQUE INDEX "uq_team_members" ON "team_members" ("team_id", "user_id");
-- The two questions actually asked: «кто в этой команде» and «в каких командах этот человек».
CREATE INDEX "idx_team_members_org_user" ON "team_members" ("organization_id", "user_id");

ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "team_members" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "team_members"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "team_members"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "team_members" TO app_user;
GRANT SELECT ON "team_members" TO backup_role;

CREATE TRIGGER "trg_team_members_updated_at" BEFORE UPDATE ON "team_members"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- auth_lookup_invitation — the fifth resolver of the org-less path
--
-- `/invite/<token>` is opened by somebody who has no account at all, so the request carries nothing
-- but the token. Reading `invitations` needs `app.organization_id`, and learning
-- `app.organization_id` needs to read `invitations`: the same chicken-and-egg as sign-in, refresh
-- and password reset, answered the same way — one narrow `SECURITY DEFINER` function rather than a
-- general escape hatch (`docs/security/rls-design.md`, «Особые пути»).
--
-- **Two columns, and neither of them is `accepted_at` or `expires_at`.** Returning them would invite
-- the caller to decide usability from a *read*, and two clicks on one link would then both pass that
-- decision under READ COMMITTED and create two accounts. Usability is decided by the conditional
-- `UPDATE … WHERE accepted_at IS NULL AND expires_at > $now RETURNING …` that spends the row, issued
-- under `app_user` inside `withTenant`.
--
-- Leaving them out has the second effect that matters as much: this privileged surface cannot answer
-- «has this invitation been accepted» or «when does it expire». Unknown, accepted, revoked and
-- expired are one answer to the caller (`410 invitation_not_valid`), and there is now no read that
-- could tell them apart for anybody who reached the `app_auth` connection (`T-IAM-03`).
CREATE OR REPLACE FUNCTION auth_lookup_invitation(p_token_hash bytea)
RETURNS TABLE (
  invitation_id   uuid,
  organization_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT i.id, i.organization_id
  FROM   invitations i
  JOIN   organizations o ON o.id = i.organization_id
  -- A deactivated organization resolves to nothing, so its invitations answer exactly like an
  -- unknown token — the caller is told 410 without being told why (acceptance 8 of STORY-012-02).
  -- Unlike the password-reset resolver, the join is worth its cost here: the organization can be
  -- soft-deleted while an invitation is still open, and the state is reachable.
  WHERE  i.token_hash = p_token_hash
    AND  o.deleted_at IS NULL
$$;

COMMENT ON FUNCTION auth_lookup_invitation(bytea) IS
  'bad-crm:auth-resolver — invitation: resolves an invite link to its organization by the digest of its token. Owned by app_auth_definer, EXECUTE granted to app_auth only.';

REVOKE ALL   ON FUNCTION auth_lookup_invitation(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_lookup_invitation(bytea) TO app_auth;

-- The owner needs `SELECT` on the tables this function reads — BYPASSRLS skips policies, not
-- privilege checks — and `01-grants.sql` re-applies the same grant after a restore through its
-- `definer_reads` list, which gains `invitations` in this change. `organizations` is already on it.
GRANT SELECT ON TABLE invitations TO app_auth_definer;

-- CREATE on the schema is required of the *new* owner and is taken and given back inside this
-- migration's single transaction, exactly as the four resolvers before it do: a BYPASSRLS role that
-- can create objects is a wider credential than app_auth_definer is meant to be, so no standing
-- privilege exists outside these statements.
GRANT CREATE ON SCHEMA public TO app_auth_definer;

ALTER FUNCTION auth_lookup_invitation(bytea) OWNER TO app_auth_definer;

REVOKE CREATE ON SCHEMA public FROM app_auth_definer;
