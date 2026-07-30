import { describe, expect, it } from 'vitest';

import { IssueSessionUseCase } from '@/application/identity/use-cases/issue-session.use-case.js';
import { RegisterOrganizationUseCase } from '@/application/identity/use-cases/register-organization.use-case.js';
import { BootstrapOrganizationUseCase } from '@/application/organization/use-cases/bootstrap-organization.use-case.js';
import { type AppError, ValidationError } from '@/domain/shared/errors/app.errors.js';
import {
  FakeAccessTokens,
  FakeAddressHasher,
  FakeClock,
  FakeIdGenerator,
  FakeOrganizations,
  FakePasswordHasher,
  FakeRateLimit,
  type FakeRateLimitOptions,
  FakeRefreshTokens,
  FakeSessions,
  FakeUnitOfWork,
  FakeUsers,
  USER_ID,
} from '../../support/identity-doubles.util.js';

const CLIENT = { userAgent: 'Firefox/128.0', ipAddress: '203.0.113.42' };

const REQUEST = {
  organization: { name: 'Bad Company', slug: 'bad-company' },
  owner: { email: 'ada@example.com', password: 'correct-horse-battery' },
  client: CLIENT,
};

interface Harness {
  readonly register: RegisterOrganizationUseCase;
  readonly users: FakeUsers;
  readonly organizations: FakeOrganizations;
  readonly sessions: FakeSessions;
  readonly hasher: FakePasswordHasher;
  readonly rateLimit: FakeRateLimit;
  readonly journal: string[];
}

const harness = (
  registrationOpen = true,
  rateLimitOptions: Omit<FakeRateLimitOptions, 'journal'> = {},
): Harness => {
  const clock = new FakeClock();
  const sessions = new FakeSessions(clock);
  const organizations = new FakeOrganizations(null);
  const users = new FakeUsers();
  const journal: string[] = [];
  const hasher = new FakePasswordHasher(journal);
  const unitOfWork = new FakeUnitOfWork();
  const rateLimit = new FakeRateLimit({ ...rateLimitOptions, journal });

  const bootstrap = new BootstrapOrganizationUseCase(
    unitOfWork,
    organizations,
    new FakeIdGenerator(),
  );

  const issue = new IssueSessionUseCase(
    sessions,
    organizations,
    new FakeRefreshTokens(),
    new FakeAccessTokens(),
    new FakeAddressHasher(),
    clock,
    new FakeIdGenerator(),
  );

  return {
    register: new RegisterOrganizationUseCase(
      bootstrap,
      hasher,
      unitOfWork,
      issue,
      { locale: 'en', timezone: 'UTC', currency: 'USD' },
      registrationOpen,
      rateLimit,
    ),
    users,
    organizations,
    sessions,
    hasher,
    rateLimit,
    journal,
  };
};

const refusal = async (run: () => Promise<unknown>): Promise<AppError> => {
  try {
    await run();
  } catch (error) {
    return error as AppError;
  }

  throw new Error('expected the registration to be refused');
};

