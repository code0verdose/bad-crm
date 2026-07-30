import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { ConflictError, NotFoundError } from '@/domain/shared/errors/app.errors.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';
import {
  MissingTenantContextError,
  withTenant,
  type TxClient,
} from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * The base every repository extends, and the reason it exists.
 *
 * A repository that takes the transaction — or worse, the `organizationId` — as an argument has two
 * sources of truth for "which tenant is this", and the second one is a parameter a caller can get
 * wrong. Here there is one: the scope opened by `withTenant`, read out of AsyncLocalStorage. A
 * subclass has no way to reach the database except through `run`, so "forgot the tenant context" is
 * not a mistake that can be made — it is a refusal, thrown before a connection is taken.
 */

const ORG_A = '018f4a3b-0000-7000-8000-000000000001';
const ORG_B = '018f4a3b-0000-7000-8000-000000000002';

const fakeBase = (): Parameters<typeof withTenant>[0] =>
  ({
    $transaction: async (run: (tx: TxClient) => Promise<unknown>): Promise<unknown> =>
      run({
        $executeRaw: (): Promise<number> => Promise.resolve(1),
        marker: 'the transaction from the scope',
      } as unknown as TxClient),
  }) as unknown as Parameters<typeof withTenant>[0];

const prismaError = (code: string, meta?: unknown): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`prisma failed with ${code}`, {
    code,
    clientVersion: 'test',
    ...(meta === undefined ? {} : { meta: meta as Record<string, unknown> }),
  });

class TeamRepositoryProbe extends TenantScopedRepository {
  protected readonly resource = 'team' as const;
  protected readonly repositoryName = 'TeamRepository';

  seenTransaction(): Promise<TxClient> {
    return this.run('seenTransaction', (tx) => Promise.resolve(tx));
  }

  seenOrganization(): Promise<string> {
    return this.run('seenOrganization', () => Promise.resolve(this.organizationId()));
  }

  failWith(error: unknown): Promise<never> {
    return this.run('failWith', () => Promise.reject(error));
  }
}

const repository = new TeamRepositoryProbe();

describe('TenantScopedRepository', () => {
  it('refuses a query made outside withTenant, naming the repository and the operation', async () => {
    const failure = await repository.seenTransaction().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MissingTenantContextError);
    expect((failure as Error).message).toContain('TeamRepository.seenTransaction');
  });

  it('CONTROL: works inside withTenant, on the transaction the scope opened', async () => {
    const tx = await withTenant(fakeBase(), { organizationId: ORG_A, userId: null }, () =>
      repository.seenTransaction(),
    );

    expect(tx).toMatchObject({ marker: 'the transaction from the scope' });
  });

  /**
   * The organization comes from the scope, never from a parameter. A repository method that
   * accepted an `organizationId` would let a caller pass one that disagrees with the transaction's
   * `app.organization_id` — the query would then be filtered by the policy and silently return
   * nothing, which reads as "no data" rather than as the bug it is.
   */
  it('reads the organization out of the scope rather than out of an argument', async () => {
    const seen = await withTenant(fakeBase(), { organizationId: ORG_B, userId: null }, () =>
      repository.seenOrganization(),
    );

    expect(seen).toBe(ORG_B);
  });

  it('turns a unique-constraint violation into the conflict of its own resource', async () => {
    const failure = await withTenant(fakeBase(), { organizationId: ORG_A, userId: null }, () =>
      repository.failWith(prismaError('P2002')).catch((error: unknown) => error),
    );

    expect(failure).toBeInstanceOf(ConflictError);
    expect((failure as ConflictError).code).toBe('team_already_exists');
    expect((failure as ConflictError).status).toBe(409);
  });

  /**
   * The same collision through a raw statement, which is how the tenant root is written: one statement
   * for two rows, because `organizations.owner_id` references a user that references it back.
   *
   * `$queryRaw` never yields `P2002`. Prisma reports `P2010` — "raw query failed" — and puts the
   * PostgreSQL SQLSTATE in `meta.code`, so without this translation a duplicate slug would answer 500
   * and tell the caller to retry something that can never succeed.
   */
  it('turns a raw unique violation into the same conflict', async () => {
    const failure = await withTenant(fakeBase(), { organizationId: ORG_A, userId: null }, () =>
      repository.failWith(prismaError('P2010', { code: '23505' })).catch((error: unknown) => error),
    );

    expect(failure).toBeInstanceOf(ConflictError);
    expect((failure as ConflictError).code).toBe('team_already_exists');
  });

  /**
   * And only that SQLSTATE. A raw statement that violates a foreign key or a check is a defect in this
   * repository, not something a caller can act on: it stays a 500 with the code in the log. The last
   * case is the shape guard — `meta` is typed `unknown`, and a Prisma upgrade that changes it must
   * leave the error loud rather than throw inside the error handler.
   */
  it.each([
    ['a different SQLSTATE', { code: '23503' }],
    ['a meta with no code', { detail: 'something else' }],
    ['a meta that is not an object', 'raw-string-meta'],
    ['no meta at all', undefined],
  ])('leaves a raw failure with %s untranslated', async (_case, meta) => {
    const failure = await withTenant(fakeBase(), { organizationId: ORG_A, userId: null }, () =>
      repository.failWith(prismaError('P2010', meta)).catch((error: unknown) => error),
    );

    expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('turns a missing record into the not-found of its own resource', async () => {
    const failure = await withTenant(fakeBase(), { organizationId: ORG_A, userId: null }, () =>
      repository.failWith(prismaError('P2025')).catch((error: unknown) => error),
    );

    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as NotFoundError).code).toBe('team_not_found');
  });

  /**
   * A row-level-security refusal is **not** translated. `new row violates row-level security
   * policy` means the code tried to write into another organization: that is a defect in the
   * application, and answering it with a tidy 409 would hide it behind a message a client can act
   * on. It travels up untouched and is answered `500 internal_error`.
   */
  it('lets every other failure through unchanged, row level security included', async () => {
    const rlsViolation = prismaError('P2010');

    const failure = await withTenant(fakeBase(), { organizationId: ORG_A, userId: null }, () =>
      repository.failWith(rlsViolation).catch((error: unknown) => error),
    );

    expect(failure).toBe(rlsViolation);
  });

  it('lets a plain error through, so the mapping cannot swallow a bug', async () => {
    const boom = new Error('boom');

    const failure = await withTenant(fakeBase(), { organizationId: ORG_A, userId: null }, () =>
      repository.failWith(boom).catch((error: unknown) => error),
    );

    expect(failure).toBe(boom);
  });
});
