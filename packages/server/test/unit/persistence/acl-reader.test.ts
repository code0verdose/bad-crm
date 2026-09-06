import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { type AclChainNode } from '@/domain/access/acl-chain.types.js';
import { PrismaAclReader } from '@/infrastructure/persistence/prisma/acl-reader.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * The one statement of the resolver, with the driver replaced by a recorder.
 *
 * What a mock can decide about it: that there **is** exactly one statement however deep the chain
 * (acceptance 8 is a claim about the port, and this is where the port is held to it); that every
 * node arrives bound and cast; that the tenant predicate is a bound value and not a policy the
 * statement hopes for; that the three subject branches are all present. What only the database can
 * decide — that the join hits `uq_resource_acl`, that the enum casts are accepted, that
 * an expired row is dropped by `now()` — is `test/integration/db/resource-acl-reader.test.ts`.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const PROJECT = '018f4a3b-0000-7000-8000-0000000000d1';

interface Recorder {
  readonly statements: { sql: string; values: unknown[] }[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (rows: unknown[] = []): Recorder => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    $queryRaw: (query: Prisma.Sql): Promise<unknown[]> => {
      statements.push({ sql: query.text, values: query.values });

      return Promise.resolve(rows);
    },
  };

  return {
    statements,
    base: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const chain: readonly AclChainNode[] = [
  { depth: 0, type: 'PROJECT', id: PROJECT },
  { depth: 1, type: 'ORGANIZATION', id: ORG },
];

const read = (recorder: Recorder, nodes: readonly AclChainNode[] = chain) =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    new PrismaAclReader().entriesAlong(nodes, IVAN),
  );

describe('PrismaAclReader.entriesAlong', () => {
  it('sends exactly one statement for a chain of any depth', async () => {
    const recorder = recordingClient();
    const deep: readonly AclChainNode[] = [
      ...chain,
      { depth: 2, type: 'BOARD', id: PROJECT },
      { depth: 3, type: 'TASK', id: PROJECT },
    ];

    await read(recorder, deep);

    expect(recorder.statements).toHaveLength(1);
  });

  it('binds every node as (depth, type, id) with the casts the enum column needs', async () => {
    const recorder = recordingClient();

    await read(recorder);

    const [statement] = recorder.statements;

    expect(statement?.sql).toContain('WITH chain(depth, resource_type, resource_id) AS (VALUES');
    expect(statement?.sql).toMatch(/\(\$\d+::int, \$\d+::acl_resource_type, \$\d+::uuid\)/);
    expect(statement?.values.slice(0, 6)).toEqual([0, 'PROJECT', PROJECT, 1, 'ORGANIZATION', ORG]);
  });

  it('binds the tenant of the scope into the join, not into a hope about the policy', async () => {
    const recorder = recordingClient();

    await read(recorder);

    const [statement] = recorder.statements;

    expect(statement?.sql).toMatch(/a\.organization_id = \$\d+::uuid/);
    expect(statement?.values).toContain(ORG);
  });

  it('matches the person, their live roles and their teams inside the statement', async () => {
    const recorder = recordingClient();

    await read(recorder);

    const sql = recorder.statements[0]?.sql ?? '';

    expect(sql).toContain("a.subject_type = 'USER'");
    expect(sql).toContain("a.subject_type = 'ROLE'");
    expect(sql).toContain('FROM user_roles ur');
    expect(sql).toContain('ur.expires_at IS NULL OR ur.expires_at > now()');
    expect(sql).toContain("a.subject_type = 'TEAM'");
    expect(sql).toContain('FROM team_members tm');
    expect(recorder.statements[0]?.values.filter((value) => value === IVAN)).toHaveLength(3);
  });

  it('drops expired rows with an `expires_at > now()` filter and orders by depth', async () => {
    const recorder = recordingClient();

    await read(recorder);

    const sql = recorder.statements[0]?.sql ?? '';

    expect(sql).toContain('a.expires_at IS NULL OR a.expires_at > now()');
    expect(sql).toContain('ORDER BY c.depth');
    // No reduction in SQL: the closest-node, NONE and maximum rules are the policy's, applied once.
    expect(sql).not.toMatch(/GROUP BY|LIMIT|bool_or|max\(/);
  });

  it('maps the rows to entries the policy reads', async () => {
    const expiresAt = new Date('2026-12-31T00:00:00Z');
    const recorder = recordingClient([
      { depth: 1, level: 'EDITOR', expires_at: null },
      { depth: 0, level: 'VIEWER', expires_at: expiresAt },
    ]);

    await expect(read(recorder)).resolves.toEqual([
      { depth: 1, level: 'EDITOR', expiresAt: null },
      { depth: 0, level: 'VIEWER', expiresAt },
    ]);
  });

  it('answers an empty chain without a round trip', async () => {
    const recorder = recordingClient();

    await expect(read(recorder, [])).resolves.toEqual([]);
    expect(recorder.statements).toEqual([]);
  });

  it('refuses to run outside a tenant scope', async () => {
    await expect(new PrismaAclReader().entriesAlong(chain, IVAN)).rejects.toThrow(
      /AclReader\.entriesAlong/,
    );
  });
});
