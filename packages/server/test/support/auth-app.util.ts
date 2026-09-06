import { createServer, type Server } from 'node:http';

import { type Express } from 'express';
import { afterEach } from 'vitest';

import { AuthenticateSessionQuery } from '@/application/identity/use-cases/authenticate-session.query.js';
import { ChangePasswordUseCase } from '@/application/identity/use-cases/change-password.use-case.js';
import { ConfirmPasswordResetUseCase } from '@/application/identity/use-cases/confirm-password-reset.use-case.js';
import { ConfirmTotpUseCase } from '@/application/identity/use-cases/confirm-totp.use-case.js';
import { DisableTotpUseCase } from '@/application/identity/use-cases/disable-totp.use-case.js';
import { EndSessionUseCase } from '@/application/identity/use-cases/end-session.use-case.js';
import { GenerateRecoveryCodesUseCase } from '@/application/identity/use-cases/generate-recovery-codes.use-case.js';
import { MfaPolicyQuery } from '@/application/organization/use-cases/mfa-policy.query.js';
import { MfaCoverageReportQuery } from '@/application/organization/use-cases/mfa-coverage-report.query.js';
import { ReadSecurityPolicyQuery } from '@/application/organization/use-cases/read-security-policy.query.js';
import { UpdateSecurityPolicyUseCase } from '@/application/organization/use-cases/update-security-policy.use-case.js';
import { IssueSessionUseCase } from '@/application/identity/use-cases/issue-session.use-case.js';
import { ListSessionsQuery } from '@/application/identity/use-cases/list-sessions.query.js';
import { LoginUseCase } from '@/application/identity/use-cases/login.use-case.js';
import { ReadRecoveryCodeStatusQuery } from '@/application/identity/use-cases/read-recovery-code-status.query.js';
import { RecoveryCodeMatcher } from '@/application/identity/use-cases/recovery-code-matcher.use-case.js';
import { RefreshSessionUseCase } from '@/application/identity/use-cases/refresh-session.use-case.js';
import { RegenerateRecoveryCodesUseCase } from '@/application/identity/use-cases/regenerate-recovery-codes.use-case.js';
import { RegisterOrganizationUseCase } from '@/application/identity/use-cases/register-organization.use-case.js';
import { RequestPasswordResetUseCase } from '@/application/identity/use-cases/request-password-reset.use-case.js';
import { SetupTotpUseCase } from '@/application/identity/use-cases/setup-totp.use-case.js';
import { AssignRoleUseCase } from '@/application/iam/use-cases/assign-role.use-case.js';
import { BuildActorQuery } from '@/application/iam/use-cases/build-actor.query.js';
import { GetMyPermissionsQuery } from '@/application/iam/use-cases/get-my-permissions.query.js';
import { GetUserPermissionsQuery } from '@/application/iam/use-cases/get-user-permissions.query.js';
import { ProvisionSystemRolesUseCase } from '@/application/iam/use-cases/provision-system-roles.use-case.js';
import { DeleteCustomRoleUseCase } from '@/application/iam/use-cases/delete-custom-role.use-case.js';
import { type IamDependencies } from '@/presentation/http/http-server.types.js';
import { AcceptInvitationUseCase } from '@/application/iam/use-cases/accept-invitation.use-case.js';
import { DeactivateUserUseCase } from '@/application/iam/use-cases/deactivate-user.use-case.js';
import { ResetUserMfaUseCase } from '@/application/iam/use-cases/reset-user-mfa.use-case.js';
import { TransferOwnershipUseCase } from '@/application/iam/use-cases/transfer-ownership.use-case.js';
import { ReactivateUserUseCase } from '@/application/iam/use-cases/reactivate-user.use-case.js';
import { GetOrgChartQuery } from '@/application/iam/use-cases/get-org-chart.query.js';
import { ListEmployeesQuery } from '@/application/iam/use-cases/list-employees.query.js';
import {
  ReadEmployeeProfileQuery,
  WriteEmployeeProfileUseCase,
} from '@/application/iam/use-cases/write-employee-profile.use-case.js';
import { AesFieldEncryption } from '@/infrastructure/crypto/field-encryption.adapter.js';
import { CsprngRecoveryCodeGenerator } from '@/infrastructure/crypto/csprng-recovery-code-generator.adapter.js';
import { OtplibTotpAdapter } from '@/infrastructure/crypto/otplib-totp.adapter.js';
import { QrcodeSvgAdapter } from '@/infrastructure/qr/qrcode-svg.adapter.js';
import { noopMetrics } from '@/infrastructure/metrics/noop-metrics.adapter.js';
import { ListInvitationsQuery } from '@/application/iam/use-cases/list-invitations.query.js';
import { ListRolesQuery } from '@/application/iam/use-cases/list-roles.query.js';
import { ListTeamsQuery } from '@/application/iam/use-cases/list-teams.query.js';
import { GetTeamDetailQuery } from '@/application/iam/use-cases/get-team-detail.query.js';
import { DeleteTeamUseCase } from '@/application/iam/use-cases/delete-team.use-case.js';
import {
  AddTeamMemberUseCase,
  RemoveTeamMemberUseCase,
} from '@/application/iam/use-cases/manage-team-members.use-case.js';
import {
  CreateTeamUseCase,
  UpdateTeamUseCase,
} from '@/application/iam/use-cases/write-team.use-case.js';
import {
  CreateInvitationUseCase,
  ResendInvitationUseCase,
  RevokeInvitationUseCase,
} from '@/application/iam/use-cases/write-invitation.use-case.js';
import {
  ApplyRoleChangesUseCase,
  PreviewRoleChangesQuery,
} from '@/application/iam/use-cases/write-role-changes.use-case.js';
import {
  CreateCustomRoleUseCase,
  UpdateCustomRoleUseCase,
} from '@/application/iam/use-cases/write-custom-role.use-case.js';
import { RemovePermissionOverrideUseCase } from '@/application/iam/use-cases/remove-permission-override.use-case.js';
import { RevokeRoleUseCase } from '@/application/iam/use-cases/revoke-role.use-case.js';
import { WritePermissionOverrideUseCase } from '@/application/iam/use-cases/write-permission-override.use-case.js';
import { BootstrapOrganizationUseCase } from '@/application/organization/use-cases/bootstrap-organization.use-case.js';
import { createHttpServer } from '@/presentation/http/http-server.factory.js';

