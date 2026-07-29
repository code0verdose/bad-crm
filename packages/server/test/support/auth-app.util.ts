import { type Express } from 'express';

import { AuthenticateSessionQuery } from '@/application/identity/use-cases/authenticate-session.query.js';
import { ChangePasswordUseCase } from '@/application/identity/use-cases/change-password.use-case.js';
import { ConfirmPasswordResetUseCase } from '@/application/identity/use-cases/confirm-password-reset.use-case.js';
import { EndSessionUseCase } from '@/application/identity/use-cases/end-session.use-case.js';
import { IssueSessionUseCase } from '@/application/identity/use-cases/issue-session.use-case.js';
import { ListSessionsQuery } from '@/application/identity/use-cases/list-sessions.query.js';
import { LoginUseCase } from '@/application/identity/use-cases/login.use-case.js';
import { RefreshSessionUseCase } from '@/application/identity/use-cases/refresh-session.use-case.js';
import { RegisterOrganizationUseCase } from '@/application/identity/use-cases/register-organization.use-case.js';
import { RequestPasswordResetUseCase } from '@/application/identity/use-cases/request-password-reset.use-case.js';
import { BootstrapOrganizationUseCase } from '@/application/organization/use-cases/bootstrap-organization.use-case.js';
import { createHttpServer } from '@/presentation/http/http-server.factory.js';

import { createTestApp } from './test-app.util.js';
import {
  FakeAccessTokens,
  FakeAddressHasher,
  FakeAuthLookup,
  FakeClock,
  FakeIdGenerator,
  FakeMail,
  FakeMailDispatcher,
  FakeOrganizations,
  FakePasswordResetTokens,
  FakePasswordHasher,
  FakeRateLimit,
  type FakeRateLimitOptions,
  FakeRefreshTokens,
  FakeResetTokens,
  FakeSessions,
  FakeUnitOfWork,
  FakeUsers,
  authUser,
  RecordingLogger,
} from './identity-doubles.util.js';

/**
 * The real HTTP surface over in-memory ports.
 *
 * The application is the one `createHttpServer` builds — the real middleware chain, the real
 * registry, the real controllers, serializers and cookie attributes — with only the identity ports
 * replaced. That is deliberate: what these suites are about is the *wire* (which header, which
 * status, what is and is not in a body), and a container needs no database to answer that. Whether
 * the statements those ports would send are the right ones is the subject of
 * `test/unit/persistence/**`, and whether PostgreSQL agrees is the subject of
 * `test/integration/db/**`.
 */
export interface AuthApp {
  readonly app: Express;
  readonly clock: FakeClock;
  readonly sessions: FakeSessions;
  readonly users: FakeUsers;
  readonly lookup: FakeAuthLookup;
  readonly hasher: FakePasswordHasher;
  readonly logger: RecordingLogger;
  readonly rateLimit: FakeRateLimit;
  readonly mail: FakeMail;
  readonly dispatcher: FakeMailDispatcher;
  readonly resetTokens: FakeResetTokens;
  /**
   * Every serialized pino line the application produced, in order.
   *
   * The real logger over a memory destination rather than a double, because what these suites have
   * to be able to ask is what the *bytes* of a line contain — which fields the ambient context
   * mixed in, and which values never appear at all.
   */
  readonly logLines: () => string[];
}

export interface AuthAppOptions {
  readonly registrationOpen?: boolean;
  readonly accounts?: ReturnType<typeof authUser>[];
  /** Budgets the attempt counter enforces; absent means every request is admitted. */
  readonly rateLimit?: FakeRateLimitOptions;
  /** Hops of `X-Forwarded-For` the application is configured to believe. */
  readonly trustedProxyHops?: number;
  /** `false` models an installation without `SMTP_URL`; the mail operations then answer 503. */
  readonly mailConfigured?: boolean;
}

/** `APP_URL` of the application these suites build; the reset links are absolute against it. */
export const APP_URL = 'https://crm.example.com';

