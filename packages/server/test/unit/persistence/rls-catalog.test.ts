import { describe, expect, it } from 'vitest';

import {
  POLICIES_SQL,
  ROW_SECURITY_SQL,
  TENANT_COLUMN_TABLES_SQL,
} from '@/infrastructure/persistence/prisma/rls-catalog.constant.js';
import {
  readRlsCatalog,
  rlsCatalogViolations,
  type RlsCatalogFacts,
  type RlsPolicyFacts,
} from '@/infrastructure/persistence/prisma/rls-catalog.util.js';
import { type TenantTableSpec } from '@/infrastructure/persistence/prisma/tenant-tables.constant.js';

/**
 * The audit itself, without a database.
 *
 * `rlsCatalogViolations` is the whole of what `pnpm check:rls` decides; the reader beside it only
 * turns three catalog queries into the facts below. Exercising it here is what makes the positive
 * control cheap: every mistake this check exists to catch — a policy that lost its `WITH CHECK`, a
 * table that lost `FORCE`, a policy addressed to `PUBLIC` — is one field of a fixture, and the
 * suite proves the finding appears rather than trusting that it would.
 */

const CANONICAL = "(organization_id = (current_setting('app.organization_id'::text))::uuid)";
const CANONICAL_BY_KEY = "(id = (current_setting('app.organization_id'::text))::uuid)";

const tenantPolicy = (table: string, overrides: Partial<RlsPolicyFacts> = {}): RlsPolicyFacts => ({
  table,
  policy: 'tenant_isolation',
  permissive: true,
  roles: ['app_user'],
  command: '*',
  using: CANONICAL,
  check: CANONICAL,
  ...overrides,
});

const REGISTRY: Record<string, TenantTableSpec> = {
  organizations: {
    model: 'Organization',
    tenantColumn: 'id',
    appUserPrivileges: ['SELECT', 'INSERT', 'UPDATE'],
    softDeleted: true,
  },
  teams: {
    model: 'Team',
    tenantColumn: 'organization_id',
    appUserPrivileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    softDeleted: true,
  },
};

const SCHEMA_TABLES = [
  { model: 'Organization', table: 'organizations' },
  { model: 'Team', table: 'teams' },
];

const healthyFacts = (): RlsCatalogFacts => ({
  tables: [
    { table: 'organizations', rlsEnabled: true, rlsForced: true },
    { table: 'teams', rlsEnabled: true, rlsForced: true },
  ],
  tenantColumnTables: ['teams'],
  policies: [
    tenantPolicy('organizations', { using: CANONICAL_BY_KEY, check: CANONICAL_BY_KEY }),
    tenantPolicy('teams'),
    {
      table: 'teams',
      policy: 'maintenance_access',
      permissive: true,
      roles: ['app_migrator'],
      command: '*',
      using: "(current_setting('app.maintenance'::text, true) = 'on'::text)",
      check: "(current_setting('app.maintenance'::text, true) = 'on'::text)",
    },
  ],
});

const audit = (facts: RlsCatalogFacts): ReturnType<typeof rlsCatalogViolations> =>
  rlsCatalogViolations(facts, REGISTRY, SCHEMA_TABLES);

/** Findings flattened for matching: the remedy is part of what a finding says, not decoration. */
const problems = (facts: RlsCatalogFacts): string[] =>
  audit(facts).map((finding) => `${finding.subject}: ${finding.problem} — ${finding.remedy}`);

describe('a database that matches the specification', () => {
  it('reports nothing at all', () => {
    expect(audit(healthyFacts())).toEqual([]);
  });
});

describe('row level security', () => {
  it('reports a tenant table without ENABLE', () => {
    const facts = healthyFacts();
    facts.tables[1] = { table: 'teams', rlsEnabled: false, rlsForced: true };

    expect(problems(facts)).toContainEqual(expect.stringContaining('ENABLE ROW LEVEL SECURITY'));
  });

  /**
   * The one no behavioural test can see. Without `FORCE` the owner reads every tenant's rows and
   * the application — which connects as `app_user` — behaves exactly as it should.
   */
  it('reports a tenant table without FORCE', () => {
    const facts = healthyFacts();
    facts.tables[1] = { table: 'teams', rlsEnabled: true, rlsForced: false };

    expect(problems(facts)).toContainEqual(expect.stringContaining('FORCE ROW LEVEL SECURITY'));
  });
});