import { createTestPlatform } from './test-app.util.js';
import {
  FakeAccessTokens,
  FakeAddressHasher,
  FakeMfaPolicyReader,
  FakeAuthLookup,
  FakeClock,
  FakeIdGenerator,
  FakeMail,
  FakeMailDispatcher,
  FakeOrganizations,
  FakePasswordResetTokens,
  FakePasswordHasher,
  FakeAuditLogger,
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
import { FakeRecoveryCodes, FakeTotpEnrollment } from './mfa-doubles.util.js';
import { type TokenDenylistPort } from '@/application/identity/ports/token-denylist.port.js';
import { JwtMfaPendingTokenAdapter } from '@/infrastructure/crypto/jwt-mfa-pending-token.adapter.js';
import { VerifySecondFactorUseCase } from '@/application/identity/use-cases/verify-second-factor.use-case.js';
import { ConsumeRecoveryCodeUseCase } from '@/application/identity/use-cases/consume-recovery-code.use-case.js';
import {
  FakeCustomRoleRepository,
  FakeEmployeeDirectoryRepository,
  FakeOwnershipRepository,
  FakeUserLifecycleRepository,
  FakeEmployeeProfileRepository,
  FakeInvitationRepository,
  FakeEffectivePermissionsReader,
  FakePermissionOverrideRepository,
  FakeRoleRepository,
  FakeTeamRepository,
  FakeUserRoleRepository,
} from './iam-doubles.util.js';

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
  /** The account lifecycle, so a test can seed a subject and read back what a suspension removed. */
  readonly userLifecycle: FakeUserLifecycleRepository;
  /** Ownership, so a test can seed a recipient and read back what a transfer was asked to do. */
  readonly ownership: FakeOwnershipRepository;
  readonly users: FakeUsers;
  /** TOTP enrolment, so a suite can seed a colleague's 2FA state without a full setup/confirm flow. */
  readonly enrollment: FakeTotpEnrollment;
  /** Recovery codes, so a suite can seed a batch and read back what a reset or disable removed. */
  readonly recoveryCodeRows: FakeRecoveryCodes;
  readonly organizations: FakeOrganizations;
  /** Seeded by a suite that wants the organization's second-factor policy to cover somebody. */
  readonly mfaPolicyReader: FakeMfaPolicyReader;
  readonly lookup: FakeAuthLookup;
  readonly hasher: FakePasswordHasher;
  readonly logger: RecordingLogger;
  readonly rateLimit: FakeRateLimit;
  readonly mail: FakeMail;
  readonly dispatcher: FakeMailDispatcher;
  readonly resetTokens: FakeResetTokens;
  readonly userRoles: FakeUserRoleRepository;
  readonly overrides: FakePermissionOverrideRepository;
  readonly customRoles: FakeCustomRoleRepository;
  /** Teams, so a suite can seed one and read back what a membership change did. */
  readonly teams: FakeTeamRepository;
  readonly invitations: FakeInvitationRepository;
  readonly employeeProfiles: FakeEmployeeProfileRepository;
  /** The assembled IAM use-cases, for the few cases that assert on one directly. */
  readonly iam: IamDependencies;
  /** Every privileged action the application filed, in order — the trail as a test can read it. */
  readonly audit: FakeAuditLogger;
  /**
   * Every serialized pino line the application produced, in order.
   *
   * The real logger over a memory destination rather than a double, because what these suites have
   * to be able to ask is what the *bytes* of a line contain — which fields the ambient context
   * mixed in, and which values never appear at all.
   */
  readonly logLines: () => string[];
  /**
   * A `Server` for this app, already listening — call it instead of handing `app` itself to
   * `request()` when a test makes more than one HTTP call.
   *
   * `supertest` wraps a bare Express app in a brand-new `http.Server` and binds it to a fresh
   * ephemeral port on **every single call** (`request(test.app).post(...)`, then
   * `request(test.app).delete(...)`, and so on) — it only reuses an existing server when the object
   * passed in is already listening (`Test#serverAddress` skips `.listen()` once `app.address()` is
   * truthy). A suite that signs in and then acts — most of them — was paying for a fresh
   * listen/close cycle per request: a `describe` block of a few `it`s easily opens and tears down a
   * hundred loopback listeners. Sequentially that is merely wasteful; under load (another package
   * building, a busy CI runner) it is flaky — some of those cycles land close enough together that a
   * request gets **`Error: socket hang up`** on a socket the previous cycle had not finished
   * releasing, on a different, unrelated test each time. `test/setup/http-agent.setup.ts` already
   * fixed the sibling failure mode this same churn causes (a reused *client*-side keep-alive socket
   * outliving the server it pointed at); this is the other half — the churn of *server* binds itself.
   *
   * Memoized per `AuthApp`, so every call in one test reuses the same listener; closed by the
   * `afterEach` below, so the next test starts from zero rather than accumulating open sockets over
   * the file.
   */
  readonly server: () => Server;
}

