import { describe, expect, it } from 'vitest';

import { PrismaPermissionOverrideRepository } from '@/infrastructure/persistence/prisma/permission-override.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Exceptions through Prisma, with the driver replaced by a recorder.
 *
 * Two decisions are the subject, and both are invisible against a live database:
 *
 *   * the write is an **upsert keyed by the pair**, so «somebody already decided the opposite about
 *     this key» is the previous state to record rather than a conflict to report;
 *   * the list read **keeps expired rows**, unlike the read that assembles permissions. The two
 *     answer different questions, and an exception that silently vanished from an administrator's
 *     screen is one they can neither explain nor remove.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000c1';

interface Recorder {
  readonly calls: { name: string; args: Record<string, unknown> }[];
  readonly base: Parameters<typeof withTenant>[0];
}

const recordingClient = (state: { rows?: unknown[]; row?: unknown } = {}): Recorder => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const record =
    <T>(name: string, result: T) =>
    (args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ name, args });

      return Promise.resolve(result);
    };

  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    userPermissionOverride: {
      findMany: record('findMany', state.rows ?? []),
      findFirst: record('findFirst', state.row ?? null),
      upsert: record('upsert', {}),
      deleteMany: record('deleteMany', { count: 1 }),
    },
  };

  return {
    calls,
    base: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Parameters<typeof withTenant>[0],
  };
};

const inScope = async <T>(
  recorder: Recorder,
  work: (repository: PrismaPermissionOverrideRepository) => Promise<T>,
): Promise<T> =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    work(new PrismaPermissionOverrideRepository()),
  );

const argsOf = (recorder: Recorder, name: string): Record<string, unknown> =>
  (recorder.calls.find((call) => call.name === name)?.args ?? {}) as Record<string, unknown>;

describe('reading exceptions', () => {
  it('lists every exception of one person, expired ones included', async () => {
    const recorder = recordingClient({
      rows: [{ permissionKey: 'task:read', effect: 'DENY', reason: 'on leave now', expiresAt: null }],
    });

    expect(await inScope(recorder, (repository) => repository.listFor('ivan'))).toEqual([
      { permissionKey: 'task:read', effect: 'DENY', reason: 'on leave now', expiresAt: null },
    ]);

    const where = argsOf(recorder, 'findMany')['where'] as Record<string, unknown>;

    expect(where).toEqual({ organizationId: ORG, userId: 'ivan' });
    // No expiry predicate here on purpose: the screen shows an expired exception until it is
    // cleaned, and one that disappeared silently is one nobody can explain or remove.
    expect(where).not.toHaveProperty('OR');
  });

  it('answers the current opinion about a key when there is one', async () => {
    const recorder = recordingClient({
      row: {
        permissionKey: 'invoice:issue',
        effect: 'DENY',
        reason: 'billing handed over',
        expiresAt: null,
      },
    });

    expect(await inScope(recorder, (repository) => repository.find('ivan', 'invoice:issue'))).toEqual(
      {
        permissionKey: 'invoice:issue',
        effect: 'DENY',
        reason: 'billing handed over',
        expiresAt: null,
      },
    );
  });

  it('answers null when there is no opinion about a key', async () => {
    const recorder = recordingClient();

    expect(await inScope(recorder, (repository) => repository.find('ivan', 'task:read'))).toBeNull();
    expect(argsOf(recorder, 'findFirst')['where']).toEqual({
      organizationId: ORG,
      userId: 'ivan',
      permissionKey: 'task:read',
    });
  });
});

describe('writing an exception', () => {
  it('upserts on the pair, and rewrites the grantor and the moment', async () => {
    const recorder = recordingClient();
    const expiresAt = new Date('2027-01-01T00:00:00Z');

    await inScope(recorder, (repository) =>
      repository.upsert({
        userId: 'ivan',
        permissionKey: 'invoice:issue',
        effect: 'DENY',
        reason: 'billing handed over',
        expiresAt,
        grantedById: 'admin',
      }),
    );

    const args = argsOf(recorder, 'upsert');

    expect(args['where']).toEqual({
      userId_permissionKey: { userId: 'ivan', permissionKey: 'invoice:issue' },
    });
    expect(args['create']).toMatchObject({ organizationId: ORG, effect: 'DENY', expiresAt });
    // A changed exception is a new decision by a new person: keeping the first author would make the
    // trail name the wrong one.
    expect(args['update']).toMatchObject({ grantedById: 'admin', reason: 'billing handed over' });
    expect((args['update'] as { grantedAt: Date }).grantedAt).toBeInstanceOf(Date);
  });

  it('reports whether a removal removed anything', async () => {
    const removed = recordingClient();

    expect(await inScope(removed, (repository) => repository.remove('ivan', 'invoice:issue'))).toBe(
      true,
    );
    expect(argsOf(removed, 'deleteMany')['where']).toEqual({
      organizationId: ORG,
      userId: 'ivan',
      permissionKey: 'invoice:issue',
    });
  });
});