describe('the tenant policy', () => {
  it('reports a table with no policy addressed to app_user', () => {
    const facts = healthyFacts();
    facts.policies = facts.policies.filter((policy) => policy.table !== 'teams');

    expect(problems(facts)).toContainEqual(expect.stringContaining('no policy'));
  });

  /**
   * The defect this project has already shipped once. PostgreSQL substitutes `USING` for a missing
   * `WITH CHECK` on a `FOR ALL` policy, so every isolation test stays green — and the substitution
   * disappears the day the policy is split per command, at which point a tenant can write rows
   * into another tenant.
   */
  it('reports a FOR ALL policy with no WITH CHECK', () => {
    const facts = healthyFacts();
    facts.policies = [tenantPolicy('organizations', { using: CANONICAL_BY_KEY, check: null })];
    facts.tables = [{ table: 'organizations', rlsEnabled: true, rlsForced: true }];
    facts.tenantColumnTables = [];

    expect(problems(facts)).toContainEqual(expect.stringContaining('WITH CHECK'));
  });

  it('reports a policy with no USING', () => {
    const facts = healthyFacts();
    facts.policies = facts.policies.map((policy) =>
      policy.table === 'teams' && policy.policy === 'tenant_isolation'
        ? { ...policy, using: null }
        : policy,
    );

    expect(problems(facts)).toContainEqual(expect.stringContaining('USING'));
  });

  it('reports a predicate that is not the canonical one', () => {
    const facts = healthyFacts();
    facts.policies = facts.policies.map((policy) =>
      policy.table === 'teams' && policy.policy === 'tenant_isolation'
        ? { ...policy, using: 'true' }
        : policy,
    );

    expect(problems(facts)).toContainEqual(expect.stringContaining('canonical'));
  });

  /**
   * The asymmetric case: what may be read is the tenant, what may be written is anything. Nobody
   * notices until a row is written into — or moved into — another organization, and by then the
   * row is there.
   */
  it('reports a WITH CHECK wider than the canonical predicate', () => {
    const facts = healthyFacts();
    facts.policies = facts.policies.map((policy) =>
      policy.table === 'teams' && policy.policy === 'tenant_isolation'
        ? { ...policy, check: 'true' }
        : policy,
    );

    expect(problems(facts)).toContainEqual(
      expect.stringContaining('WITH CHECK is not the canonical'),
    );
  });

  /**
   * The registry knows the tenant column of every table; the template used to accept either of the
   * two for all of them. A `teams` policy comparing `id` is then canonical as far as the check is
   * concerned — and `id` is the primary key, so the predicate is `key = <the organization>`, which
   * matches nothing. Fail-closed, and therefore not a leak; it presents as "the list is empty",
   * which is precisely the symptom `tenant-scoped.repository.ts` warns takes a day to diagnose.
   */
  it('reports a tenant policy comparing a column other than the one the registry declares', () => {
    const facts = healthyFacts();
    facts.policies = facts.policies.map((policy) =>
      policy.table === 'teams' && policy.policy === 'tenant_isolation'
        ? { ...policy, using: CANONICAL_BY_KEY, check: CANONICAL_BY_KEY }
        : policy,
    );

    expect(problems(facts)).toContainEqual(expect.stringContaining('canonical'));
  });

  /** The mirror of the case above: the tenant root really does compare its own key. */
  it('accepts the tenant root comparing its primary key', () => {
    expect(audit(healthyFacts())).toEqual([]);
  });

  it('reports a policy addressed to PUBLIC instead of a role', () => {
    const facts = healthyFacts();
    facts.policies = facts.policies.map((policy) =>
      policy.table === 'teams' && policy.policy === 'tenant_isolation'
        ? { ...policy, roles: [] }
        : policy,
    );

    expect(problems(facts)).toContainEqual(expect.stringContaining('PUBLIC'));
  });

  /**
   * PostgreSQL rejects `WITH CHECK` on a `SELECT` or `DELETE` policy and `USING` on an `INSERT`
   * one, so demanding both from every policy would make the split-per-command form of
   * `rules/tenancy-rls.mdc` → «Исключения» permanently red.
   */
  it('accepts a per-command split where the missing half cannot exist', () => {
    const facts = healthyFacts();
    facts.policies = [
      tenantPolicy('organizations', { using: CANONICAL_BY_KEY, check: CANONICAL_BY_KEY }),
      tenantPolicy('teams', { policy: 'tenant_read', command: 'r', check: null }),
      tenantPolicy('teams', { policy: 'tenant_insert', command: 'a', using: null }),
      tenantPolicy('teams', { policy: 'tenant_delete', command: 'd', check: null }),
    ];

    expect(audit(facts)).toEqual([]);
  });
});