/**
 * How to retire every listener `AuthApp#server()` opened for the test that is currently running.
 *
 * Closers rather than servers, because closing one is only half the job: the `AuthApp` that opened
 * it still holds it memoized, and an `AuthApp` can outlive the test that first asked (`beforeAll`).
 * Clearing the memo is what the owner alone can do, so the owner registers how — otherwise the
 * second test is handed a closed listener and the next call fails on a port nothing is bound to.
 */
const openServers = new Set<() => void>();

afterEach(() => {
  for (const retire of openServers) retire();
  openServers.clear();
});

export interface AuthAppOptions {
  readonly registrationOpen?: boolean;
  readonly accounts?: ReturnType<typeof authUser>[];
  /** Budgets the attempt counter enforces; absent means every request is admitted. */
  readonly rateLimit?: FakeRateLimitOptions;
  /** Hops of `X-Forwarded-For` the application is configured to believe. */
  readonly trustedProxyHops?: number;
  /** `false` models an installation without `SMTP_URL`; the mail operations then answer 503. */
  readonly mailConfigured?: boolean;
  /**
   * What the permission guard finds out about the caller.
   *
   * Absent means «no roles at all», which is what a fresh account looks like and what makes every
   * guarded route answer 403 — the honest default for a suite about authentication, where nobody has
   * been given anything.
   */
  readonly capabilities?: ConstructorParameters<typeof FakeEffectivePermissionsReader>[0];
  /** State the assignment commands act on. */
  readonly userRoles?: FakeUserRoleRepository;
  /** State the override commands act on. */
  readonly overrides?: FakePermissionOverrideRepository;
  /** State the custom-role commands act on. */
  readonly customRoles?: FakeCustomRoleRepository;
  /** State the team commands act on. */
  readonly teams?: FakeTeamRepository;
  readonly invitations?: FakeInvitationRepository;
  readonly employeeProfiles?: FakeEmployeeProfileRepository;
  readonly employeeDirectory?: FakeEmployeeDirectoryRepository;
  readonly userLifecycle?: FakeUserLifecycleRepository;
  readonly ownership?: FakeOwnershipRepository;
  /**
   * What the reader answers about specific people, by id — the subject of an override, whose
   * ownership is the fact the `owner_immutable` rule turns on. Anybody not named here gets
   * `capabilities`.
   */
  readonly capabilitiesByUser?: ConstructorParameters<typeof FakeEffectivePermissionsReader>[1];
  /** Which role or exception each permission of a subject came from — for the explain screen. */
  readonly attributionByUser?: ConstructorParameters<typeof FakeEffectivePermissionsReader>[2];
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
  const audit = new FakeAuditLogger();
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

