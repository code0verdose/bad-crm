import { Prisma } from '@prisma/client';

/**
 * The registry of tenant-scoped tables.
 *
 * Written out by hand and checked against the schema at runtime, rather than derived from it. A
 * derived list has no literal type, so `ROW_FACTORIES` could not be typed as an exhaustive map and
 * a new table would simply be untested — the failure this registry exists to prevent
 * (docs/security/rls-design.md, «Генератор isolation-тестов»). Written out, the omission is a
 * compile error in the test suite and a failing assertion in `tenant-tables.test.ts`.
 *
 * `appUserPrivileges` is part of the contract, not documentation: it is what the integration suite
 * compares the catalog against, so a privilege silently widened by a future migration — `DELETE` on
 * `organizations`, a `TRUNCATE` anywhere — fails a test instead of shipping.
 */

export type TenantColumn = 'organization_id' | 'id';
export type TablePrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface TenantTableSpec {
  /** Prisma model backing the table, for the guard and for schema cross-checks. */
  readonly model: string;
  /** Column the tenant policy compares. `organizations` is the tenant root and compares its key. */
  readonly tenantColumn: TenantColumn;
  readonly appUserPrivileges: readonly TablePrivilege[];
  /**
   * The table carries `deleted_at` (docs/architecture/data-model.md, «Мягкое удаление»).
   *
   * Declared rather than assumed because the migration suite asserts the column list of every
   * registry table, and "every table has `deleted_at`" is false: a session is revoked and a reset
   * token is spent, neither is archived. Without the flag that assertion had to be dropped for all
   * tables to accommodate the ones that lack it — and a softly deleted table shipped without its
   * column would then pass. `tenant-tables.test.ts` holds the flag against the Prisma schema, so it
   * cannot drift into decoration.
   */
  readonly softDeleted: boolean;
  /**
   * The table carries `created_at` **and** `updated_at`, kept by the `set_updated_at` trigger.
   *
   * True of every table but a journal. An append-only log records *when the event happened*
   * (`occurred_at`) and is never modified, so a second stamp saying when the row last changed would
   * be a column with one possible value — `docs/architecture/data-model.md` («Timestamps и аудит
   * строки») excludes logs by name.
   *
   * Declared rather than derived because the migration suite asserts the pair on every registry
   * table, and «every table has them» became false the moment the first journal existed. Held
   * against the Prisma schema by `tenant-tables.test.ts`, and the suite additionally proves the
   * column is genuinely absent where the flag is false — so the flag cannot be used to excuse a
   * table that simply forgot them.
   */
  readonly rowTimestamps: boolean;
}

export const TENANT_TABLES = {
  audit_logs: {
    model: 'AuditLog',
    tenantColumn: 'organization_id',
    // Insert and read, and that is the entire security property of the table: a journal the
    // application can rewrite records what the application chose to admit (`T-PLAT-05`). Removing
    // old entries is `DETACH PARTITION` by `app_migrator`, not a statement a request can issue.
    appUserPrivileges: ['SELECT', 'INSERT'],
    softDeleted: false,
    rowTimestamps: false,
  },
  organizations: {
    model: 'Organization',
    tenantColumn: 'id',
    // No DELETE: removing an organization is an `app_migrator` operation carried out in
    // maintenance mode, not something a request can trigger (docs/security/rls-design.md).
    appUserPrivileges: ['SELECT', 'INSERT', 'UPDATE'],
    softDeleted: true,
    rowTimestamps: true,
  },
  password_reset_tokens: {
    model: 'PasswordResetToken',
    tenantColumn: 'organization_id',
    // DELETE, because expiry is enforced by removing the row: the cleanup job runs as the
    // application, per organization, inside `withTenant` (rules/tenancy-rls.mdc, 12).
    appUserPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    softDeleted: false,
    rowTimestamps: true,
  },
  role_permissions: {
    model: 'RolePermission',
    tenantColumn: 'organization_id',
    // Carries its own tenant column rather than reaching it through the role: a policy that had to
    // join would be a policy a join can defeat.
    appUserPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    softDeleted: false,
    rowTimestamps: true,
  },
  roles: {
    model: 'Role',
    tenantColumn: 'organization_id',
    appUserPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    softDeleted: false,
    rowTimestamps: true,
  },
  sessions: {
    model: 'Session',
    tenantColumn: 'organization_id',
    appUserPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    softDeleted: false,
    rowTimestamps: true,
  },
  teams: {
    model: 'Team',
    tenantColumn: 'organization_id',
    appUserPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    softDeleted: true,
    rowTimestamps: true,
  },
  users: {
    model: 'User',
    tenantColumn: 'organization_id',
    appUserPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    softDeleted: true,
    rowTimestamps: true,
  },
} as const satisfies Record<string, TenantTableSpec>;

export type TenantTableName = keyof typeof TENANT_TABLES;

/**
 * Tenant-scoped models as the generated schema sees them: everything carrying `organizationId`,
 * plus the tenant root, which carries the tenant in its primary key instead.
 *
 * Compared against the registry above by the test suite. Both directions matter — a model missing
 * from the registry is a table nothing isolates, and a registry entry with no model is a stale
 * expectation that keeps a deleted table's tests green.
 */
export const tenantTablesFromSchema = (): {
  model: string;
  table: string;
  softDeleted: boolean;
  rowTimestamps: boolean;
}[] =>
  Prisma.dmmf.datamodel.models
    .filter(
      (model) =>
        model.name === 'Organization' ||
        model.fields.some((field) => field.name === 'organizationId'),
    )
    .map((model) => ({
      model: model.name,
      table: model.dbName ?? model.name,
      softDeleted: model.fields.some((field) => field.name === 'deletedAt'),
      rowTimestamps: model.fields.some((field) => field.name === 'updatedAt'),
    }));
