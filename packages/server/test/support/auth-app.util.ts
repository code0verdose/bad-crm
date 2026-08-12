import { type Express } from 'express';

import { AuthenticateSessionQuery } from '@/application/identity/use-cases/authenticate-session.query.js';
import { ChangePasswordUseCase } from '@/application/identity/use-cases/change-password.use-case.js';
import { ConfirmPasswordResetUseCase } from '@/application/identity/use-cases/confirm-password-reset.use-case.js';
import { ConfirmTotpUseCase } from '@/application/identity/use-cases/confirm-totp.use-case.js';
import { EndSessionUseCase } from '@/application/identity/use-cases/end-session.use-case.js';
import { GenerateRecoveryCodesUseCase } from '@/application/identity/use-cases/generate-recovery-codes.use-case.js';
import { IssueSessionUseCase } from '@/application/identity/use-cases/issue-session.use-case.js';
import { ListSessionsQuery } from '@/application/identity/use-cases/list-sessions.query.js';
import { LoginUseCase } from '@/application/identity/use-cases/login.use-case.js';
import { ReadRecoveryCodeStatusQuery } from '@/application/identity/use-cases/read-recovery-code-status.query.js';
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
  readonly organizations: FakeOrganizations;
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
    new FakeIdGenerator(),
    new ProvisionSystemRolesUseCase(new FakeRoleRepository()),
  );

  // The 2FA surface (STORY-013-01, STORY-013-02). Real crypto adapters rather than scripted doubles
  // where the real ones are cheap and stateless (`OtplibTotpAdapter`, `QrcodeSvgAdapter`,
  // `CsprngRecoveryCodeGenerator` over the same fake hasher every other credential in this harness
  // shares) — the same reasoning `fields` below already applies to `AesFieldEncryption`: a real
  // adapter over a fixed test key is more faithful than a second, hand-rolled encryption double.
  const totpEnrollment = new FakeTotpEnrollment();
  const recoveryCodeRows = new FakeRecoveryCodes();
  const totp = new OtplibTotpAdapter();
  const qr = new QrcodeSvgAdapter();
  const recoveryCodeGenerator = new CsprngRecoveryCodeGenerator(hasher);
  const generateRecoveryCodes = new GenerateRecoveryCodesUseCase(
    recoveryCodeRows,
    recoveryCodeGenerator,
  );
  const mfaFields = new AesFieldEncryption(Buffer.alloc(32, 7).toString('base64'));

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
      unitOfWork,
      issueSession,
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

  const testApp = createTestApp(
    options.trustedProxyHops === undefined ? {} : { TRUSTED_PROXY_HOPS: options.trustedProxyHops },
  );

  return {
    app: createHttpServer({ ...testApp.container.http, identity, iam }),
    iam,
    userLifecycle,
    ownership,
    clock,
    sessions,
    users,
    organizations,
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
    logLines: testApp.logLines,
  };
};
