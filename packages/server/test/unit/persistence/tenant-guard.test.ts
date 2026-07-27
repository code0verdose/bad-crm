import { describe, expect, it } from 'vitest';

import {
  GLOBAL_MODELS,
  guardTenantOperation,
  guardedClient,
} from '@/infrastructure/persistence/prisma/tenant-guard.adapter.js';
import {
  MissingTenantContextError,
  withTenant,
  type TxClient,
} from '@/infrastructure/persistence/prisma/tenant.context.js';

const ORG = '018f4a3b-0000-7000-8000-000000000001';

const fakeBase = (): Parameters<typeof withTenant>[0] =>
  ({
    $transaction: async (run: (tx: TxClient) => Promise<unknown>): Promise<unknown> =>
      run({
        $executeRaw: (): Promise<number> => Promise.resolve(1),
      } as unknown as TxClient),
  }) as unknown as Parameters<typeof withTenant>[0];

const operation = (model: string | undefined, args: unknown = { where: {} }) => ({
  model,
  operation: 'findMany',
  args,
  query: (received: unknown): Promise<unknown> => Promise.resolve({ received }),
});

describe('the tenant guard', () => {
  it('refuses a tenant-scoped model outside withTenant', async () => {
    await expect(guardTenantOperation(operation('Team'))).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });

  it('names the model and the operation it blocked', async () => {
    await expect(guardTenantOperation(operation('Team'))).rejects.toThrow(/Team\.findMany/);
  });

  it('lets the query through inside a tenant scope, with its arguments untouched', async () => {
    const args = { where: { slug: 'core' } };

    const result = await withTenant(fakeBase(), { organizationId: ORG, userId: null }, () =>
      guardTenantOperation(operation('Team', args)),
    );

    expect(result).toEqual({ received: args });
  });

  it('lets a global model through without a tenant scope', async () => {
    const [globalModel] = [...GLOBAL_MODELS];

    expect(globalModel).toBeDefined();
    await expect(guardTenantOperation(operation(globalModel))).resolves.toEqual({
      received: { where: {} },
    });
  });

  /**
   * A raw `$queryRaw` arrives with `model === undefined`. It must be blocked, not waved through:
   * the guard cannot tell whether the statement touches a tenant table, and the safe answer to
   * "unknown table, no context" is a refusal (docs/security/rls-design.md, `rawInTenant`).
   */
  it('refuses an operation it cannot attribute to a model', async () => {
    await expect(guardTenantOperation(operation(undefined))).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });
});

describe('guardedClient', () => {
  it('installs the guard as a query extension over every model', () => {
    const extensions: unknown[] = [];
    const base = {
      $extends: (extension: unknown): unknown => {
        extensions.push(extension);

        return { extended: true };
      },
    } as unknown as Parameters<typeof guardedClient>[0];

    const client = guardedClient(base);

    expect(client).toEqual({ extended: true });
    expect(extensions[0]).toMatchObject({
      name: 'tenant-guard',
      query: { $allModels: { $allOperations: guardTenantOperation } },
    });
  });
});
