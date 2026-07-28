import { describe, expect, it } from 'vitest';

import {
  CrossTenantNestingError,
  MissingTenantContextError,
  currentTenant,
  requireTenant,
  withTenant,
  type TxClient,
} from '@/infrastructure/persistence/prisma/tenant.context.js';

const ORG_A = '018f4a3b-0000-7000-8000-000000000001';
const ORG_B = '018f4a3b-0000-7000-8000-000000000002';
const USER = '018f4a3b-0000-7000-8000-00000000000a';

interface RecordedStatement {
  readonly fragments: string[];
  readonly values: unknown[];
}

interface FakeClient {
  readonly statements: RecordedStatement[];
  readonly transactions: unknown[];
  /** Shaped like `PrismaClient` only where `withTenant` touches it. */
  readonly client: Parameters<typeof withTenant>[0];
}

/**
 * A stand-in for `PrismaClient` that records what `withTenant` sends.
 *
 * The point of the fake is the tagged template: `set_config` has to arrive as a bind parameter, and
 * the only way to see that from the outside is to keep the template fragments and the values apart,
 * exactly as the driver receives them. A mock asserting `toHaveBeenCalled` would pass on a string
 * built by concatenation — which is the injection this wrapper exists to avoid.
 */
const fakeClient = (): FakeClient => {
  const statements: RecordedStatement[] = [];
  const transactions: unknown[] = [];

  const tx = {
    $executeRaw: (fragments: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      statements.push({ fragments: [...fragments], values });

      return Promise.resolve(1);
    },
  } as unknown as TxClient;

  const client = {
    $transaction: async (
      run: (tx: TxClient) => Promise<unknown>,
      options: unknown,
    ): Promise<unknown> => {
      transactions.push(options);

      return run(tx);
    },
  } as unknown as Parameters<typeof withTenant>[0];

  return { statements, transactions, client };
};

const sqlOf = (statement: RecordedStatement): string => statement.fragments.join('?');

