import {
  CANONICAL_MAINTENANCE_PREDICATE,
  CANONICAL_TENANT_PREDICATE,
  POLICIES_SQL,
  ROW_SECURITY_SQL,
  TENANT_COLUMN_TABLES_SQL,
} from './rls-catalog.constant.js';
import {
  TENANT_TABLES,
  tenantTablesFromSchema,
  type TenantColumn,
  type TenantTableSpec,
} from './tenant-tables.constant.js';

/**
 * Invariant 1 of CLAUDE.md, read back out of the catalog of a database that already exists.
 *
 * Split the way `assert-db-role.util.ts` is split, and for the same reason: `rlsCatalogViolations`
 * is a pure function over facts, so every finding it can produce is reachable from a fixture and
 * the check has a positive control that costs no container. `readRlsCatalog` beside it is the thin
 * half — three queries and a mapping.
 *
 * What is *not* here is anything about behaviour: whether one tenant can read another tenant's
 * rows is proved by `test/integration/db/rls-isolation.test.ts` against a real connection. This
 * module covers the half no query can observe from the outside — `FORCE ROW LEVEL SECURITY`, a
 * `WITH CHECK` that PostgreSQL silently substitutes, a policy addressed to `PUBLIC` — plus the
 * three-way agreement between the catalog, the Prisma schema and the tenant registry.
 */

/** The role every tenant policy is addressed to. */
const TENANT_ROLE = 'app_user';

/** The owner of the schema, whose only sanctioned policy is the maintenance switch. */
const OWNER_ROLE = 'app_migrator';

/** `polcmd` letters whose policy is applied to rows being read. */
const COMMANDS_WITH_USING = new Set(['*', 'r', 'w', 'd']);

/** `polcmd` letters whose policy is applied to rows being written. */
const COMMANDS_WITH_CHECK = new Set(['*', 'a', 'w']);

const COMMAND_NAMES: Record<string, string> = {
  '*': 'ALL',
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
};

export interface RlsTableFacts {
  readonly table: string;
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
}

export interface RlsPolicyFacts {
  readonly table: string;
  readonly policy: string;
  readonly permissive: boolean;
  /** Empty for a policy addressed to `PUBLIC` — see `POLICIES_SQL`. */
  readonly roles: readonly string[];
  /** `polcmd`: `*`, `r`, `a`, `w` or `d`. */
  readonly command: string;
  readonly using: string | null;
  readonly check: string | null;
}

export interface RlsCatalogFacts {
  /** Every ordinary and partitioned table of `public`, whether tenant-scoped or not. */
  tables: RlsTableFacts[];
  /** Those of them that carry an `organization_id` column. */
  tenantColumnTables: string[];
  policies: RlsPolicyFacts[];
}

export type RlsCheck = 'row-security' | 'policy' | 'registry';

export interface RlsFinding {
  readonly check: RlsCheck;
  /** The table, or `table.policy` where the finding is about one policy. */
  readonly subject: string;
  readonly problem: string;
  readonly remedy: string;
}

/** A model of the Prisma schema that carries the tenant, as `tenantTablesFromSchema` returns it. */
export interface SchemaTenantTable {
  readonly model: string;
  readonly table: string;
}

/**
 * A table whose tenant column the registry does not declare is judged against `organization_id`.
 *
 * That is the case of a table found in the catalog and in no registry — the drift the check reports
 * separately. `id` is reserved for tables the registry names as the tenant root: guessing it here
 * would make the rogue table's own primary key an acceptable isolation boundary.
 */
const DEFAULT_TENANT_COLUMN: TenantColumn = 'organization_id';

const isCanonical = (predicate: string | null, column: TenantColumn): boolean =>
  predicate !== null && CANONICAL_TENANT_PREDICATE[column].test(predicate);

/** The maintenance switch of `app_migrator`, the one non-tenant predicate the specification has. */
const isMaintenanceSwitch = (predicate: string | null): boolean =>
  predicate !== null && CANONICAL_MAINTENANCE_PREDICATE.test(predicate);

const commandName = (command: string): string => COMMAND_NAMES[command] ?? command;

/**
 * Every way the database can disagree with the specification, in one list.
 *
 * All of them and not the first one, for the reason `databaseRoleViolations` gives: a database that
 * lost one policy has usually lost the migration that carried several, and an operator who repairs
 * them one run at a time learns about the second table after redeploying the fix for the first.
 */
