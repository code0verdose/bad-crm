import { describe, expect, it } from 'vitest';

import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma/unit-of-work.adapter.js';
import {
  currentTenant,
  type TxClient,
  type withTenant,
} from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * `UnitOfWorkPort` over `withTenant`, and the two properties that make the port safe to hand to the
 * application layer.
 */

const ORG = '018f4a3b-0000-7000-8000-000000000001';
const USER = '018f4a3b-0000-7000-8000-00000000000a';

interface Fake {
  readonly statements: string[];
  readonly base: Parameters<typeof withTenant>[0];
}

const fakeBase = (): Fake => {
  const statements: string[] = [];

  return {
    statements,
    base: {
      $transaction: async (run: (tx: TxClient) => Promise<unknown>): Promise<unknown> =>
        run({
          $executeRaw: (fragments: TemplateStringsArray): Promise<number> => {
            statements.push(fragments.join('?'));

            return Promise.resolve(1);
          },
        } as unknown as TxClient),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

describe('PrismaUnitOfWork', () => {
  it('opens a transaction with the tenant pinned to it and returns the result', async () => {
    const fake = fakeBase();

    await expect(
      new PrismaUnitOfWork(fake.base as never).withTenant(
        { organizationId: ORG, userId: USER },
        () => Promise.resolve('done'),
      ),
    ).resolves.toBe('done');
    expect(fake.statements.join('\n')).toContain("set_config('app.organization_id'");
  });

  it('runs the work inside the scope, so repositories find the transaction', async () => {
    const fake = fakeBase();
    let seen: string | undefined;

    await new PrismaUnitOfWork(fake.base as never).withTenant(
      { organizationId: ORG, userId: null },
      () => {
        seen = currentTenant()?.ctx.organizationId;

        return Promise.resolve();
      },
    );

    expect(seen).toBe(ORG);
  });

  /**
   * The work function receives nothing. A `TxClient` handed to `application` would be a database
   * handle in a layer that must not hold one — and one that keeps working after the scope closed,
   * which is how a query escapes its own transaction (rules/hexagonal-backend.mdc, rule 3).
   */
  it('calls the work function with no arguments at all', async () => {
    const fake = fakeBase();
    const received: unknown[][] = [];

    await new PrismaUnitOfWork(fake.base as never).withTenant(
      { organizationId: ORG, userId: null },
      (...args: unknown[]) => {
        received.push(args);

        return Promise.resolve();
      },
    );

    expect(received).toEqual([[]]);
  });
});
