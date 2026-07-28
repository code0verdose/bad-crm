import { type Organization } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaOrganizationRepository } from '@/infrastructure/persistence/prisma/organization.repository.js';
import { MissingTenantContextError } from '@/infrastructure/persistence/prisma/tenant.errors.js';
import { withTenant, type TxClient } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * The tenant root through Prisma, with the driver replaced by a recorder.
 *
 * What is asserted here is the *arguments* — the id written on create, the filter used on read —
 * because that is what a database cannot tell us: the policy would refuse a wrong id, so a live
 * test can only observe a rejection, never which id the repository chose. Whether the policy then
 * agrees is the subject of `test/integration/db/organization-bootstrap.test.ts`.
 */

const ORG = '018f4a3b-0000-7000-8000-000000000001';

const row = (id: string): Organization => ({
  id,
  slug: 'acme',
  name: 'Acme',
  timezone: 'Europe/Berlin',
  defaultCurrency: 'EUR',
  settings: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
  deletedAt: null,
});

interface Recorder {
  readonly createArgs: unknown[];
  readonly findArgs: unknown[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (found: Organization | null = null): Recorder => {
  const createArgs: unknown[] = [];
  const findArgs: unknown[] = [];

  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    organization: {
      create: (args: { data: { id: string } }): Promise<Organization> => {
        createArgs.push(args);

        return Promise.resolve(row(args.data.id));
      },
      findFirst: (args: unknown): Promise<Organization | null> => {
        findArgs.push(args);

        return Promise.resolve(found);
      },
    },
  } as unknown as TxClient;

  return {
    createArgs,
    findArgs,
    base: {
      $transaction: async (run: (handle: TxClient) => Promise<unknown>): Promise<unknown> =>
        run(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const repository = new PrismaOrganizationRepository();

const draft = {
  name: 'Acme',
  slug: 'acme',
  timezone: 'Europe/Berlin',
  defaultCurrency: 'EUR',
};

describe('PrismaOrganizationRepository', () => {
  /**
   * The mechanism of the bootstrap path: the row's primary key is taken from the scope, so the only
   * organization this repository can create is the one the caller declared it was acting as. There
   * is no parameter for it, deliberately (docs/security/rls-design.md, «Особый случай»).
   */
  it('writes the id of the current scope, which is the only id the policy would accept', async () => {
    const client = recordingClient();

    const created = await withTenant(client.base, { organizationId: ORG, userId: null }, () =>
      repository.create(draft),
    );

    expect(client.createArgs).toEqual([
      {
        data: {
          id: ORG,
          name: 'Acme',
          slug: 'acme',
          timezone: 'Europe/Berlin',
          defaultCurrency: 'EUR',
        },
      },
    ]);
    expect(created).toEqual({ id: ORG, ...draft });
  });

  it('refuses to create outside a tenant scope, before any statement is sent', async () => {
    const client = recordingClient();

    await expect(repository.create(draft)).rejects.toBeInstanceOf(MissingTenantContextError);
    expect(client.createArgs).toEqual([]);
  });

  /**
   * No `where: { id }`. The policy already restricts this table to one row, and a second statement
   * of the same condition is a second thing that can disagree with `app.organization_id`. The only
   * filter that is *not* expressed by the policy is the soft delete.
   */
  it('reads the organization of the scope, filtering nothing but the soft delete', async () => {
    const client = recordingClient(row(ORG));

    const found = await withTenant(client.base, { organizationId: ORG, userId: null }, () =>
      repository.findCurrent(),
    );

    expect(client.findArgs).toEqual([{ where: { deletedAt: null } }]);
    expect(found).toEqual({ id: ORG, ...draft });
  });

  it('answers null when the scope has no organization', async () => {
    const client = recordingClient(null);

    await expect(
      withTenant(client.base, { organizationId: ORG, userId: null }, () =>
        repository.findCurrent(),
      ),
    ).resolves.toBeNull();
  });

  it('refuses to read outside a tenant scope', async () => {
    await expect(repository.findCurrent()).rejects.toThrow(/OrganizationRepository\.findCurrent/);
  });
});