describe('registering an organization', () => {
  it('creates the organization and the owner, and signs the owner in', async () => {
    const test = harness();

    const result = await test.register.execute(REQUEST);

    expect(test.organizations.createdOwner).toMatchObject({
      email: 'ada@example.com',
      locale: 'en',
      timezone: 'UTC',
    });
    expect(test.sessions.rows.size).toBe(1);
    expect(result.user).toEqual({
      id: USER_ID,
      email: 'ada@example.com',
      locale: 'en',
      timezone: 'UTC',
    });
    expect(result.organization).toMatchObject({ name: 'Bad Company', slug: 'bad-company' });
    expect(result.session.refreshToken).not.toBe('');
  });

  it('stores a digest and never the password', async () => {
    const test = harness();

    await test.register.execute(REQUEST);

    expect(test.organizations.createdOwner?.passwordHash).toBe(
      '$argon2id$hashed:correct-horse-battery',
    );
    expect(JSON.stringify(test.organizations.createdOwner)).not.toContain(
      '"correct-horse-battery"',
    );
  });

  it('takes the locale and timezone from the request when given', async () => {
    const test = harness();

    await test.register.execute({
      ...REQUEST,
      owner: { ...REQUEST.owner, locale: 'ru', timezone: 'Europe/Berlin' },
    });

    expect(test.organizations.createdOwner).toMatchObject({
      locale: 'ru',
      timezone: 'Europe/Berlin',
    });
  });

  describe('when the installation does not accept new organizations', () => {
    it('refuses before anything is read or written', async () => {
      const test = harness(false);

      const error = await refusal(() => test.register.execute(REQUEST));

      expect(error.code).toBe('registration_disabled');
      expect(error.status).toBe(403);
      expect(test.organizations.createdOwner).toBeUndefined();
      expect(test.sessions.rows.size).toBe(0);
      expect(test.hasher.verified).toEqual([]);
    });
  });

  describe('the password policy the schema leaves to the use-case', () => {
    it.each(['qwertyuiop12', 'P@ssw0rd1234', 'aaaaaaaaaaaa'])(
      'refuses %s as a validation failure on the field',
      async (password) => {
        const test = harness();

        const error = await refusal(() =>
          test.register.execute({ ...REQUEST, owner: { ...REQUEST.owner, password } }),
        );

        expect(error).toBeInstanceOf(ValidationError);
        expect(error.status).toBe(422);
        expect((error as ValidationError).issues).toEqual([
          { path: 'owner.password', code: 'custom', message: expect.any(String) },
        ]);
        expect(test.organizations.createdOwner).toBeUndefined();
      },
    );

    it('says nothing about the password in the message it logs', async () => {
      const test = harness();
      const error = await refusal(() =>
        test.register.execute({
          ...REQUEST,
          owner: { ...REQUEST.owner, password: 'qwertyuiop12' }, // scan-secrets:allow gitleaks:allow
        }),
      );

      expect(JSON.stringify((error as ValidationError).issues)).not.toContain('qwertyuiop12');
    });
  });

  /**
   * Three organizations an hour from one address (`docs/architecture/stack.md` → «Rate limiting»,
   * threat model T-TENANT-07). Without it, `POST /auth/register` on an installation that has not
   * yet been closed is an anonymous `CREATE` statement with an argon2id hash attached to each call.
   */
  describe('the registration budget', () => {
    it('spends a point before it hashes the password', async () => {
      const test = harness();

      await test.register.execute(REQUEST);

      expect(test.journal[0]).toBe('rate-limit:consume:organization_registration');
      expect(test.journal.indexOf('rate-limit:consume:organization_registration')).toBeLessThan(
        test.journal.indexOf('password:hash'),
      );
    });

    it('counts the address it came from', async () => {
      const test = harness();

      await test.register.execute(REQUEST);

      expect(test.rateLimit.consumed).toEqual([
        { policy: 'organization_registration', subject: { ipAddress: '203.0.113.42' } },
      ]);
    });

    it('refuses the request over budget with rate_limited, hashing nothing', async () => {
      const test = harness(true, {
        limits: { organization_registration: 0 },
        retryAfterSeconds: 3600,
      });

      const error = await refusal(() => test.register.execute(REQUEST));

      expect(error.code).toBe('rate_limited');
      expect(error.status).toBe(429);
      expect((error as { retryAfterSeconds?: number }).retryAfterSeconds).toBe(3600);
      expect(test.hasher.hashed).toEqual([]);
      expect(test.organizations.createdOwner).toBeUndefined();
    });

    /**
     * A closed installation answers before the budget is touched. The refusal reads nothing, writes
     * nothing and hashes nothing, so spending an attempt on it would let a form left open in a
     * browser tab lock its owner out of the endpoint they are not using anyway.
     */
    it('spends nothing when the installation refuses registrations outright', async () => {
      const test = harness(false);

      await refusal(() => test.register.execute(REQUEST));

      expect(test.rateLimit.consumed).toEqual([]);
    });
  });
});
