import { API_PREFIX } from '@/presentation/http/api-version.constant.js';
import { createAuthController } from '@/presentation/http/controllers/auth.controller.js';
import { createMfaController } from '@/presentation/http/controllers/mfa.controller.js';
import { createTelemetryController } from '@/presentation/http/controllers/telemetry.controller.js';
import { clientErrorBodySchema } from '@/presentation/http/validators/telemetry.validator.js';
import { createMetricsController } from '@/presentation/http/controllers/metrics.controller.js';
import { createHealthController } from '@/presentation/http/controllers/health.controller.js';
import { createMetaController } from '@/presentation/http/controllers/meta.controller.js';
import { createSessionController } from '@/presentation/http/controllers/session.controller.js';
import { createCustomRoleController } from '@/presentation/http/controllers/custom-role.controller.js';
import { createEmployeeController } from '@/presentation/http/controllers/employee.controller.js';
import { createInvitationController } from '@/presentation/http/controllers/invitation.controller.js';
import { createMeController } from '@/presentation/http/controllers/me.controller.js';
import { createPermissionOverrideController } from '@/presentation/http/controllers/permission-override.controller.js';
import { createUserPermissionsController } from '@/presentation/http/controllers/user-permissions.controller.js';
import { createOwnershipController } from '@/presentation/http/controllers/ownership.controller.js';
import { createSecurityPolicyController } from '@/presentation/http/controllers/security-policy.controller.js';
import { createUserLifecycleController } from '@/presentation/http/controllers/user-lifecycle.controller.js';
import { createUserSecurityController } from '@/presentation/http/controllers/user-security.controller.js';
import { createProjectController } from '@/presentation/http/controllers/project.controller.js';
import { createTeamController } from '@/presentation/http/controllers/team.controller.js';
import { createUserRoleController } from '@/presentation/http/controllers/user-role.controller.js';
import { allowedOrigins } from '@/presentation/http/cors-origin.util.js';
import { type HttpServerDependencies } from '@/presentation/http/http-server.types.js';
import { createAuthenticationMiddleware } from '@/presentation/http/middleware/authenticate.middleware.js';
import { createFullSessionMiddleware } from '@/presentation/http/middleware/require-full-session.middleware.js';
import { requireIdempotencyKey } from '@/presentation/http/middleware/idempotency-key.middleware.js';
import { createPermissionMiddleware } from '@/presentation/http/middleware/require-permission.middleware.js';
import { createSameOriginMiddleware } from '@/presentation/http/middleware/same-origin.middleware.js';
import { validate } from '@/presentation/http/middleware/validate.middleware.js';
import {
  isSelfServiceRoute,
  isGuardedRoute,
  requiresAuthentication,
  requiresFullSession,
  requiresPermission,
  type RouteDeclaration,
} from '@/presentation/http/route-registry.types.js';
import {
  changePasswordBodySchema,
  forgotPasswordBodySchema,
  loginBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  sessionIdParamsSchema,
} from '@/presentation/http/validators/auth.validator.js';
import {
  confirmTotpBodySchema,
  disableTotpBodySchema,
  verifySecondFactorBodySchema,
  regenerateRecoveryCodesBodySchema,
} from '@/presentation/http/validators/mfa.validator.js';
import { metaQuerySchema } from '@/presentation/http/validators/meta.validator.js';
import {
  createRoleBodySchema,
  roleChangesBodySchema,
  roleIdParamsSchema,
  updateRoleBodySchema,
} from '@/presentation/http/validators/custom-role.validator.js';
import { acceptInvitationBodySchema } from '@/presentation/http/validators/accept-invitation.validator.js';
import { employeeDirectoryQuerySchema } from '@/presentation/http/validators/employee-directory.validator.js';
import {
  employeeProfileBodySchema,
  userIdParamsSchema as employeeUserIdParamsSchema,
} from '@/presentation/http/validators/employee.validator.js';
import {
  createInvitationBodySchema,
  invitationIdParamsSchema,
} from '@/presentation/http/validators/invitation.validator.js';
import {
  overrideParamsSchema,
  writeOverrideBodySchema,
} from '@/presentation/http/validators/permission-override.validator.js';
import { userPermissionsParamsSchema } from '@/presentation/http/validators/user-permissions.validator.js';
import { transferOwnershipBodySchema } from '@/presentation/http/validators/ownership.validator.js';
import {
  mfaCoverageQuerySchema,
  updateSecurityPolicyBodySchema,
} from '@/presentation/http/validators/security-policy.validator.js';
import {
  addTeamMemberBodySchema,
  createTeamBodySchema,
  teamIdParamsSchema,
  teamMemberParamsSchema,
  updateTeamBodySchema,
} from '@/presentation/http/validators/team.validator.js';
import {
  addProjectMemberBodySchema,
  changeProjectVisibilityBodySchema,
  createProjectBodySchema,
  projectIdParamsSchema,
  projectMemberParamsSchema,
  projectMembersQuerySchema,
  updateProjectBodySchema,
  updateProjectMemberBodySchema,
} from '@/presentation/http/validators/project.validator.js';
import {
  deactivateUserBodySchema,
  userLifecycleParamsSchema,
} from '@/presentation/http/validators/user-lifecycle.validator.js';
import { resetUserMfaParamsSchema } from '@/presentation/http/validators/user-security.validator.js';
import {
  assignRoleBodySchema,
  userIdParamsSchema,
  userRoleParamsSchema,
} from '@/presentation/http/validators/user-role.validator.js';