describe('withTenant', () => {
  it('sets the tenant context inside the transaction, before the callback runs', async () => {
    const fake = fakeClient();
    let seenAtCallbackTime = 0;

    await withTenant(fake.client, { organizationId: ORG_A, userId: USER }, () => {
      seenAtCallbackTime = fake.statements.length;

      return Promise.resolve();
    });

    expect(seenAtCallbackTime).toBe(2);
    expect(sqlOf(fake.statements[0] as RecordedStatement)).toContain(
      "set_config('app.organization_id'",
    );
    expect(sqlOf(fake.statements[1] as RecordedStatement)).toContain("set_config('app.user_id'");
  });

  /**
   * `is_local = true` is the whole reason `set_config` is used instead of `SET`: without it the
   * value outlives the transaction, travels back into the pool and leaks into the next request of
   * a different organization (docs/security/rls-design.md, «Ловушки», 1).
   */
  it('scopes both settings to the transaction with is_local = true', () => {
    const fake = fakeClient();

    return withTenant(fake.client, { organizationId: ORG_A, userId: USER }, () =>
      Promise.resolve(),
    ).then(() => {
      for (const statement of fake.statements) {
        expect(sqlOf(statement)).toMatch(/,\s*true\)/);
      }
    });
  });

  it('passes the organization as a bind parameter, never as interpolated text', async () => {
    const fake = fakeClient();

    await withTenant(fake.client, { organizationId: ORG_A, userId: USER }, () => Promise.resolve());

    expect(fake.statements[0]?.values).toEqual([ORG_A]);
    expect(sqlOf(fake.statements[0] as RecordedStatement)).not.toContain(ORG_A);
  });

  it('sends an empty string for a job that runs without a user', async () => {
    const fake = fakeClient();

    await withTenant(fake.client, { organizationId: ORG_A, userId: null }, () => Promise.resolve());

    expect(fake.statements[1]?.values).toEqual(['']);
  });

  it('rejects an organization id that is not a uuid without opening a transaction', async () => {
    const fake = fakeClient();

    await expect(
      withTenant(fake.client, { organizationId: 'acme', userId: null }, () => Promise.resolve()),
    ).rejects.toThrow();
    expect(fake.transactions).toEqual([]);
  });

  it('rejects a user id that is not a uuid', async () => {
    const fake = fakeClient();

    await expect(
      withTenant(fake.client, { organizationId: ORG_A, userId: 'root' }, () => Promise.resolve()),
    ).rejects.toThrow();
  });

  it('opens the transaction as read committed with the documented timeouts', async () => {
    const fake = fakeClient();

    await withTenant(fake.client, { organizationId: ORG_A, userId: null }, () => Promise.resolve());

    expect(fake.transactions[0]).toMatchObject({
      maxWait: 2_000,
      timeout: 5_000,
      isolationLevel: 'ReadCommitted',
    });
  });

  it('honours caller-supplied transaction options', async () => {
    const fake = fakeClient();

    await withTenant(
      fake.client,
      { organizationId: ORG_A, userId: null },
      () => Promise.resolve(),
      { maxWaitMs: 10, timeoutMs: 20 },
    );

    expect(fake.transactions[0]).toMatchObject({ maxWait: 10, timeout: 20 });
  });

  it('returns what the callback returns', async () => {
    const fake = fakeClient();

    await expect(
      withTenant(fake.client, { organizationId: ORG_A, userId: null }, () =>
        Promise.resolve('done'),
      ),
    ).resolves.toBe('done');
  });

  it('reuses the open transaction when nested with the same organization', async () => {
    const fake = fakeClient();

    await withTenant(fake.client, { organizationId: ORG_A, userId: USER }, async (outerTx) => {
      await withTenant(fake.client, { organizationId: ORG_A, userId: USER }, (innerTx) => {
        expect(innerTx).toBe(outerTx);

        return Promise.resolve();
      });
    });

    expect(fake.transactions).toHaveLength(1);
    expect(fake.statements).toHaveLength(2);
  });

  it('refuses to switch tenant inside an open transaction', async () => {
    const fake = fakeClient();

    await expect(
      withTenant(fake.client, { organizationId: ORG_A, userId: USER }, () =>
        withTenant(fake.client, { organizationId: ORG_B, userId: USER }, () => Promise.resolve()),
      ),
    ).rejects.toBeInstanceOf(CrossTenantNestingError);
  });

  it('names both organizations in the nesting error, so the bug is diagnosable', async () => {
    const fake = fakeClient();
    const error = await withTenant(fake.client, { organizationId: ORG_A, userId: null }, () =>
      withTenant(fake.client, { organizationId: ORG_B, userId: null }, () =>
        Promise.resolve(),
      ).catch((caught: unknown) => caught),
    );

    expect((error as Error).message).toContain(ORG_A);
    expect((error as Error).message).toContain(ORG_B);
  });

  it('leaves no context behind once the transaction is over', async () => {
    const fake = fakeClient();

    await withTenant(fake.client, { organizationId: ORG_A, userId: null }, () => Promise.resolve());

    expect(currentTenant()).toBeUndefined();
  });

  /**
   * Two requests of two organizations, interleaved on purpose.
   *
   * This is the property `AsyncLocalStorage` is used *for*, and the one a module-level variable
   * would get wrong — silently, only under concurrency, never on a laptop. The delay is what makes
   * the test an observation rather than a restatement: without it the first scope closes before the
   * second opens and any implementation passes, including a single shared variable. Here A yields
   * in the middle of its scope, B runs a whole scope inside that gap, and A has to come back to its
   * own organization.
   */
  it('keeps the contexts of two concurrent scopes apart', async () => {
    const fake = fakeClient();
    const seen: string[] = [];

    const slowA = withTenant(fake.client, { organizationId: ORG_A, userId: null }, async () => {
      seen.push(`A:${currentTenant()?.ctx.organizationId ?? 'none'}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.push(`A:${currentTenant()?.ctx.organizationId ?? 'none'}`);
    });

    const fastB = withTenant(fake.client, { organizationId: ORG_B, userId: null }, () => {
      seen.push(`B:${currentTenant()?.ctx.organizationId ?? 'none'}`);

      return Promise.resolve();
    });

    await Promise.all([slowA, fastB]);

    expect(seen).toEqual([`A:${ORG_A}`, `B:${ORG_B}`, `A:${ORG_A}`]);
  });

  it('leaves no context behind when the callback throws', async () => {
    const fake = fakeClient();

    await expect(
      withTenant(fake.client, { organizationId: ORG_A, userId: null }, () =>
        Promise.reject(new Error('boom')),
      ),
    ).rejects.toThrow('boom');
    expect(currentTenant()).toBeUndefined();
  });
});

describe('requireTenant', () => {
  it('fails outside a tenant scope and names the call site', () => {
    expect(() => requireTenant('team.findMany')).toThrow(MissingTenantContextError);
    expect(() => requireTenant('team.findMany')).toThrow(/team\.findMany/);
  });

  it('returns the running context and its transaction inside the scope', async () => {
    const fake = fakeClient();

    await withTenant(fake.client, { organizationId: ORG_A, userId: USER }, (tx) => {
      const store = requireTenant('team.findMany');

      expect(store.ctx).toEqual({ organizationId: ORG_A, userId: USER });
      expect(store.tx).toBe(tx);

      return Promise.resolve();
    });
  });
});

describe('currentTenant', () => {
  it('is undefined outside a tenant scope', () => {
    expect(currentTenant()).toBeUndefined();
  });

  it('carries the organization inside the scope', async () => {
    const fake = fakeClient();

    await withTenant(fake.client, { organizationId: ORG_A, userId: null }, () => {
      expect(currentTenant()?.ctx.organizationId).toBe(ORG_A);

      return Promise.resolve();
    });
  });
});