  // Declared before `issueSession`, which reads it to decide whether the token it mints is scoped to
  // enrolment (STORY-013-05, acceptance 3).
  const totpEnrollment = new FakeTotpEnrollment();

  // The organization's second-factor policy. Empty by default — no grants recorded, so every
  // session this harness issues is an ordinary one, which is the state of an installation that has
  // not switched the policy on. A suite that wants the enrolment gate seeds `mfaPolicyReader`.
  const mfaPolicyReader = new FakeMfaPolicyReader();
  const mfaPolicy = new MfaPolicyQuery(organizations, mfaPolicyReader, clock, logger);

  const issueSession = new IssueSessionUseCase(
    sessions,
    organizations,
    refreshTokens,
    accessTokens,
    new FakeAddressHasher(),
    clock,
    new FakeIdGenerator(),
    totpEnrollment,
    mfaPolicy,
  );

  const bootstrap = new BootstrapOrganizationUseCase(
    unitOfWork,
    organizations,
    new FakeIdGenerator(),
    new ProvisionSystemRolesUseCase(new FakeRoleRepository(), audit),
  );

  // The 2FA surface (STORY-013-01, STORY-013-02). Real crypto adapters rather than scripted doubles
  // where the real ones are cheap and stateless (`OtplibTotpAdapter`, `QrcodeSvgAdapter`,
  // `CsprngRecoveryCodeGenerator` over the same fake hasher every other credential in this harness
  // shares) — the same reasoning `fields` below already applies to `AesFieldEncryption`: a real
  // adapter over a fixed test key is more faithful than a second, hand-rolled encryption double.
  const recoveryCodeRows = new FakeRecoveryCodes();
  const totp = new OtplibTotpAdapter();
  const qr = new QrcodeSvgAdapter();
  const recoveryCodeGenerator = new CsprngRecoveryCodeGenerator(hasher);
  const generateRecoveryCodes = new GenerateRecoveryCodesUseCase(
    recoveryCodeRows,
    recoveryCodeGenerator,
  );
  const mfaFields = new AesFieldEncryption(Buffer.alloc(32, 7).toString('base64'));

