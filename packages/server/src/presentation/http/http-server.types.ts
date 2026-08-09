import { type RequestHandler } from 'express';

import { type AssignRoleUseCase } from '@/application/iam/use-cases/assign-role.use-case.js';
import { type BuildActorQuery } from '@/application/iam/use-cases/build-actor.query.js';
import { type GetMyPermissionsQuery } from '@/application/iam/use-cases/get-my-permissions.query.js';
import { type AcceptInvitationUseCase } from '@/application/iam/use-cases/accept-invitation.use-case.js';
import { type DeactivateUserUseCase } from '@/application/iam/use-cases/deactivate-user.use-case.js';
import { type TransferOwnershipUseCase } from '@/application/iam/use-cases/transfer-ownership.use-case.js';
import { type ReactivateUserUseCase } from '@/application/iam/use-cases/reactivate-user.use-case.js';
import { type GetOrgChartQuery } from '@/application/iam/use-cases/get-org-chart.query.js';
import { type ListEmployeesQuery } from '@/application/iam/use-cases/list-employees.query.js';
import {
  type ReadEmployeeProfileQuery,
  type WriteEmployeeProfileUseCase,
} from '@/application/iam/use-cases/write-employee-profile.use-case.js';
import { type DeleteTeamUseCase } from '@/application/iam/use-cases/delete-team.use-case.js';
import { type GetTeamDetailQuery } from '@/application/iam/use-cases/get-team-detail.query.js';
import { type ListInvitationsQuery } from '@/application/iam/use-cases/list-invitations.query.js';
import { type ListRolesQuery } from '@/application/iam/use-cases/list-roles.query.js';
import { type ListTeamsQuery } from '@/application/iam/use-cases/list-teams.query.js';
import {
  type AddTeamMemberUseCase,
  type RemoveTeamMemberUseCase,
} from '@/application/iam/use-cases/manage-team-members.use-case.js';
import {
  type CreateTeamUseCase,
  type UpdateTeamUseCase,
} from '@/application/iam/use-cases/write-team.use-case.js';
import {
  type CreateInvitationUseCase,
  type ResendInvitationUseCase,
  type RevokeInvitationUseCase,
} from '@/application/iam/use-cases/write-invitation.use-case.js';
import {
  type ApplyRoleChangesUseCase,
  type PreviewRoleChangesQuery,
} from '@/application/iam/use-cases/write-role-changes.use-case.js';
import { type DeleteCustomRoleUseCase } from '@/application/iam/use-cases/delete-custom-role.use-case.js';
import { type RemovePermissionOverrideUseCase } from '@/application/iam/use-cases/remove-permission-override.use-case.js';
import {
  type CreateCustomRoleUseCase,
  type UpdateCustomRoleUseCase,
} from '@/application/iam/use-cases/write-custom-role.use-case.js';
import { type RevokeRoleUseCase } from '@/application/iam/use-cases/revoke-role.use-case.js';
import { type WritePermissionOverrideUseCase } from '@/application/iam/use-cases/write-permission-override.use-case.js';
import { type AuthLookupPort } from '@/application/identity/ports/auth-lookup.port.js';
import { type RefreshTokenPort } from '@/application/identity/ports/refresh-token.port.js';
import { type AuthenticateSessionQuery } from '@/application/identity/use-cases/authenticate-session.query.js';
import { type ChangePasswordUseCase } from '@/application/identity/use-cases/change-password.use-case.js';
import { type ConfirmPasswordResetUseCase } from '@/application/identity/use-cases/confirm-password-reset.use-case.js';
import { type EndSessionUseCase } from '@/application/identity/use-cases/end-session.use-case.js';
import { type ListSessionsQuery } from '@/application/identity/use-cases/list-sessions.query.js';
import { type LoginUseCase } from '@/application/identity/use-cases/login.use-case.js';
import { type RefreshSessionUseCase } from '@/application/identity/use-cases/refresh-session.use-case.js';
import { type RegisterOrganizationUseCase } from '@/application/identity/use-cases/register-organization.use-case.js';
import { type RequestPasswordResetUseCase } from '@/application/identity/use-cases/request-password-reset.use-case.js';
import { type MetricsPort } from '@/application/platform/ports/metrics.port.js';
import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { type CheckHealthUseCase } from '@/application/platform/use-cases/check-health.use-case.js';
import { type CheckReadinessUseCase } from '@/application/platform/use-cases/check-readiness.use-case.js';
import { type RecordClientErrorUseCase } from '@/application/platform/use-cases/record-client-error.use-case.js';
import { type DescribeApiUseCase } from '@/application/platform/use-cases/describe-api.use-case.js';

/**
 * The configuration the HTTP layer needs — a deliberate subset of the environment, not `ServerEnv`.
 *
 * `ServerEnv` is produced by `infrastructure/bootstrap`, and `presentation` may not import
 * infrastructure. Restating the three values here is not duplication for its own sake: it documents
 * exactly which variables change the behaviour of the HTTP surface, and it lets a test build an
 * application without constructing a full environment.
 */
