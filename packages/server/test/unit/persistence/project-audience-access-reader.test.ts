import { type Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaProjectAudienceAccessReader } from '@/infrastructure/persistence/prisma/project-audience-access-reader.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * The two statements of the audience read, with the driver replaced by a recorder.
 *
 * What a mock can decide: one statement per method, whatever the size of the organization; the
 * tenant and the project arriving as bound values (RLS would hide a missing tenant predicate from
 * the integration suite — `rules/testing.mdc`, «второй рубеж»); the audience limited to active,
 * undeleted accounts; the three subject branches present. What only the database can decide — that
 * the answer equals the per-person decision — is `test/integration/db/project-visibility-impact.test.ts`.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const PROJECT = '018f4a3b-0000-7000-8000-0000000000d1';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';

const recordingClient = (rows: unknown[]) => {
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

const inTenant = <T>(base: Parameters<typeof withTenant>[0], work: () => Promise<T>) =>
  withTenant(base, { organizationId: ORG, userId: null }, work);

describe('PrismaProjectAudienceAccessReader.seatsOf', () => {
  it('reads every active account with its live seat, in one statement bound to the tenant', async () => {
    const recorder = recordingClient([
      { user_id: IVAN, member_role: 'LEAD' },
      { user_id: ORG, member_role: null },
    ]);

    const seats = await inTenant(recorder.base, () =>
      new PrismaProjectAudienceAccessReader().seatsOf(PROJECT),
    );

    expect(seats).toEqual([
      { userId: IVAN, memberRole: 'LEAD' },
      { userId: ORG, memberRole: null },
    ]);
    expect(recorder.statements).toHaveLength(1);

    const [statement] = recorder.statements;

    expect(statement?.values).toEqual([PROJECT, ORG]);
    expect(statement?.sql).toMatch(/pm\.left_at IS NULL/);
    expect(statement?.sql).toMatch(/u\.status\s+= 'ACTIVE'/);
    expect(statement?.sql).toMatch(/u\.deleted_at IS NULL/);
  });
});

describe('PrismaProjectAudienceAccessReader.grantsOn', () => {
  it('reads the live grants on PROJECT → ORGANIZATION for every active account, in one statement', async () => {
    const expiresAt = new Date('2026-10-01T00:00:00.000Z');
    const recorder = recordingClient([
      { user_id: IVAN, depth: 0, level: 'VIEWER', expires_at: expiresAt },
    ]);

    const grants = await inTenant(recorder.base, () =>
      new PrismaProjectAudienceAccessReader().grantsOn(PROJECT),
    );

    expect(grants).toEqual([{ userId: IVAN, depth: 0, level: 'VIEWER', expiresAt }]);
    expect(recorder.statements).toHaveLength(1);

    const [statement] = recorder.statements;

    // The chain first (project, organization), then the tenant on every table it touches.
    expect(statement?.values).toEqual([PROJECT, ORG, ORG, ORG, ORG, ORG]);
    expect(statement?.sql).toMatch(/\(0::int, 'PROJECT'::acl_resource_type, \$1::uuid\)/);
    expect(statement?.sql).toMatch(/\(1::int, 'ORGANIZATION'::acl_resource_type, \$2::uuid\)/);
    expect(statement?.sql).toMatch(/a\.subject_type = 'USER' AND a\.subject_id = u\.id/);
    expect(statement?.sql).toMatch(/a\.subject_type = 'ROLE' AND EXISTS/);
    expect(statement?.sql).toMatch(/a\.subject_type = 'TEAM' AND EXISTS/);
    expect(statement?.sql).toMatch(/a\.expires_at IS NULL OR a\.expires_at > now\(\)/);
    expect(statement?.sql).toMatch(/ur\.expires_at IS NULL OR ur\.expires_at > now\(\)/);
    expect(statement?.sql).toMatch(/u\.status\s+= 'ACTIVE'/);
  });
});