/**
 * Every route this process answers, as data.
 *
 * The registry exists so that "which permission gates this endpoint" has an answer that can be
 * read, tested and reviewed without following a handler chain — invariant 2 of CLAUDE.md and
 * `rules/permissions.mdc` §2. Two properties follow from keeping it as data rather than as calls to
 * `router.get(...)`:
 *
 * - **A route cannot exist without a declaration.** `api.routes.ts` mounts *this list* and nothing
 *   else, so there is no `router.post(...)` for anyone to add somewhere else; the contract test
 *   additionally walks the finished Express router and compares it back, which catches a route
 *   registered outside this file by any other means.
 * - **Authorization has one place to be mounted from.** The authentication guard is prepended below
 *   by asking `requiresAuthentication` about each declaration, so it cannot be forgotten on a new
 *   endpoint — the failure mode a per-route `app.use(...)` invites. The permission guard joins it
 *   the same way in EPIC-011, when the first `GuardedRoute` exists.
 *
 * `aclCheckedIn` is named by every guarded route that addresses one object, and
 * `test/contract/acl-coverage.test.ts` fails when one does not — the capability guard answers «may
 * this caller do this anywhere», which is not the question a route with an id in the path asks. The
 * self-service routes name `ownershipCheckedIn` instead, which the type makes mandatory.
 */
