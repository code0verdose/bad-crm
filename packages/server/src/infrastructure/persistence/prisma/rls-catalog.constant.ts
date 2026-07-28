/**
 * The canonical tenant policy, and the three catalog queries that read back what was actually
 * created — in one place, because two places is the defect.
 *
 * Two consumers read this module and no third definition exists:
 *   * `test/integration/db/migrations.test.ts`, which asserts the shape of the migration output
 *     against a database the suite starts itself;
 *   * `scripts/check-rls.ts`, which asserts the same shape against a database that already exists
 *     — a staging host restored from a production backup, where the migration ran long ago and
 *     nobody can start a container to compare against (docs/security/rls-design.md, «Проверка
 *     политики на снапшоте прод-объёма», step 3).
 *
 * Neither can replace the other, and a policy template written out twice would drift the first
 * time the template changed. `test/unit/persistence/rls-catalog-sources.test.ts` holds that
 * property mechanically: the catalog identifiers below must appear in this file and nowhere else
 * under `src/`, `test/` or `scripts/`.
 */

import { type TenantColumn } from './tenant-tables.constant.js';

/**
 * The right-hand side of the tenant predicate: the organization of the current scope.
 *
 * `String.raw` throughout, so the escapes below are the ones the regular expression needs and the
 * file still contains the literal `current_setting\('app\.organization_id'` that
 * `test/unit/persistence/rls-catalog-sources.test.ts` looks for when it proves there is no second
 * copy of this template.
 */
const TENANT_SCOPE_VALUE = String.raw`\(?(current_setting\('app\.organization_id'(::text)?\)\)?::uuid|app_current_org\(\))`;

/**
 * The canonical tenant predicate, **per tenant column**, and nothing else.
 *
 * Matched against `pg_get_expr`, so the shape is the one the catalog prints rather than the source
 * text of the migration: PostgreSQL normalises `current_setting('app.organization_id')::uuid` into
 * `(current_setting('app.organization_id'::text))::uuid` and adds the outer parentheses itself.
 *
 * Keyed by column and not a single expression accepting either, which is what it used to be. The
 * registry declares the tenant column of every table — `id` for `organizations`, which is the
 * tenant root and compares its own primary key, `organization_id` for everything else — so a
 * template that accepts both accepts `USING (id = current_setting('app.organization_id')::uuid)`
 * on an ordinary tenant table. That predicate compares a primary key against an organization id
 * and therefore matches nothing: fail-closed, so not a leak, but it presents as "there is no data"
 * — the symptom the header of `tenant-scoped.repository.ts` describes as the expensive one to
 * diagnose. The registry already knows the answer; the check now asks it.
 */
export const CANONICAL_TENANT_PREDICATE: Readonly<Record<TenantColumn, RegExp>> = Object.freeze({
  organization_id: new RegExp(String.raw`^\(?organization_id = ${TENANT_SCOPE_VALUE}\)?$`),
  id: new RegExp(String.raw`^\(?id = ${TENANT_SCOPE_VALUE}\)?$`),
});

/**
 * The other canonical predicate of the specification: the maintenance switch of `app_migrator`.
 *
 * It lives here for the same reason the tenant template does — it is now read by the audit, which
 * judges *every* permissive policy on a tenant table rather than only those addressed to
 * `app_user`, and by `test/integration/db/migrations.test.ts`, which asserts the migration produced
 * it. Two consumers, one definition.
 *
 * The catalog prints the expression with its casts (`'app.maintenance'::text`), so the shape is
 * matched rather than the source text of the migration.
 */
export const CANONICAL_MAINTENANCE_PREDICATE =
  /^\(?current_setting\('app\.maintenance'(::text)?, true\) = 'on'(::text)?\)?$/;

/** Ordinary and partitioned tables of `public`, with what row level security says about each. */
export const ROW_SECURITY_SQL = `
  SELECT c.relname                AS table_name,
         c.relrowsecurity         AS rls_enabled,
         c.relforcerowsecurity    AS rls_forced
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
   ORDER BY c.relname`;

/**
 * Tables that carry a tenant column, straight from the catalog rather than from the schema.
 *
 * This is the half of the cross-check the code cannot answer: a table created by hand on the
 * staging host, or one whose migration was applied and whose model was later deleted, exists here
 * and in no registry.
 */
export const TENANT_COLUMN_TABLES_SQL = `
  SELECT c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'organization_id'
                    AND a.attnum > 0 AND NOT a.attisdropped)
   ORDER BY c.relname`;

/**
 * Every policy in `public`, both predicates included.
 *
 * `polwithcheck` is read separately from `polqual` on purpose: on a `FOR ALL` policy PostgreSQL
 * applies `USING` when `WITH CHECK` is absent, so the omission changes no behaviour and no
 * behavioural test can see it — it reads as NULL here and nowhere else.
 *
 * The roles are resolved through `pg_roles`, which leaves the array empty for a policy addressed
 * to `PUBLIC`: `polroles` holds the pseudo-oid 0 there, and no catalog row matches it.
 *
 * `rolname::text` and not `rolname`: `rolname` is of type `name`, and `name[]` is a type the
 * PostgreSQL driver hands back as the raw literal `{app_user}` instead of an array. Everything then
 * still *looks* right — `roles.includes('app_user')` is true for the string as well — while
 * `roles.length === 0`, the test for a policy addressed to `PUBLIC`, is never true again. Measured:
 * with `name[]` the check passed over a `TO PUBLIC USING (true)` policy on a tenant table.
 */
export const POLICIES_SQL = `
  SELECT c.relname                                AS table_name,
         p.polname                                AS policy_name,
         p.polpermissive                          AS permissive,
         ARRAY(SELECT rolname::text FROM pg_roles WHERE oid = ANY (p.polroles)) AS roles,
         p.polcmd::text                           AS command,
         pg_get_expr(p.polqual, p.polrelid)       AS using_expression,
         pg_get_expr(p.polwithcheck, p.polrelid)  AS check_expression
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
   ORDER BY c.relname, p.polname`;
