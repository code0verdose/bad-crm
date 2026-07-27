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
}

export const TENANT_TABLES = {
  organizations: {
    model: 'Organization',
    tenantColumn: 'id',
    // No DELETE: removing an organization is an `app_migrator` operation carried out in
    // maintenance mode, not something a request can trigger (docs/security/rls-design.md).
    appUserPrivileges: ['SELECT', 'INSERT', 'UPDATE'],
  },
  teams: {
    model: 'Team',
    tenantColumn: 'organization_id',
    appUserPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
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
export const tenantTablesFromSchema = (): { model: string; table: string }[] =>
  Prisma.dmmf.datamodel.models
    .filter(
      (model) =>
        model.name === 'Organization' ||
        model.fields.some((field) => field.name === 'organizationId'),
    )
    .map((model) => ({ model: model.name, table: model.dbName ?? model.name }));
