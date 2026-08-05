SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';

-- The audit trail: append-only, partitioned by month, and unwritable by the application in the
-- only sense that matters — the privilege is not there.
--
-- ## Why the privilege and not a rule
--
-- `REVOKE UPDATE, DELETE, TRUNCATE ... FROM app_user` is the whole of `T-PLAT-05`. A journal the
-- application can rewrite is not a journal: it records what the code chose to admit, which is
-- exactly the thing under suspicion when anybody reads it. With the privilege gone, an attacker who
-- owns the process still cannot make an entry say something else — they would need the credentials
-- of `app_migrator`, which no request handler holds.
--
-- Deleting old data is therefore not a statement but a procedure: `DETACH PARTITION` by
-- `app_migrator` (STORY-016-05). That is the second reason for partitioning, and the first is size —
-- this table grows faster than every other one, and `DELETE` over millions of rows is hours of locks
-- and bloat where dropping a partition is instantaneous.
--
-- ## Three consequences of partitioning, all of them load-bearing
--
-- 1. **The primary key has to contain the partition key** — `(id, occurred_at)`. Nothing references
--    this table by foreign key, so the wider key costs nothing (`docs/architecture/data-model.md`,
--    «Где партиционирование»).
-- 2. **RLS is enabled on the parent *before* any partition exists.** A partition created under a
--    parent without row-level security would carry none.
-- 3. **Privileges are not inherited by partitions, policies effectively are.** A query against the
--    parent applies the parent's policies to every partition it touches and checks privileges on the
--    parent only — so the application reaches the data through the parent, and every leaf is
--    revoked from `app_user` outright (`prisma/sql/01-grants.sql`, step 2). The leaves still get
--    their own `ENABLE`+`FORCE`+policy from `create_audit_partition`, because "unreachable today"
--    is not a property to rest tenant isolation on.
--
-- ## Why a DEFAULT partition exists
--
-- A month with no partition is a month where every insert fails — and an insert that fails here
-- fails the transaction it audits, so a forgotten partition would stop the product rather than
-- degrade it. `ensure-audit-partitions.job.ts` creates them two months ahead; the DEFAULT partition
-- is what makes the failure of that job survivable. Rows landing in it are a symptom, not a design:
-- `audit_log_default_partition_rows` is the metric, and moving them out is part of attaching the
-- month they belong to.
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM', 'API_KEY', 'INTEGRATION');
CREATE TYPE "AuditSeverity"  AS ENUM ('INFO', 'WARNING', 'CRITICAL');

CREATE TABLE "audit_logs" (
    "id"              UUID           NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID           NOT NULL,
    -- Nullable, and without a foreign key on purpose. `SYSTEM` events have no actor at all, and an
    -- entry has to outlive the account it names: a journal that loses its actor when a person is
    -- removed answers «somebody» to the one question it exists for. The id stays as a value; who it
    -- was is resolved by joining when the row is displayed, and «no longer a user» is a legitimate
    -- answer there.
    "actor_id"        UUID,
    "actor_type"      "AuditActorType" NOT NULL,
    -- `role.assigned`, `audit.exported` — the vocabulary of §10 of the permission model, kept as
    -- text rather than an enum: every future domain adds actions, and a migration per action would
    -- be a migration nobody writes (and an enum value cannot be removed at all).
    "action"          TEXT           NOT NULL,
    "resource_type"   TEXT           NOT NULL,
    "resource_id"     UUID,
    -- Whitelisted fields only, never a whole row: `before`/`after` are shown to whoever may read the
    -- journal, and a row copied wholesale carries what they may not see (`permission-model.md` §10).
    "before"          JSONB,
    "after"           JSONB,
    -- The address is a personal datum and is never stored in the clear; the hash is what makes «the
    -- same address again» answerable without keeping it (`docs/security/threat-model.md`).
    "ip_hash"         TEXT,
    "user_agent"      TEXT,
    -- The thread that ties an HTTP request to the outbox event, the job and this entry.
    "request_id"      TEXT           NOT NULL,
    "severity"        "AuditSeverity" NOT NULL DEFAULT 'INFO',
    "occurred_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "pk_audit_logs" PRIMARY KEY ("id", "occurred_at"),
    CONSTRAINT "fk_audit_logs_organization_id" FOREIGN KEY ("organization_id")
        REFERENCES "organizations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
) PARTITION BY RANGE ("occurred_at");