export const createAuthApp = (options: AuthAppOptions = {}): AuthApp => {
  const clock = new FakeClock();
  const sessions = new FakeSessions(clock);
  const accounts = options.accounts ?? [authUser()];
  const lookup = new FakeAuthLookup(accounts).reading(sessions);
  const organizations = new FakeOrganizations();
  // The accounts the `app_auth` lookup resolves also exist as rows inside the tenant: the refresh
  // path re-reads the account through `UserRepositoryPort` to check it may still hold a session.
  const users = new FakeUsers(
    accounts.map((account) => ({
      id: account.userId,
      email: account.email,
      locale: account.locale,
      timezone: account.timezone,
      status: account.status,
      permissionsVersion: account.permissionsVersion,
    })),
  );
  const hasher = new FakePasswordHasher();
  const unitOfWork = new FakeUnitOfWork();
  const rateLimit = new FakeRateLimit(options.rateLimit ?? {});
  const refreshTokens = new FakeRefreshTokens();
  const logger = new RecordingLogger();
  const mail = new FakeMail();
  const dispatcher = new FakeMailDispatcher();
  const resetTokens = new FakeResetTokens();
  const resetTokenRows = new FakePasswordResetTokens(unitOfWork);

  mail.configured = options.mailConfigured ?? true;

  // The digests the sign-in path verifies against are the same rows `ChangePasswordUseCase` reads
  // and rewrites: a second store here would let a test change a password and still sign in with the
  // old one, which is the assertion that matters most.
  for (const account of accounts) {
    users.credentials.set(account.userId, {
      email: account.email,
      passwordHash: account.passwordHash,
      locale: account.locale,
    });
  }

  // One token service for the whole application: the guard has to verify what the sign-in minted,
  // and two instances would make every authenticated request a 401 for the wrong reason.
  const accessTokens = new FakeAccessTokens();

  lookup.readingCredentials(users).readingResetTokens(resetTokenRows);

  const issueSession = new IssueSessionUseCase(
    sessions,
    organizations,
    refreshTokens,
    accessTokens,
    new FakeAddressHasher(),
    clock,
    new FakeIdGenerator(),
  );

  const bootstrap = new BootstrapOrganizationUseCase(
    unitOfWork,
    organizations,
    users,
    { seedSystemRoles: (): Promise<void> => Promise.resolve() },
    new FakeIdGenerator(),
  );

  const identity = {
    register: new RegisterOrganizationUseCase(
      bootstrap,
      hasher,
      unitOfWork,
      issueSession,
      { locale: 'en', timezone: 'UTC', currency: 'USD' },
      options.registrationOpen ?? true,
      rateLimit,
    ),
    login: new LoginUseCase(lookup, hasher, users, unitOfWork, issueSession, rateLimit, logger),
    refresh: new RefreshSessionUseCase(
      lookup,
      refreshTokens,
      sessions,
      users,
      organizations,
      unitOfWork,
      issueSession,
      clock,
      logger,
      rateLimit,
    ),
    requestPasswordReset: new RequestPasswordResetUseCase(
      lookup,
      resetTokenRows,
      resetTokens,
      new FakeAddressHasher(),
      unitOfWork,
      rateLimit,
      mail,
      dispatcher,
      clock,
      logger,
      APP_URL,
    ),
    confirmPasswordReset: new ConfirmPasswordResetUseCase(
      lookup,
      resetTokenRows,
      resetTokens,
      users,
      sessions,
      hasher,
      unitOfWork,
      rateLimit,
      clock,
      logger,
    ),
    endSession: new EndSessionUseCase(sessions, unitOfWork, clock, logger),
    changePassword: new ChangePasswordUseCase(
      users,
      sessions,
      resetTokenRows,
      hasher,
      unitOfWork,
      rateLimit,
      dispatcher,
      clock,
      logger,
      APP_URL,
    ),
    listSessions: new ListSessionsQuery(sessions, unitOfWork, clock),
    authenticate: new AuthenticateSessionQuery(accessTokens, sessions, unitOfWork, clock),
    authLookup: lookup,
    refreshTokens,
  };

  const testApp = createTestApp(
    options.trustedProxyHops === undefined ? {} : { TRUSTED_PROXY_HOPS: options.trustedProxyHops },
  );

  return {
    app: createHttpServer({ ...testApp.container.http, identity }),
    clock,
    sessions,
    users,
    lookup,
    hasher,
    logger,
    rateLimit,
    mail,
    dispatcher,
    resetTokens,
    logLines: testApp.logLines,
  };
};
