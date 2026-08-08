import { describe, expect, it } from 'vitest';

import { PrismaEmployeeProfileRepository } from '@/infrastructure/persistence/prisma/employee-profile.repository.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

/**
 * Personnel records through Prisma, with the driver replaced by a recorder.
 *
 * The decisions worth pinning are the ones a live database would agree with just as happily if they
 * were wrong:
 *
 *   * **an account with no profile row is an empty profile, not «not found».** 404 on this endpoint
 *     means «no such person here», which is what tenancy rests on — and somebody who accepted an
 *     invitation this morning has no row yet;
 *   * **the account is checked before the write**, so a person of another organization is answered
 *     rather than turned into a foreign-key violation;
 *   * **the emergency contact is ciphertext on both sides of this class**: it is never decrypted
 *     here, so no read of the table can put a plaintext anywhere by accident.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000e1';
const USER = '018f4a3b-0000-7000-8000-0000000000e2';

interface Recorder {
  readonly calls: { name: string; args: Record<string, unknown> }[];
  readonly base: Parameters<typeof withTenant>[0];
}

const storedProfile = {
  userId: USER,
  firstName: 'Ivan',
  lastName: 'Petrov',
  jobTitle: 'Backend engineer',
  department: null,
  managerId: null,
  weeklyCapacityHours: 40,
  employmentType: 'FULL_TIME',
  hiredAt: new Date('2024-03-01T00:00:00.000Z'),
  terminatedAt: null,
  timezone: 'UTC',
  skills: ['ts'],
  emergencyContactEnc: 'v1:iv:tag:ct',
};

const recordingClient = (
  state: {
    account?: { email: string; employeeProfile: typeof storedProfile | null } | null;
    upserted?: typeof storedProfile;
    links?: { userId: string; managerId: string | null }[];
  } = {},
): Recorder => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const record =
    <T>(name: string, result: T) =>
    (args: Record<string, unknown> = {}): Promise<T> => {
      calls.push({ name, args });

      return Promise.resolve(result);
    };

  const tx = {
    $executeRaw: (): Promise<number> => Promise.resolve(1),
    user: { findFirst: record('user.findFirst', state.account ?? null) },
    employeeProfile: {
      upsert: record('upsert', {
        ...(state.upserted ?? storedProfile),
        user: { email: 'ivan@example.test' },
      }),
      findMany: record('findMany', state.links ?? []),
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
  work: (repository: PrismaEmployeeProfileRepository) => Promise<T>,
): Promise<T> =>
  withTenant(recorder.base, { organizationId: ORG, userId: null }, () =>
    work(new PrismaEmployeeProfileRepository()),
  );

const argsOf = (recorder: Recorder, name: string): Record<string, unknown> =>
  (recorder.calls.find((call) => call.name === name)?.args ?? {}) as Record<string, unknown>;

describe('reading a profile', () => {
  it('answers an empty profile for an account nobody has filled in yet', async () => {
    const recorder = recordingClient({
      account: { email: 'ivan@example.test', employeeProfile: null },
    });

    const profile = await inScope(recorder, (repository) => repository.byUserId(USER));

    expect(profile).toMatchObject({ userId: USER, email: 'ivan@example.test', firstName: '' });
    // Nothing was written to produce it: the row appears when somebody actually edits something.
    expect(recorder.calls.map((call) => call.name)).toEqual(['user.findFirst']);
  });

  it('answers null when the account is not in this organization', async () => {
    const recorder = recordingClient({ account: null });

    expect(await inScope(recorder, (repository) => repository.byUserId(USER))).toBeNull();
    expect(argsOf(recorder, 'user.findFirst')['where']).toEqual({
      organizationId: ORG,
      id: USER,
      deletedAt: null,
    });
  });

  it('hands the ciphertext on without decrypting it', async () => {
    const recorder = recordingClient({
      account: { email: 'ivan@example.test', employeeProfile: storedProfile },
    });

    const profile = await inScope(recorder, (repository) => repository.byUserId(USER));

    expect(profile?.emergencyContactEnc).toBe('v1:iv:tag:ct');
  });
});

describe('writing a profile', () => {
  it('refuses before the foreign key does, for a person of another organization', async () => {
    const recorder = recordingClient({ account: null });

    expect(
      await inScope(recorder, (repository) => repository.upsert(USER, { jobTitle: 'Engineer' })),
    ).toBeNull();
    // No write was attempted: answering here is what lets the caller say 404 rather than translate
    // a constraint violation.
    expect(recorder.calls.map((call) => call.name)).toEqual(['user.findFirst']);
  });

  it('creates with a name even when the patch carried none', async () => {
    // A profile created by an edit that only set a job title still needs a name, and an empty string
    // is the honest «not filled in yet» rather than a guess at what the person is called.
    const recorder = recordingClient({
      account: { email: 'ivan@example.test', employeeProfile: null },
    });

    await inScope(recorder, (repository) => repository.upsert(USER, { jobTitle: 'Engineer' }));

    const args = argsOf(recorder, 'upsert') as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      where: unknown;
    };

    expect(args.create).toMatchObject({ firstName: '', lastName: '', jobTitle: 'Engineer' });
    // Only the key the patch carried: `create` would otherwise overwrite a column default with
    // nothing, and the two halves of the upsert would disagree about what «absent» means. A caller
    // cannot pass an explicit `undefined` — `exactOptionalPropertyTypes` refuses it — so the filter
    // is asserted through what it lets through rather than through what it drops.
    expect(args.update).toEqual({ jobTitle: 'Engineer' });
    expect(args.where).toEqual({ organizationId_userId: { organizationId: ORG, userId: USER } });
  });

  it('copies the skills array, which arrives readonly', async () => {
    const recorder = recordingClient({
      account: { email: 'ivan@example.test', employeeProfile: null },
    });

    await inScope(recorder, (repository) => repository.upsert(USER, { skills: ['ts', 'sql'] }));

    expect((argsOf(recorder, 'upsert') as { update: { skills: string[] } }).update.skills).toEqual([
      'ts',
      'sql',
    ]);
  });
});

describe('the org chart', () => {
  it('reads the links of this organization and drops the people who report to nobody', async () => {
    const recorder = recordingClient({
      links: [
        { userId: 'a', managerId: 'b' },
        { userId: 'c', managerId: null },
      ],
    });

    const links = await inScope(recorder, (repository) => repository.managerLinks());

    expect([...links]).toEqual([['a', 'b']]);
    expect(argsOf(recorder, 'findMany')['where']).toEqual({
      organizationId: ORG,
      managerId: { not: null },
    });
  });
});