export interface HttpServerConfig {
  /** `APP_URL` — CORS allow-list and the switch that decides whether HSTS is sent. */
  readonly appUrl: string;
  /** `CORS_EXTRA_ORIGINS` — additional browser origins, comma-separated. */
  readonly corsExtraOrigins: string | undefined;
  /** `S3_ENDPOINT` — its origin goes into `connect-src`/`img-src` of the CSP (ADR-0023). */
  readonly storageEndpoint: string;
  /**
   * `TRUSTED_PROXY_HOPS` — how many `X-Forwarded-For` entries were written by the operator's own
   * proxies. Decides what `req.ip` is, and therefore what goes into `sessions.ip_hash` and what the
   * rate limiter counts against.
   */
  readonly trustedProxyHops: number;
}

/**
 * Everything `createHttpServer` is handed by the composition root.
 *
 * Use-cases and ports only: the application object is assembled from abstractions, so a controller
 * cannot reach a Prisma client even by accident, and the whole HTTP surface can be driven by
 * supertest with in-memory implementations behind it.
 */
/**
 * The authentication surface, as the HTTP layer sees it: use-cases, plus the two ports the guard
 * needs to resolve a refresh cookie on the one route whose contract accepts one.
 *
 * Grouped rather than spread across `HttpServerDependencies` so that "what does the auth surface
 * depend on" is one declaration, and so that a controller cannot reach a repository — everything
 * here is a use-case or a port (rules/hexagonal-backend.mdc).
 */
export interface IdentityDependencies {
  readonly register: RegisterOrganizationUseCase;
  readonly login: LoginUseCase;
  readonly refresh: RefreshSessionUseCase;
  readonly endSession: EndSessionUseCase;
  readonly changePassword: ChangePasswordUseCase;
  readonly requestPasswordReset: RequestPasswordResetUseCase;
  readonly confirmPasswordReset: ConfirmPasswordResetUseCase;
  readonly listSessions: ListSessionsQuery;
  readonly authenticate: AuthenticateSessionQuery;
  readonly authLookup: AuthLookupPort;
  readonly refreshTokens: RefreshTokenPort;
}

/**
 * The permission layer, as the HTTP surface needs it.
 *
 * `buildActor` is here rather than inside the guard because the guard is presentation and the read
 * is application: the capability view is rebuilt per request, so a role assigned a second ago
 * applies to the next request rather than to the next sign-in.
 */
export interface IamDependencies {
  readonly buildActor: BuildActorQuery;
  readonly getMyPermissions: GetMyPermissionsQuery;
  readonly assignRole: AssignRoleUseCase;
  readonly revokeRole: RevokeRoleUseCase;
  readonly writeOverride: WritePermissionOverrideUseCase;
  readonly removeOverride: RemovePermissionOverrideUseCase;
  readonly listRoles: ListRolesQuery;
  readonly previewChanges: PreviewRoleChangesQuery;
  readonly applyChanges: ApplyRoleChangesUseCase;
  readonly createRole: CreateCustomRoleUseCase;
  readonly updateRole: UpdateCustomRoleUseCase;
  readonly deleteRole: DeleteCustomRoleUseCase;
  readonly listInvitations: ListInvitationsQuery;
  readonly createInvitation: CreateInvitationUseCase;
  readonly resendInvitation: ResendInvitationUseCase;
  readonly revokeInvitation: RevokeInvitationUseCase;
  readonly acceptInvitation: AcceptInvitationUseCase;
  readonly transferOwnership: TransferOwnershipUseCase;
  readonly deactivateUser: DeactivateUserUseCase;
  readonly reactivateUser: ReactivateUserUseCase;
  readonly listEmployees: ListEmployeesQuery;
  readonly getOrgChart: GetOrgChartQuery;
  readonly readEmployeeProfile: ReadEmployeeProfileQuery;
  readonly writeEmployeeProfile: WriteEmployeeProfileUseCase;
  readonly listTeams: ListTeamsQuery;
  readonly getTeamDetail: GetTeamDetailQuery;
  readonly createTeam: CreateTeamUseCase;
  readonly updateTeam: UpdateTeamUseCase;
  readonly deleteTeam: DeleteTeamUseCase;
  readonly addTeamMember: AddTeamMemberUseCase;
  readonly removeTeamMember: RemoveTeamMemberUseCase;
}

export interface HttpServerDependencies {
  readonly config: HttpServerConfig;
  readonly logger: LoggerPort;
  readonly requestContext: RequestContextPort;
  readonly idGenerator: IdGeneratorPort;
  /** The `pino-http` completion-line middleware, built in `infrastructure/logging`. */
  readonly httpLogger: RequestHandler;
  /**
   * What the process publishes about itself, and the token that guards it.
   *
   * `undefined` when `METRICS_ENABLED` is off — the endpoint is then not mounted at all rather than
   * mounted and empty, so an installation that switched metrics off has no exposition surface to
   * find. The token is not optional beside it: the env schema refuses «enabled without a token»,
   * and this shape makes that refusal impossible to route around.
   */
  readonly metrics?: {
    /** Built in the container, like `httpLogger`: presentation receives adapters, never imports them. */
    readonly collector: RequestHandler;
    readonly port: MetricsPort;
    readonly token: string;
  };
  readonly checkHealth: CheckHealthUseCase;
  readonly checkReadiness: CheckReadinessUseCase;
  readonly describeApi: DescribeApiUseCase;
  readonly recordClientError: RecordClientErrorUseCase;
  readonly identity: IdentityDependencies;
  readonly iam: IamDependencies;
}
