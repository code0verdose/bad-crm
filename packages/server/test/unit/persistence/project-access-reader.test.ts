import { type Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaProjectAccessReader } from '@/infrastructure/persistence/prisma/project-access-reader.adapter.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * The project half of the implicit table, with the driver replaced by a recorder.
 *
 * What the recorder can hold: one statement; both ids bound; the tenant bound; the membership
 * joined **left**, filtered to `left_at IS NULL`, and the project to `deleted_at IS NULL`. Whether
 * the column names are the ones the migration created is the integration suite's question — and
 * it is the one that matters for this adapter, which was written against `data-model.md` §3
 * beside the migration rather than after it.
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

const read = (recorder: Recorder) =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    new PrismaProjectAccessReader().aclFacts(PROJECT, IVAN),
  );

describe('PrismaProjectAccessReader.aclFacts', () => {
  it('is one statement, joined left on the live membership of the person', async () => {
    const recorder = recordingClient();

    await read(recorder);

    expect(recorder.statements).toHaveLength(1);

    const [statement] = recorder.statements;

    expect(statement?.sql).toContain('FROM projects p');
    expect(statement?.sql).toContain('LEFT JOIN project_members pm');
    expect(statement?.sql).toContain('pm.left_at IS NULL');
    expect(statement?.sql).toContain('p.deleted_at IS NULL');
    expect(statement?.values).toEqual([IVAN, ORG, PROJECT]);
  });

  it('shapes a member’s row into facts', async () => {
    const recorder = recordingClient([
      { organization_id: ORG, visibility: 'PRIVATE', member_role: 'REVIEWER' },
    ]);

    await expect(read(recorder)).resolves.toEqual({
      organizationId: ORG,
      visibility: 'PRIVATE',
      memberRole: 'REVIEWER',
    });
  });

  it('keeps a non-member as a row with no role — the bystander of a public project', async () => {
    const recorder = recordingClient([
      { organization_id: ORG, visibility: 'PUBLIC_ORG', member_role: null },
    ]);

    await expect(read(recorder)).resolves.toEqual({
      organizationId: ORG,
      visibility: 'PUBLIC_ORG',
      memberRole: null,
    });
  });

  it('answers null for no row — deleted, elsewhere, or never there', async () => {
    await expect(read(recordingClient([]))).resolves.toBeNull();
  });

  it('refuses to run outside a tenant scope', async () => {
    await expect(new PrismaProjectAccessReader().aclFacts(PROJECT, IVAN)).rejects.toThrow(
      /ProjectAccessReader\.aclFacts/,
    );
  });
});