/**
 * Policies on a tenant table that are addressed to somebody other than `app_user`.
 *
 * The check used to look at those addressed to `app_user` and stop there, which left the widest
 * hole it could have left: PERMISSIVE policies combine with OR *per role*, so a second permissive
 * policy on a tenant table grants its role everything its predicate admits. `TO app_migrator
 * USING (true)` is the realistic shape — `maintenance_access` recreated during a hand repair
 * without its switch predicate — and after it every `app_migrator` connection (a migration, a psql
 * session, a maintenance script, a restore) reads every organization again. The container-started
 * suite catches that through its own per-table assertions; on the live host `pnpm check:rls` exists
 * for, nothing did.
 */
describe('policies on a tenant table addressed to another role', () => {
  const maintenance = (table: string, overrides: Partial<RlsPolicyFacts> = {}): RlsPolicyFacts => ({
    table,
    policy: 'maintenance_access',
    permissive: true,
    roles: ['app_migrator'],
    command: '*',
    using: "(current_setting('app.maintenance'::text, true) = 'on'::text)",
    check: "(current_setting('app.maintenance'::text, true) = 'on'::text)",
    ...overrides,
  });

  it('CONTROL: accepts the canonical maintenance switch', () => {
    const facts = healthyFacts();
    facts.policies = [...facts.policies, maintenance('organizations')];

    expect(audit(facts)).toEqual([]);
  });

  it('reports a permissive policy for the owner that lost its switch predicate', () => {
    const facts = healthyFacts();
    facts.policies = facts.policies.map((policy) =>
      policy.policy === 'maintenance_access' ? maintenance('teams', { using: 'true' }) : policy,
    );

    expect(problems(facts)).toContainEqual(
      expect.stringContaining('teams.maintenance_access: a PERMISSIVE policy'),
    );
  });

  it('reports a permissive INSERT policy whose WITH CHECK admits anything', () => {
    const facts = healthyFacts();
    facts.policies = [
      ...facts.policies,
      maintenance('teams', { policy: 'seed_rows', command: 'a', using: null, check: 'true' }),
    ];

    expect(problems(facts)).toContainEqual(expect.stringContaining('teams.seed_rows'));
  });

  /**
   * RESTRICTIVE policies combine with AND: they can only narrow what another policy already
   * admitted, so an arbitrary predicate in one is not a widening and must not be reported —
   * `rules/tenancy-rls.mdc` rule 6 offers it as the sanctioned way to add a policy.
   */
  it('CONTROL: accepts a restrictive policy with any predicate at all', () => {
    const facts = healthyFacts();
    facts.policies = [
      ...facts.policies,
      maintenance('teams', {
        policy: 'maintenance_not_deleted',
        permissive: false,
        using: '(deleted_at IS NULL)',
        check: null,
      }),
    ];

    expect(audit(facts)).toEqual([]);
  });
});