export const rlsCatalogViolations = (
  facts: RlsCatalogFacts,
  registry: Record<string, TenantTableSpec> = TENANT_TABLES,
  schemaTables: readonly SchemaTenantTable[] = tenantTablesFromSchema(),
): RlsFinding[] => {
  const findings: RlsFinding[] = [];

  const registryTables = Object.keys(registry);
  const existingTables = new Set(facts.tables.map((table) => table.table));
  const withTenantColumn = new Set(facts.tenantColumnTables);
  const inSchema = new Set(schemaTables.map((entry) => entry.table));

  for (const table of facts.tenantColumnTables) {
    if (registry[table] === undefined) {
      findings.push({
        check: 'registry',
        subject: table,
        problem:
          'the table carries organization_id but is absent from the tenant registry, so no isolation test is generated for it',
        remedy: `add ${table} to TENANT_TABLES in src/infrastructure/persistence/prisma/tenant-tables.constant.ts and to ROW_FACTORIES`,
      });
    }

    if (!inSchema.has(table)) {
      findings.push({
        check: 'registry',
        subject: table,
        problem:
          'the table carries organization_id but no Prisma model does — the database has drifted away from the schema',
        remedy: `either model ${table} in prisma/schema.prisma or drop it in a migration; a table nothing owns is a table nothing keeps isolated`,
      });
    }
  }

  for (const table of registryTables) {
    if (!existingTables.has(table)) {
      findings.push({
        check: 'registry',
        subject: table,
        problem: 'listed in the tenant registry, absent from this database',
        remedy: `apply the pending migrations to this database, or remove ${table} from TENANT_TABLES if it was dropped`,
      });
      continue;
    }

    if (registry[table]?.tenantColumn === 'organization_id' && !withTenantColumn.has(table)) {
      findings.push({
        check: 'registry',
        subject: table,
        problem:
          'the registry says the tenant column is organization_id, and the table in this database has no such column',
        remedy: `compare prisma/schema.prisma with the applied migrations for ${table}`,
      });
    }

    if (!inSchema.has(table)) {
      findings.push({
        check: 'registry',
        subject: table,
        problem: 'listed in the tenant registry, but no Prisma model carries the tenant for it',
        remedy: `remove ${table} from TENANT_TABLES, or give its model an organizationId field`,
      });
    }
  }

  for (const { model, table } of schemaTables) {
    if (registry[table] === undefined) {
      findings.push({
        check: 'registry',
        subject: table,
        problem: `the Prisma model ${model} carries the tenant but the registry does not list its table`,
        remedy: `add ${table} to TENANT_TABLES in src/infrastructure/persistence/prisma/tenant-tables.constant.ts`,
      });
    }
  }

  const tenantTables = [...new Set([...registryTables, ...facts.tenantColumnTables])]
    .filter((table) => existingTables.has(table))
    .sort();

  for (const table of tenantTables) {
    const state = facts.tables.find((candidate) => candidate.table === table);

    if (state?.rlsEnabled !== true) {
      findings.push({
        check: 'row-security',
        subject: table,
        problem: 'row level security is not enabled, so the tenant policies are not applied at all',
        remedy: `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
      });
    }

    if (state?.rlsForced !== true) {
      findings.push({
        check: 'row-security',
        subject: table,
        problem:
          'row level security is not forced, so the owner of the table reads and writes every tenant without a policy ever applying',
        remedy: `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
      });
    }

    const policies = facts.policies.filter((policy) => policy.table === table);
    const tenantPolicies = policies.filter((policy) => policy.roles.includes(TENANT_ROLE));
    const tenantColumn = registry[table]?.tenantColumn ?? DEFAULT_TENANT_COLUMN;

    if (tenantPolicies.length === 0) {
      findings.push({
        check: 'policy',
        subject: table,
        problem: `no policy is addressed to ${TENANT_ROLE}, so the application sees no rows of this table at all — or every row, if row level security is also off`,
        remedy: `create the canonical tenant_isolation policy for ${table} in the migration that created the table (docs/security/rls-design.md)`,
      });
    }

    for (const policy of policies) {
      if (policy.roles.length === 0) {
        findings.push({
          check: 'policy',
          subject: `${table}.${policy.policy}`,
          problem:
            'the policy is addressed to PUBLIC rather than to a role, so it also applies to roles that must never be filtered by it',
          remedy: `recreate the policy with TO ${TENANT_ROLE}`,
        });
      }

      /**
       * Every PERMISSIVE policy on a tenant table, whoever it is addressed to.
       *
       * This used to run over the policies addressed to `app_user` only, and that is the wrong
       * half. PERMISSIVE policies combine with OR *within a role*, so a permissive policy for
       * `app_migrator` admitting anything gives every `app_migrator` connection — a migration, a
       * psql session, a maintenance script, a restore — the rows of every organization, and says
       * nothing at all about `app_user`. `maintenance_access` recreated during a hand repair
       * without its switch predicate is exactly that policy, and it is a repair somebody makes on
       * the staging host this script is pointed at.
       *
       * Two predicates are acceptable on a tenant table: the tenant one, and the maintenance
       * switch of `docs/security/rls-design.md`. RESTRICTIVE policies are skipped because they
       * combine with AND — they can only narrow what something else already admitted, which is why
       * `rules/tenancy-rls.mdc` rule 6 offers them as the sanctioned way to add a policy.
       */
      if (!policy.permissive) continue;

      const predicates = [policy.using, policy.check].filter(
        (predicate): predicate is string => predicate !== null,
      );
      const widens = predicates.some(
        (predicate) => !isCanonical(predicate, tenantColumn) && !isMaintenanceSwitch(predicate),
      );

      if (predicates.length > 0 && widens) {
        findings.push({
          check: 'policy',
          subject: `${table}.${policy.policy}`,
          problem: `a PERMISSIVE policy combines with OR, so this one widens the access of ${policy.roles.join(', ') || 'PUBLIC'} rather than narrowing it: ${predicates.join(' / ')}`,
          remedy: `make the policy RESTRICTIVE, carry the tenant predicate (${tenantColumn} = current_setting('app.organization_id')::uuid) inside it, or — for ${OWNER_ROLE} — the maintenance switch current_setting('app.maintenance', true) = 'on'`,
        });
      }
    }

    for (const policy of tenantPolicies) {
      const subject = `${table}.${policy.policy}`;

      if (COMMANDS_WITH_USING.has(policy.command)) {
        if (policy.using === null) {
          findings.push({
            check: 'policy',
            subject,
            problem: `the policy covers ${commandName(policy.command)} and has no USING clause`,
            remedy: 'add USING with the canonical tenant predicate',
          });
        } else if (!isCanonical(policy.using, tenantColumn)) {
          findings.push({
            check: 'policy',
            subject,
            problem: `USING is not the canonical tenant predicate: ${policy.using}`,
            remedy: `USING (${tenantColumn} = current_setting('app.organization_id')::uuid) — anything else is a predicate nobody reviewed as an isolation boundary`,
          });
        }
      }

      if (COMMANDS_WITH_CHECK.has(policy.command)) {
        if (policy.check === null) {
          findings.push({
            check: 'policy',
            subject,
            problem: `the policy covers ${commandName(policy.command)} and has no WITH CHECK clause — PostgreSQL substitutes USING here, so no behavioural test can see this, and the substitution ends the moment the policy is split per command`,
            remedy: 'add WITH CHECK with the same predicate as USING',
          });
        } else if (!isCanonical(policy.check, tenantColumn)) {
          findings.push({
            check: 'policy',
            subject,
            problem: `WITH CHECK is not the canonical tenant predicate: ${policy.check}`,
            remedy: `WITH CHECK (${tenantColumn} = current_setting('app.organization_id')::uuid) — a writable predicate wider than the readable one lets a tenant write into another tenant`,
          });
        }
      }
    }
  }

  return findings;
};

