SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

-- An invitation to join this organization — **a role assignment written in advance**.
--
-- That is the whole shape of it, and the reason the policy that creates one applies the same subset
-- rule as an assignment (`T-IAM-09`): the account this will produce would otherwise hold rights its
-- author never had.
--
-- Three properties are the schema's rather than the code's:
--
--   * **the token is not here.** What is stored is `token_hash` — SHA-256 of 32 CSPRNG bytes — for
--     the same reason sessions store one: a dump, a backup or a curious operator must not yield a
--     working invitation. The raw value exists once, in the link that was handed out;
--   * **one open invitation per address.** The partial unique index below means the second «invite
--     ivan@acme.dev» is a conflict rather than a second live token. Partial, because a **closed**
--     invitation is history: inviting somebody again after they left is an ordinary thing to do;
--   * **the tenant, everywhere.** `organization_id` leads every composite foreign key, because
--     foreign key checks run as the table owner and bypass row-level security — a single-column
--     reference would happily confirm a role of another organization
--     (`rules/tenancy-rls.mdc`, 7).
CREATE TABLE "invitations" (
    "id"               UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id"  UUID           NOT NULL,
    "email"            TEXT           NOT NULL,
    -- Optional: «somebody who can sign in and nothing else» is a legitimate invitation.
    "role_id"          UUID,
    -- A draft, not a membership: nothing references this until the invitation is accepted, and then
    -- it becomes rows in `team_members` and stops being read.
    "team_ids"         UUID[]         NOT NULL DEFAULT '{}',
    "token_hash"       TEXT           NOT NULL,
    "invited_by_id"    UUID           NOT NULL,
    "expires_at"       TIMESTAMPTZ(6) NOT NULL,
    -- `null` while it is still an invitation; a date once it became a person.
    "accepted_at"      TIMESTAMPTZ(6),
    "accepted_user_id" UUID,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_invitations" PRIMARY KEY ("id"),
    -- An address that cannot be an address is a token minted for nobody.
    CONSTRAINT "ck_invitations_email" CHECK (position('@' IN "email") > 1),
    -- An invitation that expires before it is created is a link that never worked.
    CONSTRAINT "ck_invitations_expiry" CHECK ("expires_at" > "created_at"),
    -- Accepted means accepted **by somebody**: the two columns move together or not at all, so
    -- «accepted by nobody» and «this person accepted, at no time» are states that cannot be stored.
    CONSTRAINT "ck_invitations_accepted_pair" CHECK (
        ("accepted_at" IS NULL) = ("accepted_user_id" IS NULL)
    ),
    CONSTRAINT "fk_invitations_organization_id" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    -- RESTRICT rather than SET NULL: a role with open invitations is a role somebody is about to
    -- hold, and deleting it out from under them is the change that should stop.
    CONSTRAINT "fk_invitations_role_id" FOREIGN KEY ("organization_id", "role_id")
        REFERENCES "roles" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "fk_invitations_invited_by_id" FOREIGN KEY ("organization_id", "invited_by_id")
        REFERENCES "users" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "fk_invitations_accepted_user_id" FOREIGN KEY ("organization_id", "accepted_user_id")
        REFERENCES "users" ("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- The credential, and the one unique key of this table declared **globally**: the digest is what a
-- caller presents, so a collision across organizations would be a collision of the credential.
-- One line, deliberately: the migration linter exempts an index from `CONCURRENTLY` only when the
-- `ON <table>` clause sits on the same line and names a table this file just created.
CREATE UNIQUE INDEX "uq_invitations_token" ON "invitations" ("token_hash");
-- One **open** invitation per address per organization; a closed one is history.
CREATE UNIQUE INDEX "idx_invitations_org_email" ON "invitations" ("organization_id", "email") WHERE "accepted_at" IS NULL;

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "invitations"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "invitations"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "invitations" TO app_user;
GRANT SELECT ON "invitations" TO backup_role;

CREATE TRIGGER "trg_invitations_updated_at"
  BEFORE UPDATE ON "invitations"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
