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
  ownerId: id,
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

const recordingClient = (
  found: Organization | null = null,
  options: { writesNothing?: boolean } = {},
): Recorder => {
  const createArgs: unknown[] = [];
  const findArgs: unknown[] = [];

  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    // The tenant root is written with raw SQL — one statement for two rows, see the port — so the
    // recorder captures the bound values rather than a Prisma `data` object.
    $queryRaw: (
      _template: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<{ organization_id: string; owner_id: string }[]> => {
      createArgs.push(values);

      if (options.writesNothing === true) return Promise.resolve([]);

      return Promise.resolve([
        { organization_id: values[0] as string, owner_id: values[1] as string },
      ]);
    },
    organization: {
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

const owner = {
  email: 'ada@example.com',
  passwordHash: '$argon2id$digest',
  locale: 'en',
  timezone: 'Europe/Berlin',
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
      repository.createWithOwner(draft, owner),
    );

    // One statement, and the two ids appear in both halves of it. Asserted by position rather than as
    // a flat list, because the property that matters is the *agreement*: the organization id is the
    // one from the scope on both sides, and the owner id generated here is the same in the row that
    // references it and in the row it points at. A statement that bound two different owner ids would
    // insert a user nobody owns and an organization pointing at nobody, and the foreign key would
    // report it as a puzzle about `organizations`.
    expect(client.createArgs).toHaveLength(1);

    const bound = client.createArgs[0] as unknown[];

    expect(bound[0], 'organization id in the organizations half').toBe(ORG);
    expect(bound[7], 'organization id in the users half').toBe(ORG);
    expect(bound[1], 'owner id in the organizations half').toBe(bound[6]);
    expect([bound[2], bound[3], bound[4], bound[5]]).toEqual([
      'Acme',
      'acme',
      'Europe/Berlin',
      'EUR',
    ]);
    expect([bound[8], bound[9], bound[10], bound[11]]).toEqual([
      'ada@example.com',
      '$argon2id$digest',
      'en',
      'Europe/Berlin',
    ]);
    expect(created.organizationId).toBe(ORG);
    expect(created.ownerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  /**
   * `INSERT … RETURNING` produces a row or raises, so an empty result is not a case the database can
   * present — it would mean the write was dropped silently, which `WITH CHECK` does not do. Asserted
   * because the caller's next step opens a session for the id this method returns: a `undefined` read
   * as success would sign somebody into an organization that does not exist.
   */
  it('refuses an empty result rather than reporting an organization that was not written', async () => {
    const client = recordingClient(null, { writesNothing: true });

    await expect(
      withTenant(client.base, { organizationId: ORG, userId: null }, () =>
        repository.createWithOwner(draft, owner),
      ),
    ).rejects.toThrow(/wrote no row/);
  });

  it('refuses to create outside a tenant scope, before any statement is sent', async () => {
    const client = recordingClient();

    await expect(repository.createWithOwner(draft, owner)).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
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