/** Reads one catalog query. `pg`, Prisma and psql all reduce to this. */
export type CatalogReader = <Row>(sql: string) => Promise<Row[]>;

interface TableRow {
  readonly table_name: string;
  readonly rls_enabled: boolean;
  readonly rls_forced: boolean;
}

interface TenantColumnRow {
  readonly table_name: string;
}

interface PolicyRow {
  readonly table_name: string;
  readonly policy_name: string;
  readonly permissive: boolean;
  readonly roles: unknown;
  readonly command: string;
  readonly using_expression: string | null;
  readonly check_expression: string | null;
}

/**
 * The roles of a policy, or a loud failure.
 *
 * A driver that hands back `{app_user}` as a string rather than an array breaks exactly one thing:
 * the empty array that marks a policy addressed to `PUBLIC`. Nothing else changes — `includes` is
 * true for the substring as well — so the check keeps passing and stops looking at the one case it
 * was asked about. `POLICIES_SQL` casts to `text[]` so this cannot happen; this is the guard that
 * turns a future regression into an error instead of a quiet pass.
 */
const asRoleList = (roles: unknown, policy: string): string[] => {
  if (Array.isArray(roles) && roles.every((role): role is string => typeof role === 'string')) {
    return roles;
  }

  throw new TypeError(
    `the catalog returned the roles of policy ${policy} as ${typeof roles}, not as an array of role names — a policy addressed to PUBLIC would read as one addressed to a role`,
  );
};

/**
 * The three queries, mapped onto the facts the audit reads.
 *
 * Every one of them touches `pg_catalog` only, so the connection needs no privilege beyond being
 * able to connect: the catalog relations they read are world-readable. `pg_get_expr` is the one
 * call worth knowing about — it returns a policy predicate for any relation the caller may see,
 * and every role may see these. `test/integration/db/rls-catalog-check.test.ts` runs the whole
 * check as `app_user` rather than taking that on trust.
 */
export const readRlsCatalog = async (read: CatalogReader): Promise<RlsCatalogFacts> => {
  const [tables, tenantColumns, policies] = await Promise.all([
    read<TableRow>(ROW_SECURITY_SQL),
    read<TenantColumnRow>(TENANT_COLUMN_TABLES_SQL),
    read<PolicyRow>(POLICIES_SQL),
  ]);

  return {
    tables: tables.map((row) => ({
      table: row.table_name,
      rlsEnabled: row.rls_enabled,
      rlsForced: row.rls_forced,
    })),
    tenantColumnTables: tenantColumns.map((row) => row.table_name),
    policies: policies.map((row) => ({
      table: row.table_name,
      policy: row.policy_name,
      permissive: row.permissive,
      roles: asRoleList(row.roles, `${row.table_name}.${row.policy_name}`),
      command: row.command,
      using: row.using_expression,
      check: row.check_expression,
    })),
  };
};