  /**
   * An in-memory denylist, and it has to be here rather than `detachedTokenDenylist()`.
   *
   * The detached stand-in is **fail-closed**: it throws `ServiceUnavailableError` from both methods,
   * because a container built without Redis must not silently let a spent token verify twice. That
   * is right in production and useless in a harness — every request to `/auth/2fa/verify` would
   * answer 503 and no scenario could reach the behaviour it means to assert.
   */
  const spentTokens = new Set<string>();
  const tokenDenylist: TokenDenylistPort = {
    revoke: async (key) => {
      spentTokens.add(key);
    },
    isRevoked: async (key) => spentTokens.has(key),
  };

  const mfaPendingTokens = new JwtMfaPendingTokenAdapter(
    'test-jwt-secret-value-at-least-32-chars!!',
    clock,
    new FakeIdGenerator(),
    tokenDenylist,
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
      audit,
    ),
    login: new LoginUseCase(
      lookup,
      hasher,
      users,
      totpEnrollment,
      unitOfWork,
      issueSession,
      mfaPendingTokens,
      rateLimit,
      logger,
      audit,
    ),
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
      audit,
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
      audit,
    ),
    endSession: new EndSessionUseCase(sessions, unitOfWork, clock, logger, audit),
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
      audit,
      APP_URL,
    ),
    listSessions: new ListSessionsQuery(sessions, unitOfWork, clock),
    authenticate: new AuthenticateSessionQuery(accessTokens, sessions, unitOfWork, clock),
    authLookup: lookup,
    refreshTokens,
    setupTotp: new SetupTotpUseCase(
      users,
      totpEnrollment,
      totp,
      qr,
      mfaFields,
      unitOfWork,
      rateLimit,
      clock,
    ),
    confirmTotp: new ConfirmTotpUseCase(
      totpEnrollment,
      totp,
      mfaFields,
      generateRecoveryCodes,
      users,
      hasher,
      unitOfWork,
      rateLimit,
      clock,
      logger,
      audit,
      dispatcher,
      APP_URL,
    ),
    recoveryCodeStatus: new ReadRecoveryCodeStatusQuery(recoveryCodeRows, unitOfWork),
    regenerateRecoveryCodes: new RegenerateRecoveryCodesUseCase(
      users,
      totpEnrollment,
      totp,
      mfaFields,
      recoveryCodeRows,
      hasher,
      generateRecoveryCodes,
      unitOfWork,
      rateLimit,
      clock,
      logger,
      audit,
      dispatcher,
      APP_URL,
    ),
    disableTotp: new DisableTotpUseCase(
      totpEnrollment,
      totp,
      mfaFields,
      recoveryCodeRows,
      new RecoveryCodeMatcher(recoveryCodeRows, hasher),
      users,
      hasher,
      unitOfWork,
      rateLimit,
      clock,
      logger,
      audit,
      dispatcher,
      APP_URL,
      mfaPolicy,
    ),
    verifySecondFactor: new VerifySecondFactorUseCase(
      mfaPendingTokens,
      totpEnrollment,
      totp,
      mfaFields,
      new ConsumeRecoveryCodeUseCase(
        new RecoveryCodeMatcher(recoveryCodeRows, hasher),
        recoveryCodeRows,
        users,
        unitOfWork,
        rateLimit,
        clock,
        logger,
        audit,
        noopMetrics,
        dispatcher,
        APP_URL,
      ),
      users,
      organizations,
      unitOfWork,
      issueSession,
      rateLimit,
      clock,
      logger,
      audit,
    ),
  };

  const userRoles = options.userRoles ?? new FakeUserRoleRepository();
  const overrides = options.overrides ?? new FakePermissionOverrideRepository();
  const customRoles = options.customRoles ?? new FakeCustomRoleRepository();
  const teams = options.teams ?? new FakeTeamRepository();
  const invitations = options.invitations ?? new FakeInvitationRepository();
  const employeeProfiles = options.employeeProfiles ?? new FakeEmployeeProfileRepository();
  const employeeDirectory = options.employeeDirectory ?? new FakeEmployeeDirectoryRepository();
  const userLifecycle = options.userLifecycle ?? new FakeUserLifecycleRepository();
  const ownership = options.ownership ?? new FakeOwnershipRepository();
  const fields = new AesFieldEncryption(Buffer.alloc(32, 7).toString('base64'));

  // The org-less resolver reads the very rows the repository wrote, like the session and reset-token
  // readers above: a second list here would let a suite accept a link the table no longer has.
  lookup.readingInvitations(invitations);
  const capabilities = new FakeEffectivePermissionsReader(
    options.capabilities ?? {
      isOwner: false,
      granted: [],
      denied: [],
      roleKeys: [],
      permissionsVersion: 1,
    },
    options.capabilitiesByUser,
    options.attributionByUser,
  );
  const buildActor = new BuildActorQuery(unitOfWork, capabilities);
  const iam = {
    buildActor,
    getMyPermissions: new GetMyPermissionsQuery(buildActor),
    getUserPermissions: new GetUserPermissionsQuery(unitOfWork, capabilities, audit),
    assignRole: new AssignRoleUseCase(unitOfWork, userRoles, audit),
    revokeRole: new RevokeRoleUseCase(unitOfWork, userRoles, audit),
    writeOverride: new WritePermissionOverrideUseCase(
      unitOfWork,
      overrides,
      capabilities,
      userRoles,
      audit,
    ),
    removeOverride: new RemovePermissionOverrideUseCase(
      unitOfWork,
      overrides,
      capabilities,
      userRoles,
      audit,
    ),
    listRoles: new ListRolesQuery(unitOfWork, customRoles),
    previewChanges: new PreviewRoleChangesQuery(unitOfWork, customRoles),
    applyChanges: new ApplyRoleChangesUseCase(unitOfWork, customRoles, audit),
    createRole: new CreateCustomRoleUseCase(unitOfWork, customRoles, audit),
    updateRole: new UpdateCustomRoleUseCase(unitOfWork, customRoles, audit),
    deleteRole: new DeleteCustomRoleUseCase(unitOfWork, customRoles, audit),
    listTeams: new ListTeamsQuery(unitOfWork, teams),
    getTeamDetail: new GetTeamDetailQuery(unitOfWork, teams),
    createTeam: new CreateTeamUseCase(unitOfWork, teams, audit),
    updateTeam: new UpdateTeamUseCase(unitOfWork, teams, audit),
    deleteTeam: new DeleteTeamUseCase(unitOfWork, teams, audit),
    addTeamMember: new AddTeamMemberUseCase(unitOfWork, teams, audit),
    removeTeamMember: new RemoveTeamMemberUseCase(unitOfWork, teams, audit),
    listInvitations: new ListInvitationsQuery(unitOfWork, invitations),
    createInvitation: new CreateInvitationUseCase(
      unitOfWork,
      invitations,
      organizations,
      resetTokens,
      clock,
      audit,
      rateLimit,
      mail,
      dispatcher,
      APP_URL,
    ),
    resendInvitation: new ResendInvitationUseCase(
      unitOfWork,
      invitations,
      organizations,
      resetTokens,
      clock,
      audit,
      rateLimit,
      mail,
      dispatcher,
      APP_URL,
    ),
    revokeInvitation: new RevokeInvitationUseCase(unitOfWork, invitations, audit),
    transferOwnership: new TransferOwnershipUseCase(unitOfWork, ownership, audit),
    deactivateUser: new DeactivateUserUseCase(
      unitOfWork,
      userLifecycle,
      sessions,
      capabilities,
      audit,
      clock,
    ),
    reactivateUser: new ReactivateUserUseCase(unitOfWork, userLifecycle, capabilities, audit),
    resetUserMfa: new ResetUserMfaUseCase(
      unitOfWork,
      users,
      totpEnrollment,
      recoveryCodeRows,
      sessions,
      userRoles,
      capabilities,
      rateLimit,
      audit,
      clock,
      dispatcher,
      APP_URL,
    ),
    listEmployees: new ListEmployeesQuery(unitOfWork, employeeDirectory),
    getOrgChart: new GetOrgChartQuery(unitOfWork, employeeDirectory),
    readEmployeeProfile: new ReadEmployeeProfileQuery(unitOfWork, employeeProfiles, fields),
    writeEmployeeProfile: new WriteEmployeeProfileUseCase(
      unitOfWork,
      employeeProfiles,
      fields,
      audit,
    ),
    acceptInvitation: new AcceptInvitationUseCase(
      lookup,
      invitations,
      userRoles,
      organizations,
      issueSession,
      hasher,
      resetTokens,
      unitOfWork,
      rateLimit,
      clock,
      logger,
      audit,
    ),
  };

  // The platform half only — `identity` and `iam` below replace what a container would have built,
  // so building them would be work thrown away. See `createTestPlatform` for what that costs
  // (an argon2 digest per application), what is shared, and what stops being checked here.
  const platform = createTestPlatform(
    options.trustedProxyHops === undefined ? {} : { TRUSTED_PROXY_HOPS: options.trustedProxyHops },
  );

  /**
   * The organization's own administration, over the same in-memory doubles as everything else.
   *
   * Wired here rather than taken from `platform.http`: the shared platform container is built
   * without a database, so its organization slice raises on every call — which would make the three
   * security-policy routes answer 500 in every suite that reaches them, the permission matrix
   * included.
   */
  const organization = {
    readSecurityPolicy: new ReadSecurityPolicyQuery(unitOfWork, mfaPolicy),
    updateSecurityPolicy: new UpdateSecurityPolicyUseCase(
      unitOfWork,
      organizations,
      customRoles,
      mfaPolicyReader,
      totpEnrollment,
      clock,
      audit,
    ),
    mfaCoverageReport: new MfaCoverageReportQuery(unitOfWork, mfaPolicyReader, mfaPolicy, clock),
  };

  const app = createHttpServer({ ...platform.http, identity, iam, organization });

  let listening: Server | undefined;
  const server = (): Server => {
    if (listening === undefined) {
      const opened = createServer(app);
      opened.listen(0);
      listening = opened;
      // Closing and forgetting are one act, registered together: an `AuthApp` built in `beforeAll`
      // is asked again by the next test, and a memo that survived the close would hand it the dead
      // listener. Re-entering here opens a fresh one instead.
      openServers.add(() => {
        listening = undefined;
        // Connections first, listener second. `close()` stops new sockets and lets existing ones
        // finish, so a socket pooled by a client outlives the server it belongs to — and the
        // operating system is free to hand the same port to the next listener, at which point that
        // pooled socket points at a stranger. That is the mechanism `test/setup/http-agent.setup.ts`
        // documents behind «Parse Error: Expected HTTP/…»; keep-alive is off there, which removes
        // the pool, and this removes the sockets themselves. Belt and braces on purpose: the class
        // has been observed once since keep-alive was disabled, and neither half is expensive.
        opened.closeAllConnections();
        opened.close();
      });
    }
    return listening;
  };

  return {
    app,
    server,
    iam,
    userLifecycle,
    ownership,
    clock,
    sessions,
    users,
    enrollment: totpEnrollment,
    recoveryCodeRows,
    organizations,
    /** Seeded by a suite that wants the organization's second-factor policy to cover somebody. */
    mfaPolicyReader,
    lookup,
    hasher,
    logger,
    rateLimit,
    mail,
    dispatcher,
    resetTokens,
    userRoles,
    overrides,
    invitations,
    employeeProfiles,
    customRoles,
    teams,
    audit,
    logLines: platform.logLines,
  };
};