-- Declared on the parent, which creates them on every existing partition and on every one attached
-- later — the one part of this schema that partitions do inherit.
--
-- The three shapes answer the three questions the journal is asked (`data-model.md`): the feed for a
-- period, the history of one object, the actions of one person. `organization_id` leads all three:
-- every query is inside one tenant, and a policy that filters by it wants it first.
CREATE INDEX "idx_audit_logs_org_occurred" ON "audit_logs"
    ("organization_id", "occurred_at" DESC);
CREATE INDEX "idx_audit_logs_resource" ON "audit_logs"
    ("organization_id", "resource_type", "resource_id", "occurred_at" DESC);
CREATE INDEX "idx_audit_logs_actor" ON "audit_logs"
    ("organization_id", "actor_id", "occurred_at" DESC);

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "audit_logs"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "audit_logs"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

-- Insert and read. Nothing else, and `REVOKE` rather than «not granted» because this statement is
-- also the repair path for a privilege somebody adds by hand later.
GRANT SELECT, INSERT ON "audit_logs" TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs" FROM app_user;
GRANT SELECT ON "audit_logs" TO backup_role;

-- One partition, one function — so that a month created by a migration, by the job or by an operator
-- is the same object with the same protections. Everything a partition needs that it does not
-- inherit lives here: row-level security, both policies, the grants, and the revocation of the leaf
-- from the application.
--
-- `SECURITY INVOKER` (the default) deliberately: it runs as `app_migrator`, which owns the table, and
-- giving it definer rights would create exactly the kind of borrowed authority `01-grants.sql`
-- spends a page auditing.
CREATE OR REPLACE FUNCTION create_audit_partition(month_start date)
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  partition_name text := format('audit_logs_%s', to_char(month_start, 'YYYY_MM'));
  range_start    date := date_trunc('month', month_start)::date;
  range_end      date := (date_trunc('month', month_start) + interval '1 month')::date;
BEGIN
  IF to_regclass(format('public.%I', partition_name)) IS NOT NULL THEN
    RETURN partition_name;
  END IF;

  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.audit_logs FOR VALUES FROM (%L) TO (%L)',
    partition_name, range_start, range_end);

  -- A leaf addressed directly answers with *its own* policies, not the parent's. It is unreachable
  -- for `app_user` because of the REVOKE below, and it still gets isolation: the two together are
  -- the reason a partition cannot become the hole in a table that has none.
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', partition_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', partition_name);
  EXECUTE format($p$
    CREATE POLICY "tenant_isolation" ON public.%I
      AS PERMISSIVE FOR ALL TO app_user
      USING      (organization_id = current_setting('app.organization_id')::uuid)
      WITH CHECK (organization_id = current_setting('app.organization_id')::uuid)$p$,
    partition_name);
  EXECUTE format($p$
    CREATE POLICY "maintenance_access" ON public.%I
      AS PERMISSIVE FOR ALL TO app_migrator
      USING      (current_setting('app.maintenance', true) = 'on')
      WITH CHECK (current_setting('app.maintenance', true) = 'on')$p$,
    partition_name);

  -- The backup reads leaf by leaf and stops on the first one it may not open, so this GRANT is what
  -- keeps `pg_dump` working the month after a partition is created.
  EXECUTE format('GRANT SELECT ON TABLE public.%I TO backup_role', partition_name);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM app_user', partition_name);

  RETURN partition_name;
END;
$$;

COMMENT ON FUNCTION create_audit_partition(date) IS
  'bad-crm:audit-partition — creates one month of audit_logs with its policies and grants';

-- The current month and the two after it, so a fresh installation writes from the first request and
-- keeps writing while nobody has scheduled anything yet.
SELECT create_audit_partition(date_trunc('month', now())::date);
SELECT create_audit_partition((date_trunc('month', now()) + interval '1 month')::date);
SELECT create_audit_partition((date_trunc('month', now()) + interval '2 month')::date);

-- The safety net. Not a place data is meant to live: an insert that arrives with no partition for
-- its month lands here instead of failing the transaction it was auditing.
CREATE TABLE "audit_logs_default" PARTITION OF "audit_logs" DEFAULT;

ALTER TABLE "audit_logs_default" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs_default" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "audit_logs_default"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING      ("organization_id" = current_setting('app.organization_id')::uuid)
  WITH CHECK ("organization_id" = current_setting('app.organization_id')::uuid);

CREATE POLICY "maintenance_access" ON "audit_logs_default"
  AS PERMISSIVE
  FOR ALL
  TO app_migrator
  USING      (current_setting('app.maintenance', true) = 'on')
  WITH CHECK (current_setting('app.maintenance', true) = 'on');

GRANT SELECT ON "audit_logs_default" TO backup_role;
REVOKE ALL ON "audit_logs_default" FROM app_user;