export const createRouteRegistry = (
  dependencies: HttpServerDependencies,
): readonly RouteDeclaration[] => {
  const health = createHealthController(dependencies);
  const metrics =
    dependencies.metrics === undefined
      ? undefined
      : createMetricsController({
          metrics: dependencies.metrics.port,
          token: dependencies.metrics.token,
        });
  const meta = createMetaController(dependencies);
  const metaQuery = validate({ query: metaQuerySchema });
  const telemetry = createTelemetryController(dependencies);
  const clientErrorValidator = validate({ body: clientErrorBodySchema });

  const registerValidator = validate({ body: registerBodySchema });
  const loginValidator = validate({ body: loginBodySchema });
  const changePasswordValidator = validate({ body: changePasswordBodySchema });
  const forgotPasswordValidator = validate({ body: forgotPasswordBodySchema });
  const resetPasswordValidator = validate({ body: resetPasswordBodySchema });
  const sessionIdValidator = validate({ params: sessionIdParamsSchema });
  const assignRoleValidator = validate({ params: userIdParamsSchema, body: assignRoleBodySchema });
  const revokeRoleValidator = validate({ params: userRoleParamsSchema });

  const writeOverrideValidator = validate({
    params: overrideParamsSchema,
    body: writeOverrideBodySchema,
  });
  const removeOverrideValidator = validate({ params: overrideParamsSchema });

  const overrides = createPermissionOverrideController({
    writeOverride: dependencies.iam.writeOverride,
    removeOverride: dependencies.iam.removeOverride,
    writeValidator: writeOverrideValidator,
    removeValidator: removeOverrideValidator,
  });

  const userPermissionsValidator = validate({ params: userPermissionsParamsSchema });

  const userPermissions = createUserPermissionsController({
    getUserPermissions: dependencies.iam.getUserPermissions,
    validator: userPermissionsValidator,
  });

  const me = createMeController({ getMyPermissions: dependencies.iam.getMyPermissions });

  const createRoleValidator = validate({ body: createRoleBodySchema });
  const updateRoleValidator = validate({ params: roleIdParamsSchema, body: updateRoleBodySchema });
  const deleteRoleValidator = validate({ params: roleIdParamsSchema });

  const roleChangesValidator = validate({ body: roleChangesBodySchema });

  const customRoles = createCustomRoleController({
    listRoles: dependencies.iam.listRoles,
    previewChanges: dependencies.iam.previewChanges,
    applyChanges: dependencies.iam.applyChanges,
    changesValidator: roleChangesValidator,
    createRole: dependencies.iam.createRole,
    updateRole: dependencies.iam.updateRole,
    deleteRole: dependencies.iam.deleteRole,
    createValidator: createRoleValidator,
    updateValidator: updateRoleValidator,
    deleteValidator: deleteRoleValidator,
  });

  const createInvitationValidator = validate({ body: createInvitationBodySchema });
  const invitationIdValidator = validate({ params: invitationIdParamsSchema });
  const acceptInvitationValidator = validate({ body: acceptInvitationBodySchema });

  const invitations = createInvitationController({
    listInvitations: dependencies.iam.listInvitations,
    createInvitation: dependencies.iam.createInvitation,
    resendInvitation: dependencies.iam.resendInvitation,
    revokeInvitation: dependencies.iam.revokeInvitation,
    acceptInvitation: dependencies.iam.acceptInvitation,
    createValidator: createInvitationValidator,
    invitationIdValidator,
    acceptValidator: acceptInvitationValidator,
  });

  const employeeReadValidator = validate({ params: employeeUserIdParamsSchema });
  const employeeWriteValidator = validate({
    params: employeeUserIdParamsSchema,
    body: employeeProfileBodySchema,
  });

  const employeeListValidator = validate({ query: employeeDirectoryQuerySchema });

  const employees = createEmployeeController({
    buildActor: dependencies.iam.buildActor,
    readProfile: dependencies.iam.readEmployeeProfile,
    writeProfile: dependencies.iam.writeEmployeeProfile,
    listEmployees: dependencies.iam.listEmployees,
    getOrgChart: dependencies.iam.getOrgChart,
    readValidator: employeeReadValidator,
    writeValidator: employeeWriteValidator,
    listValidator: employeeListValidator,
  });

  const deactivateUserValidator = validate({
    params: userLifecycleParamsSchema,
    body: deactivateUserBodySchema,
  });
  const reactivateUserValidator = validate({ params: userLifecycleParamsSchema });

  const userLifecycle = createUserLifecycleController({
    deactivateUser: dependencies.iam.deactivateUser,
    reactivateUser: dependencies.iam.reactivateUser,
    deactivateValidator: deactivateUserValidator,
    reactivateValidator: reactivateUserValidator,
  });

  const resetUserMfaValidator = validate({ params: resetUserMfaParamsSchema });

  const userSecurity = createUserSecurityController({
    resetUserMfa: dependencies.iam.resetUserMfa,
    resetUserMfaValidator,
  });

  const createTeamValidator = validate({ body: createTeamBodySchema });
  const updateTeamValidator = validate({ params: teamIdParamsSchema, body: updateTeamBodySchema });
  const teamIdValidator = validate({ params: teamIdParamsSchema });
  const addTeamMemberValidator = validate({
    params: teamIdParamsSchema,
    body: addTeamMemberBodySchema,
  });
  const teamMemberValidator = validate({ params: teamMemberParamsSchema });

  const projectIdValidator = validate({ params: projectIdParamsSchema });
  const createProjectValidator = validate({ body: createProjectBodySchema });
  const updateProjectValidator = validate({
    params: projectIdParamsSchema,
    body: updateProjectBodySchema,
  });
  const projectVisibilityValidator = validate({
    params: projectIdParamsSchema,
    body: changeProjectVisibilityBodySchema,
  });
  const projectMembersQueryValidator = validate({
    params: projectIdParamsSchema,
    query: projectMembersQuerySchema,
  });
  const addProjectMemberValidator = validate({
    params: projectIdParamsSchema,
    body: addProjectMemberBodySchema,
  });
  const updateProjectMemberValidator = validate({
    params: projectMemberParamsSchema,
    body: updateProjectMemberBodySchema,
  });
  const projectMemberValidator = validate({ params: projectMemberParamsSchema });

  const projects = createProjectController({
    getProjectDetail: dependencies.project.getProjectDetail,
    createProject: dependencies.project.createProject,
    updateProject: dependencies.project.updateProject,
    changeVisibility: dependencies.project.changeProjectVisibility,
    archiveProject: dependencies.project.archiveProject,
    deleteProject: dependencies.project.deleteProject,
    listMembers: dependencies.project.listProjectMembers,
    addMember: dependencies.project.addProjectMember,
    updateMember: dependencies.project.updateProjectMember,
    removeMember: dependencies.project.removeProjectMember,
    projectIdValidator,
    createValidator: createProjectValidator,
    updateValidator: updateProjectValidator,
    visibilityValidator: projectVisibilityValidator,
    membersQueryValidator: projectMembersQueryValidator,
    addMemberValidator: addProjectMemberValidator,
    updateMemberValidator: updateProjectMemberValidator,
    memberValidator: projectMemberValidator,
  });

  const teams = createTeamController({
    listTeams: dependencies.iam.listTeams,
    getTeamDetail: dependencies.iam.getTeamDetail,
    createTeam: dependencies.iam.createTeam,
    updateTeam: dependencies.iam.updateTeam,
    deleteTeam: dependencies.iam.deleteTeam,
    addMember: dependencies.iam.addTeamMember,
    removeMember: dependencies.iam.removeTeamMember,
    createValidator: createTeamValidator,
    updateValidator: updateTeamValidator,
    teamIdValidator,
    addMemberValidator: addTeamMemberValidator,
    memberValidator: teamMemberValidator,
  });

  const updateSecurityPolicyValidator = validate({ body: updateSecurityPolicyBodySchema });
  const mfaCoverageValidator = validate({ query: mfaCoverageQuerySchema });

  const securityPolicy = createSecurityPolicyController({
    readPolicy: dependencies.organization.readSecurityPolicy,
    updatePolicy: dependencies.organization.updateSecurityPolicy,
    coverageReport: dependencies.organization.mfaCoverageReport,
    updateValidator: updateSecurityPolicyValidator,
    coverageValidator: mfaCoverageValidator,
  });

  const transferOwnershipValidator = validate({ body: transferOwnershipBodySchema });

  const ownership = createOwnershipController({
    transferOwnership: dependencies.iam.transferOwnership,
    transferValidator: transferOwnershipValidator,
  });

  const userRoles = createUserRoleController({
    assignRole: dependencies.iam.assignRole,
    revokeRole: dependencies.iam.revokeRole,
    assignValidator: assignRoleValidator,
    revokeValidator: revokeRoleValidator,
  });

  const verifySecondFactorValidator = validate({ body: verifySecondFactorBodySchema });

  const auth = createAuthController({
    register: dependencies.identity.register,
    login: dependencies.identity.login,
    verifySecondFactor: dependencies.identity.verifySecondFactor,
    verifySecondFactorValidator,
    refresh: dependencies.identity.refresh,
    endSession: dependencies.identity.endSession,
    changePassword: dependencies.identity.changePassword,
    requestPasswordReset: dependencies.identity.requestPasswordReset,
    confirmPasswordReset: dependencies.identity.confirmPasswordReset,
    registerValidator,
    loginValidator,
    changePasswordValidator,
    forgotPasswordValidator,
    resetPasswordValidator,
  });

  const sessions = createSessionController({
    listSessions: dependencies.identity.listSessions,
    endSession: dependencies.identity.endSession,
    sessionIdValidator,
  });

  const confirmTotpValidator = validate({ body: confirmTotpBodySchema });
  const regenerateRecoveryCodesValidator = validate({ body: regenerateRecoveryCodesBodySchema });
  const disableTotpValidator = validate({ body: disableTotpBodySchema });

  const mfa = createMfaController({
    setupTotp: dependencies.identity.setupTotp,
    confirmTotp: dependencies.identity.confirmTotp,
    recoveryCodeStatus: dependencies.identity.recoveryCodeStatus,
    regenerateRecoveryCodes: dependencies.identity.regenerateRecoveryCodes,
    disableTotp: dependencies.identity.disableTotp,
    confirmTotpValidator,
    regenerateRecoveryCodesValidator,
    disableTotpValidator,
  });

  const sameOrigin = createSameOriginMiddleware(
    allowedOrigins({
      appUrl: dependencies.config.appUrl,
      extraOrigins: dependencies.config.corsExtraOrigins,
    }),
  );

  const declarations: readonly RouteDeclaration[] = [
    {
      method: 'get',
      path: '/health',
      handlers: [health.checkHealth],
      public: true,
      publicReason:
        'liveness probe of the container manager; it runs before any session exists and returns no tenant data',
    },
    {
      method: 'get',
      path: '/ready',
      handlers: [health.checkReadiness],
      public: true,
      publicReason:
        'readiness probe of the load balancer; gating it on a session would take the instance out of rotation whenever auth is degraded',
    },
    // Mounted only when this installation asked for metrics: an endpoint that answers 404 to
    // everybody is still an endpoint somebody can find, and `METRICS_ENABLED=false` is a request
    // for none.
    ...(metrics === undefined
      ? []
      : ([
          {
            method: 'get',
            path: '/metrics',
            handlers: [metrics.render],
            public: true,
            publicReason:
              'scraped by a monitoring agent that holds no session; guarded by METRICS_TOKEN inside the handler, which answers 404 without it',
          },
        ] satisfies readonly RouteDeclaration[])),
    {
      method: 'post',
      path: `${API_PREFIX}/telemetry/client-error`,
      handlers: [clientErrorValidator.handler, telemetry.reportClientError],
      public: true,
      publicReason:
        'a failure that prevents signing in is the one most worth reporting, and requiring a session would drop exactly those; the limiter counts per user when there is one and per address otherwise',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/meta`,
      handlers: [metaQuery.handler, meta.describeApi],
      public: true,
      publicReason:
        'API discovery: the client reads the version and the server clock before it has a session, and the response contains no tenant data',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/register`,
      handlers: [requireIdempotencyKey(), registerValidator.handler, auth.register],
      public: true,
      publicReason:
        'bootstrap of an empty installation: the subject a permission would be checked against is created by this very request; bounded by the installation-wide open-registration setting and by the organization_registration budget of three per hour per address, spent in RegisterOrganizationUseCase before anything is hashed or written',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/login`,
      handlers: [loginValidator.handler, auth.login],
      public: true,
      publicReason:
        'sign-in itself: the session a permission would be read from is what this operation issues; bounded by the auth_attempt budget of five per fifteen minutes on the pair of address and account, spent in LoginUseCase before any digest is verified and cleared once a session is issued',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/refresh`,
      handlers: [sameOrigin, auth.refresh],
      // Not `public`, and the distinction is the reason the third form exists: the caller is
      // authorised by possession of the refresh cookie, so the route is not anonymous — it simply
      // has no capability to check. Declaring it public would state that credentials are optional
      // here, which is the opposite of the truth.
      selfService: true,
      selfServiceReason:
        'authorised by possession of the refresh cookie, which identifies one session of one person; there is no capability to check, and the account has no say over its own session rotation',
      ownershipCheckedIn: 'RefreshSessionUseCase',
      credential: 'refresh-cookie',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/logout`,
      handlers: [auth.logout],
      // The way out. A scoped session that could not sign out would leave somebody who does not want
      // to enrol right now with no action available at all but closing the tab.
      mfaEnrollmentAllowed: true,
      selfService: true,
      selfServiceReason:
        'ending one’s own session is not a capability anybody can be denied; the subject and the object are the same person',
      ownershipCheckedIn: 'EndSessionUseCase.signOut',
      credential: 'either',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/auth/sessions`,
      handlers: [sessions.list],
      selfService: true,
      selfServiceReason:
        'reading one’s own sessions; the administrator’s right over another person’s sessions is a different operation and belongs to the permission catalog of EPIC-011',
      ownershipCheckedIn: 'ListSessionsQuery',
    },
    {
      method: 'delete',
      path: `${API_PREFIX}/auth/sessions/:sessionId`,
      handlers: [sessionIdValidator.handler, sessions.revoke],
      selfService: true,
      selfServiceReason:
        'closing one’s own session; ownership is the check, and it is made in the use-case by matching the session against the caller rather than by a capability',
      ownershipCheckedIn: 'EndSessionUseCase.revoke',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/change-password`,
      handlers: [requireIdempotencyKey(), changePasswordValidator.handler, auth.changePassword],
      selfService: true,
      selfServiceReason:
        'changing one’s own password is authorised by knowing it, not by holding a capability; the subject and the object are the same person, and no right anybody could revoke would stop them (docs/security/permission-model.md §3.20)',
      ownershipCheckedIn: 'ChangePasswordUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/forgot-password`,
      handlers: [requireIdempotencyKey(), forgotPasswordValidator.handler, auth.forgotPassword],
      public: true,
      publicReason:
        'account recovery is for people who cannot sign in, so requiring a session would defeat it; the answer is constant for every address, so no permission decision is being skipped, and the operation is bounded by the auth_attempt budget of five per fifteen minutes on the pair of address and account, spent in RequestPasswordResetUseCase before the address is resolved',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/reset-password`,
      handlers: [requireIdempotencyKey(), resetPasswordValidator.handler, auth.resetPassword],
      public: true,
      publicReason:
        'the credential is the single-use token in the body, which is the whole authorisation: the person is by definition unable to sign in, the token is 32 CSPRNG bytes stored only as a SHA-256 digest, it expires in an hour and it is spent by one conditional UPDATE in ConfirmPasswordResetUseCase; the ambient per-address budget is the only subject this half of the flow has, and the expensive work is bounded elsewhere — nothing is hashed until that UPDATE has actually spent a row, so the number of Argon2id computations an address can force is the number of tokens forgot-password issued to it under the auth_attempt budget of five per fifteen minutes',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/sessions/revoke-others`,
      handlers: [sessions.revokeOthers],
      selfService: true,
      selfServiceReason:
        'same subject and object as signing out, over the rest of one’s own sessions; there is no capability that could grant it to anybody else',
      ownershipCheckedIn: 'EndSessionUseCase.revokeOthers',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/2fa/verify`,
      handlers: [verifySecondFactorValidator.handler, auth.verifySecondFactor],
      public: true,
      publicReason:
        'the second step of signing in: the caller holds an intermediate token and no session, and the session a permission would be read from is what this operation issues. Bounded by the mfa_verify_attempt budget of five per five minutes keyed on the token itself, spent in VerifySecondFactorUseCase before either factor is compared, and the token is voided outright on the sixth attempt',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/2fa/setup`,
      handlers: [mfa.setup],
      // One of the three routes a session scoped by the organization's policy may reach: this is
      // the wizard the scope exists to send people to (STORY-013-05, acceptance 3).
      mfaEnrollmentAllowed: true,
      selfService: true,
      selfServiceReason:
        'drafting a TOTP secret for one’s own account is authorised by holding the session, not by a capability; nobody could be denied the right to protect their own login (docs/security/permission-model.md §3.20)',
      ownershipCheckedIn: 'SetupTotpUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/2fa/confirm`,
      handlers: [requireIdempotencyKey(), confirmTotpValidator.handler, mfa.confirm],
      // The second half of the wizard. Without it the scope would be a room with a door and no
      // handle: a session could draft a secret and never confirm it.
      mfaEnrollmentAllowed: true,
      selfService: true,
      selfServiceReason:
        'confirming possession of one’s own drafted secret, reauthenticated with the current password in the same request; bounded by the mfa_setup_attempt budget of five per fifteen minutes on the caller, spent in ConfirmTotpUseCase before either proof is even read',
      ownershipCheckedIn: 'ConfirmTotpUseCase',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/auth/2fa/recovery-codes`,
      handlers: [mfa.recoveryCodeStatus],
      selfService: true,
      selfServiceReason:
        'reading the count of one’s own remaining recovery codes; the plaintext values do not exist anywhere to be denied access to',
      ownershipCheckedIn: 'ReadRecoveryCodeStatusQuery',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/2fa/recovery-codes/regenerate`,
      handlers: [
        requireIdempotencyKey(),
        regenerateRecoveryCodesValidator.handler,
        mfa.regenerateRecoveryCodes,
      ],
      selfService: true,
      selfServiceReason:
        'replacing one’s own recovery-code set; authorised by reauthentication (current password and a live TOTP code) rather than by a capability, and bounded by the mfa_reauth_attempt budget of five per fifteen minutes',
      ownershipCheckedIn: 'RegenerateRecoveryCodesUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/auth/2fa/disable`,
      handlers: [requireIdempotencyKey(), disableTotpValidator.handler, mfa.disable],
      selfService: true,
      selfServiceReason:
        'turning one’s own 2FA off; authorised by reauthentication (current password and either a live TOTP code or an unused recovery code) rather than by a capability — the same standing STORY-013-04 gives the administrative reset none of, and bounded by the mfa_reauth_attempt budget of five per fifteen minutes, spent in DisableTotpUseCase before either proof is read',
      ownershipCheckedIn: 'DisableTotpUseCase',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/roles`,
      handlers: [customRoles.list],
      permission: 'role:read',
      // Nothing narrower to decide: the answer is every role of the tenant, and the tenant is the
      // scope — so the guard's capability check is the whole decision.
      aclCheckedIn: 'ListRolesQuery',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/roles/preview-changes`,
      handlers: [roleChangesValidator.handler, customRoles.preview],
      // A read that answers «what would happen», so it asks for the reading right — a draft nobody
      // saves changes nothing, and requiring `role:update` here would hide the summary from the
      // people the summary is for.
      permission: 'role:read',
      aclCheckedIn: 'PreviewRoleChangesQuery',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/roles/apply-changes`,
      handlers: [requireIdempotencyKey(), roleChangesValidator.handler, customRoles.apply],
      permission: 'role:update',
      // The guard answers «may this caller edit roles at all». Which of the drafted changes are
      // acceptable — the subset rule, system roles, the self-lockout across the whole draft — is
      // decided in the use-case, which is also the only place that can answer 404 for a role id
      // belonging to somebody else.
      aclCheckedIn: 'ApplyRoleChangesUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/roles`,
      handlers: [requireIdempotencyKey(), createRoleValidator.handler, customRoles.create],
      permission: 'role:create',
      aclCheckedIn: 'CreateCustomRoleUseCase',
    },
    {
      method: 'patch',
      path: `${API_PREFIX}/roles/:roleId`,
      handlers: [updateRoleValidator.handler, customRoles.update],
      permission: 'role:update',
      // The system-role refusal, the subset rule and the self-lockout check all need the role that
      // is being changed — which is why they live in the use-case and not in the guard.
      aclCheckedIn: 'UpdateCustomRoleUseCase',
    },
    {
      method: 'delete',
      path: `${API_PREFIX}/roles/:roleId`,
      handlers: [deleteRoleValidator.handler, customRoles.remove],
      permission: 'role:delete',
      aclCheckedIn: 'DeleteCustomRoleUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/users/:userId/roles`,
      handlers: [requireIdempotencyKey(), assignRoleValidator.handler, userRoles.assign],
      permission: 'role:assign',
      // The guard answers «may this caller assign roles at all». Whether *this* role may go to
      // *this* person — the subset rule, self-assignment, the subject being in this organization —
      // is decided in the use-case, which is also the only place that can answer 404 rather than 403
      // for somebody else's id.
      aclCheckedIn: 'AssignRoleUseCase',
    },
    {
      method: 'delete',
      path: `${API_PREFIX}/users/:userId/roles/:roleId`,
      handlers: [revokeRoleValidator.handler, userRoles.revoke],
      permission: 'role:revoke',
      aclCheckedIn: 'RevokeRoleUseCase',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/teams`,
      handlers: [teams.list],
      permission: 'team:read',
      // Nothing narrower to decide: the answer is every live team of the tenant, and the tenant is
      // the scope — so the guard's capability check is the whole decision. The soft-deleted rows are
      // excluded by the query itself rather than after it (`rules/permissions.mdc`, 8).
      aclCheckedIn: 'ListTeamsQuery',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/teams`,
      handlers: [requireIdempotencyKey(), createTeamValidator.handler, teams.create],
      permission: 'team:create',
      aclCheckedIn: 'CreateTeamUseCase',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/teams/:teamId`,
      handlers: [teamIdValidator.handler, teams.detail],
      permission: 'team:read',
      // The guard answers «may this caller read teams at all». Whether *this* id names one — a team
      // of another organization, or one already disbanded — is decided in the use-case, which is the
      // only place that can answer 404 rather than 403 for somebody else's id.
      aclCheckedIn: 'GetTeamDetailQuery',
    },
    {
      method: 'patch',
      path: `${API_PREFIX}/teams/:teamId`,
      handlers: [updateTeamValidator.handler, teams.update],
      permission: 'team:update',
      aclCheckedIn: 'UpdateTeamUseCase',
    },
    {
      method: 'delete',
      path: `${API_PREFIX}/teams/:teamId`,
      handlers: [teamIdValidator.handler, teams.remove],
      permission: 'team:delete',
      aclCheckedIn: 'DeleteTeamUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/teams/:teamId/members`,
      handlers: [requireIdempotencyKey(), addTeamMemberValidator.handler, teams.addMember],
      // A separate key from `team:update`: renaming a team and deciding who is on it are different
      // grants, which is why the catalogue carries both.
      permission: 'team:manage_members',
      // Three decisions the guard cannot make: the team may belong to another organization (404),
      // the subject may belong to another organization (404), and the subject may be deactivated
      // (409) — all of them need rows.
      aclCheckedIn: 'AddTeamMemberUseCase',
    },
    {
      method: 'delete',
      path: `${API_PREFIX}/teams/:teamId/members/:userId`,
      handlers: [teamMemberValidator.handler, teams.removeMember],
      permission: 'team:manage_members',
      aclCheckedIn: 'RemoveTeamMemberUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/projects`,
      handlers: [requireIdempotencyKey(), createProjectValidator.handler, projects.create],
      // No level: there is no row yet to hold one on. The lead is looked up inside the use-case,
      // which is the only place that can answer 404 rather than 403 for somebody else's account.
      permission: 'project:create',
      aclCheckedIn: 'CreateProjectUseCase',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/projects/:projectId`,
      handlers: [projectIdValidator.handler, projects.detail],
      permission: 'project:read',
      // The first key with a `requiredLevel` behind a route that reads a resource. The guard answers
      // «may this caller read projects at all»; whether *this* id names one they may see — a
      // `PRIVATE` project they are not on, another organization's, a deleted row — is the ACL chain,
      // resolved inside the use-case and answered 404 rather than 403 for every outsider.
      aclCheckedIn: 'GetProjectDetailQuery',
    },
    {
      method: 'patch',
      path: `${API_PREFIX}/projects/:projectId`,
      handlers: [updateProjectValidator.handler, projects.update],
      // `EDITOR` on the chain. A changed `leadId` additionally needs `project:manage_members`,
      // decided in the use-case over the same locked row — the one field of the patch that moves
      // rights (a `LEAD` membership is `MANAGER`).
      permission: 'project:update',
      aclCheckedIn: 'UpdateProjectUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/projects/:projectId/visibility`,
      handlers: [projectVisibilityValidator.handler, projects.changeVisibility],
      // `MANAGER`, `dangerous`: the direction that matters takes the project away from everybody
      // in the organization who is not on it. Confirmed with `X-Confirm-Dangerous: 1`, demanded
      // only after the decision so the 428 cannot be used to learn who holds the right.
      permission: 'project:manage_visibility',
      aclCheckedIn: 'ChangeProjectVisibilityUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/projects/:projectId/archive`,
      handlers: [projectIdValidator.handler, projects.archive],
      // `MANAGER`. Idempotent on an archived project; the way back is STORY-014-07.
      permission: 'project:archive',
      aclCheckedIn: 'ArchiveProjectUseCase',
    },
    {
      method: 'delete',
      path: `${API_PREFIX}/projects/:projectId`,
      handlers: [projectIdValidator.handler, projects.remove],
      // `MANAGER`, `dangerous`: soft, the key is freed, every member's folded view is bumped.
      permission: 'project:delete',
      aclCheckedIn: 'DeleteProjectUseCase',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/projects/:projectId/members`,
      handlers: [projectMembersQueryValidator.handler, projects.listMembers],
      // The same gate as the card: `VIEWER` on the chain, so a `PRIVATE` project's roster is the
      // same 404 to an outsider as the project itself.
      permission: 'project:read',
      aclCheckedIn: 'ListProjectMembersQuery',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/projects/:projectId/members`,
      handlers: [requireIdempotencyKey(), addProjectMemberValidator.handler, projects.addMember],
      // `MANAGER` on the chain. Four decisions the guard cannot make: the project may be nobody's
      // (404), the subject may be the caller (403, `T-PROJ-02`), the subject may be another
      // organization's (404) or deactivated (409) — all of them need rows.
      permission: 'project:manage_members',
      aclCheckedIn: 'AddProjectMemberUseCase',
    },
    {
      method: 'patch',
      path: `${API_PREFIX}/projects/:projectId/members/:userId`,
      handlers: [updateProjectMemberValidator.handler, projects.updateMember],
      permission: 'project:manage_members',
      aclCheckedIn: 'UpdateProjectMemberUseCase',
    },
    {
      method: 'delete',
      path: `${API_PREFIX}/projects/:projectId/members/:userId`,
      handlers: [projectMemberValidator.handler, projects.removeMember],
      permission: 'project:manage_members',
      aclCheckedIn: 'RemoveProjectMemberUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/invitations/accept`,
      handlers: [requireIdempotencyKey(), acceptInvitationValidator.handler, invitations.accept],
      public: true,
      publicReason:
        'the account this would be authorised as is created by this very request: the token in the body is the whole credential, it is 32 CSPRNG bytes stored only as a SHA-256 digest, it expires in seven days and it is spent by one conditional UPDATE in AcceptInvitationUseCase; bounded by the invitation_accept budget of ten per fifteen minutes per address, spent before the digest is computed so that a guessed token costs no argon2id run (T-IAM-08)',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/invitations`,
      handlers: [invitations.list],
      permission: 'invitation:read',
      // Nothing narrower to decide: the answer is every open invitation of the tenant, and the
      // tenant is the scope — so the guard's capability check is the whole decision.
      aclCheckedIn: 'ListInvitationsQuery',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/invitations`,
      handlers: [requireIdempotencyKey(), createInvitationValidator.handler, invitations.create],
      permission: 'invitation:create',
      // The guard answers «may this caller invite anybody at all». Whether *this* role may be handed
      // out — the subset rule of `T-IAM-09` — and whether the address is free are decided in the
      // use-case, which is also the only place that can answer 404 for a role of another tenant.
      aclCheckedIn: 'CreateInvitationUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/invitations/:invitationId/resend`,
      // Idempotent by key like the creation it repeats: a resend mints a fresh token, kills the
      // previous one in the same statement and sends a letter. A retry after a dropped connection
      // would invalidate the link the first response already handed over, and deliver a second
      // letter to somebody who is not expecting one (`rules/api-contract.mdc` §10).
      handlers: [requireIdempotencyKey(), invitationIdValidator.handler, invitations.resend],
      permission: 'invitation:resend',
      // Its own capability, not a share of `invitation:create`: re-issuing decides nothing about who
      // gets what, and an accepted invitation is refused inside the use-case, which is the only
      // place that has the row.
      aclCheckedIn: 'ResendInvitationUseCase',
    },
    {
      method: 'delete',
      path: `${API_PREFIX}/invitations/:invitationId`,
      handlers: [invitationIdValidator.handler, invitations.revoke],
      permission: 'invitation:revoke',
      aclCheckedIn: 'RevokeInvitationUseCase',
    },
    // Both literal paths come **before** `/employees/:userId`. Express matches in declaration order,
    // so the parameter route would otherwise swallow `/employees/org-chart` and answer 422
    // `validation_failed` for a `userId` that is not a UUID — a route shadowed by its neighbour,
    // which no type can catch.
    {
      method: 'get',
      path: `${API_PREFIX}/employees`,
      handlers: [employeeListValidator.handler, employees.list],
      permission: 'employee:read',
      // The guard's capability check is the whole decision about *access*: the answer is the people
      // of this tenant, and the tenant is the scope. What the use-case decides is different — **how
      // much of each row** comes back, per subject, and whether the order asked for is one this
      // caller may have (an order by a column they cannot read leaks it, one page at a time).
      aclCheckedIn: 'ListEmployeesQuery',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/employees/org-chart`,
      handlers: [employees.orgChart],
      permission: 'employee:view_org_chart',
      // Its own capability rather than a share of `employee:read`: who reports to whom is a fact
      // about the organization, and a directory of names is not one. Nothing narrower to decide —
      // the chart is the whole tenant, and names are all it carries.
      aclCheckedIn: 'GetOrgChartQuery',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/employees/:userId`,
      handlers: [employeeReadValidator.handler, employees.read],
      selfService: true,
      selfServiceReason:
        'a person always reads their own personnel record — the dates and the contract type are on their own contract, and hiding them would be theatre; reading somebody else’s needs employee:read, and how much of it comes back is decided by employee-access.policy.ts, which answers two independent questions — may this caller see the employment half, and may they see rates',
      ownershipCheckedIn: 'ReadEmployeeProfileQuery',
    },
    {
      method: 'patch',
      path: `${API_PREFIX}/employees/:userId`,
      handlers: [employeeWriteValidator.handler, employees.write],
      selfService: true,
      selfServiceReason:
        'a person always edits the handful of fields on their own record that nobody else is a better authority on — name, timezone, skills, emergency contact; anybody else’s record and every employment field need employee:update, which WriteEmployeeProfileUseCase checks per field rather than per route, because the same request may carry both kinds',
      ownershipCheckedIn: 'WriteEmployeeProfileUseCase',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/organization/security-policy`,
      handlers: [securityPolicy.read],
      permission: 'organization:manage_security_policy',
      // The reading half of the same `dangerous` capability rather than `organization:read`: which
      // roles must carry a second factor is a map of where the weak accounts are, and every account
      // holds `organization:read`. Nothing narrower to decide — the policy is the tenant's, and the
      // tenant is the scope.
      aclCheckedIn: 'ReadSecurityPolicyQuery',
    },
    {
      method: 'patch',
      path: `${API_PREFIX}/organization/security-policy`,
      handlers: [
        requireIdempotencyKey(),
        updateSecurityPolicyValidator.handler,
        securityPolicy.update,
      ],
      permission: 'organization:manage_security_policy',
      // The guard answers «may this caller change the policy at all». Whether the role ids it names
      // exist in this tenant (404 rather than 403), when each countdown starts, and whether the
      // caller is about to put themselves under a requirement they do not meet are all decided in
      // the use-case, which is the only place that reads the tenant root and the grants in the
      // transaction that writes.
      aclCheckedIn: 'UpdateSecurityPolicyUseCase',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/organization/mfa-coverage`,
      handlers: [mfaCoverageValidator.handler, securityPolicy.coverage],
      permission: 'organization:manage_security_policy',
      // The same capability as the policy itself, and for the same reason: the report is a list of
      // which colleagues have no second factor, which is exactly the list an intruder would like.
      aclCheckedIn: 'MfaCoverageReportQuery',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/organization/transfer-ownership`,
      handlers: [requireIdempotencyKey(), transferOwnershipValidator.handler, ownership.transfer],
      permission: 'organization:transfer_ownership',
      // Held by `owner` alone (`permission-model.md` §4.1), so the guard settles «may this caller
      // hand the organization over at all». Whether *this* recipient may receive it — not oneself,
      // not a suspended account — and whether they exist in this tenant are decided in the use-case,
      // which is also the only place that answers 404 rather than 403 for somebody else's id.
      aclCheckedIn: 'TransferOwnershipUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/users/:userId/deactivate`,
      handlers: [
        requireIdempotencyKey(),
        deactivateUserValidator.handler,
        userLifecycle.deactivate,
      ],
      permission: 'user:suspend',
      // The guard answers «may this caller deactivate anybody». Whether *this* account may be
      // deactivated — not oneself, not the last owner — and whether it exists in this tenant at all
      // are decided inside the use-case, which is also the only place that can answer 404 rather
      // than 403 for somebody else's id.
      aclCheckedIn: 'DeactivateUserUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/users/:userId/reactivate`,
      handlers: [
        requireIdempotencyKey(),
        reactivateUserValidator.handler,
        userLifecycle.reactivate,
      ],
      permission: 'user:reactivate',
      // Its own capability rather than a share of `user:suspend`: bringing an account back is the
      // step an intruder needs after an offboarding, and an organization may well let more people
      // switch somebody off than switch them on.
      aclCheckedIn: 'ReactivateUserUseCase',
    },
    {
      method: 'post',
      path: `${API_PREFIX}/users/:userId/reset-mfa`,
      handlers: [requireIdempotencyKey(), resetUserMfaValidator.handler, userSecurity.resetMfa],
      permission: 'user:reset_mfa',
      // The guard answers «may this caller reset anybody's 2FA». Whether *this* account may be the
      // target — not the actor's own, not one that outranks the actor, not the organization owner
      // unless the actor is too — is decided inside the use-case
      // (`domain/identity/access/mfa-policy.policy.ts`, `assertNotSelfReset` and
      // `assertMfaResetInBounds`), which is also the only place that can answer 404 rather than 403
      // for somebody else's id.
      aclCheckedIn: 'ResetUserMfaUseCase',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/me/permissions`,
      handlers: [me.permissions],
      selfService: true,
      selfServiceReason:
        'the caller reading their own permissions; a capability here would be meaningless in both directions — taking it away would not stop them knowing what they may do, and granting it to somebody else would give access to nothing, because the operation takes no subject and can only answer about the caller',
      ownershipCheckedIn: 'GetMyPermissionsQuery',
    },
    {
      method: 'get',
      path: `${API_PREFIX}/users/:userId/permissions`,
      handlers: [userPermissionsValidator.handler, userPermissions.read],
      permission: 'permission:override_read',
      // Not `permission:read`, which is the catalogue — the same list in every installation and
      // secret from nobody, held by `manager` so the roles matrix renders. This answers «what may
      // this person do, and who arranged it»: their exceptions and the sentences an administrator
      // wrote beside them. Whether the subject exists in this tenant is decided inside the query,
      // which is also the only place that can answer 404 rather than 403 for somebody else's id.
      aclCheckedIn: 'GetUserPermissionsQuery',
    },
    {
      method: 'put',
      path: `${API_PREFIX}/users/:userId/permission-overrides/:permission`,
      handlers: [writeOverrideValidator.handler, overrides.write],
      permission: 'permission:override',
      // The subject, whether they are the owner, and whether the granter holds what they are handing
      // out are all read inside the use-case's transaction — and it is the only place that answers
      // 404 for a person of another organization.
      aclCheckedIn: 'WritePermissionOverrideUseCase',
    },
    {
      method: 'delete',
      path: `${API_PREFIX}/users/:userId/permission-overrides/:permission`,
      handlers: [removeOverrideValidator.handler, overrides.remove],
      permission: 'permission:override',
      aclCheckedIn: 'RemovePermissionOverrideUseCase',
    },
  ];

  // The permission guard first, so that the authentication guard ends up **in front of it**: each
  // wrapper prepends to `handlers`, so the last one applied runs first. The order is not cosmetic —
  // the permission guard reads the caller the authentication guard establishes, and reversing the
  // two makes every guarded route answer 500 instead of 401.
  return declarations.map((route) =>
    withAuthenticationGuard(
      withFullSessionGuard(withPermissionGuard(route, dependencies)),
      dependencies,
    ),
  );
};

/**
 * Prepends the enrolment gate to every authenticated route not on the whitelist.
 *
 * Between the authentication guard and the permission guard, which is the only order that works:
 * it reads the caller the first one established, and it must refuse *before* the second one spends
 * eleven statements building an actor for a session that may do nothing.
 */
const withFullSessionGuard = (route: RouteDeclaration): RouteDeclaration => {
  if (!requiresFullSession(route)) return route;

  return { ...route, handlers: [createFullSessionMiddleware(), ...route.handlers] };
};

/**
 * Prepends the authentication guard to every declaration that is not public.
 *
 * Derived from the declaration rather than written into `handlers` by each route author: that is
 * what makes "a route without a guard" impossible to produce by forgetting, and it is why
 * `requiresAuthentication` is a predicate over the union rather than a comment.
 *
 * The single exception is stated by the declaration itself and not by this function:
 * `credential: 'refresh-cookie'` means the handler consumes the credential, so a guard in front of
 * it would read the same row a second time and answer 401 without clearing the cookie.
 */
const withAuthenticationGuard = (
  route: RouteDeclaration,
  dependencies: HttpServerDependencies,
): RouteDeclaration => {
  if (!requiresAuthentication(route)) return route;

  const credential = isSelfServiceRoute(route) ? route.credential : undefined;

  if (credential === 'refresh-cookie') return route;

  const guard = createAuthenticationMiddleware({
    authenticate: dependencies.identity.authenticate,
    requestContext: dependencies.requestContext,
    ...(credential === 'either'
      ? {
          refreshCredential: {
            authLookup: dependencies.identity.authLookup,
            refreshTokens: dependencies.identity.refreshTokens,
          },
        }
      : {}),
  });

  return { ...route, handlers: [guard, ...route.handlers] };
};

/**
 * Prepends the capability guard to every declaration that names a permission.
 *
 * Mounted the same way the authentication guard is, and for the same reason: derived from the
 * declaration, so «a route whose permission is declared and never checked» cannot be produced by
 * forgetting a line. It runs after the authentication guard — it reads the caller that one
 * established — and before the validator, so a caller without the right is refused before a body is
 * parsed and before anything is read from the database.
 */
const withPermissionGuard = (
  route: RouteDeclaration,
  dependencies: HttpServerDependencies,
): RouteDeclaration => {
  if (!requiresPermission(route) || !isGuardedRoute(route)) return route;

  const guard = createPermissionMiddleware(
    { buildActor: dependencies.iam.buildActor },
    route.permission,
  );

  return { ...route, handlers: [guard, ...route.handlers] };
};