describe('the registry, the schema and the catalog', () => {
  it('reports a table carrying organization_id that the registry does not list', () => {
    const facts = healthyFacts();
    facts.tables.push({ table: 'tasks', rlsEnabled: true, rlsForced: true });
    facts.tenantColumnTables.push('tasks');
    facts.policies.push(tenantPolicy('tasks'));

    expect(problems(facts)).toContainEqual(expect.stringContaining('tasks'));
  });

  it('reports a registry entry the database does not have', () => {
    const facts = healthyFacts();
    facts.tables = facts.tables.filter((table) => table.table !== 'teams');
    facts.tenantColumnTables = [];
    facts.policies = facts.policies.filter((policy) => policy.table !== 'teams');

    expect(problems(facts)).toContainEqual(expect.stringContaining('teams'));
  });

  it('reports a registry entry whose tenant column is missing from the table', () => {
    const facts = healthyFacts();
    facts.tenantColumnTables = [];

    expect(problems(facts)).toContainEqual(expect.stringContaining('organization_id'));
  });

  it('reports a table with organization_id that no Prisma model carries', () => {
    const facts = healthyFacts();
    facts.tables.push({ table: 'rogue_notes', rlsEnabled: true, rlsForced: true });
    facts.tenantColumnTables.push('rogue_notes');
    facts.policies.push(tenantPolicy('rogue_notes'));

    expect(problems(facts)).toContainEqual(expect.stringContaining('drifted away from the schema'));
  });

  it('reports a registry entry no Prisma model backs any more', () => {
    const findings = rlsCatalogViolations(healthyFacts(), REGISTRY, [
      { model: 'Organization', table: 'organizations' },
    ]);

    expect(findings.map((finding) => finding.problem)).toContainEqual(
      expect.stringContaining('no Prisma model carries the tenant'),
    );
  });

  it('reports a Prisma model the registry does not list', () => {
    const findings = rlsCatalogViolations(healthyFacts(), REGISTRY, [
      ...SCHEMA_TABLES,
      { model: 'Task', table: 'tasks' },
    ]);

    expect(findings.map((finding) => finding.subject)).toContainEqual('tasks');
  });
});

/**
 * The reader is three queries and a mapping, and the mapping is where a driver quirk hides: a
 * `name[]` handed back as the literal `{app_user}` leaves every assertion true except the empty
 * array that marks a policy addressed to PUBLIC.
 */
describe('reading the catalog', () => {
  const answers: Record<string, unknown[]> = {
    [ROW_SECURITY_SQL]: [{ table_name: 'teams', rls_enabled: true, rls_forced: false }],
    [TENANT_COLUMN_TABLES_SQL]: [{ table_name: 'teams' }],
    [POLICIES_SQL]: [
      {
        table_name: 'teams',
        policy_name: 'tenant_isolation',
        permissive: true,
        roles: ['app_user'],
        command: '*',
        using_expression: CANONICAL,
        check_expression: null,
      },
    ],
  };

  const readerOver =
    (rows: Record<string, unknown[]>) =>
    async <Row>(sql: string): Promise<Row[]> =>
      (rows[sql] ?? []) as Row[];

  it('maps every catalog row onto the facts the audit reads', async () => {
    const facts = await readRlsCatalog(readerOver(answers));

    expect(facts.tables).toEqual([{ table: 'teams', rlsEnabled: true, rlsForced: false }]);
    expect(facts.tenantColumnTables).toEqual(['teams']);
    expect(facts.policies[0]?.check).toBeNull();
    expect(facts.policies[0]?.roles).toEqual(['app_user']);
  });

  it('refuses a roles column the driver did not parse into an array', async () => {
    const policies = [{ ...(answers[POLICIES_SQL]?.[0] as object), roles: '{app_user}' }];

    await expect(
      readRlsCatalog(readerOver({ ...answers, [POLICIES_SQL]: policies })),
    ).rejects.toThrow(/not as an array of role names/);
  });
});
