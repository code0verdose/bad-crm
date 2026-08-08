import { type Logger } from 'pino';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type MailDispatchPort } from '@/application/platform/ports/mail-dispatch.port.js';
import { type MailPort } from '@/application/platform/ports/mail.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type ReadinessProbePort } from '@/application/platform/ports/readiness-probe.port.js';
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
import { CheckHealthUseCase } from '@/application/platform/use-cases/check-health.use-case.js';
import { CheckReadinessUseCase } from '@/application/platform/use-cases/check-readiness.use-case.js';
import { DescribeApiUseCase } from '@/application/platform/use-cases/describe-api.use-case.js';
import { APP_INFO } from '@/app-info.constant.js';
import { AsyncRequestContextAdapter } from '@/infrastructure/logging/async-request-context.adapter.js';
import { createHttpMetrics } from '@/infrastructure/metrics/http-metrics.middleware.js';
import { noopMetrics } from '@/infrastructure/metrics/noop-metrics.adapter.js';
import { RecordClientErrorUseCase } from '@/application/platform/use-cases/record-client-error.use-case.js';
import { pinoAuditLogger } from '@/infrastructure/logging/pino-audit.adapter.js';
import { PrismaAuditLogger } from '@/infrastructure/persistence/prisma/audit-log.adapter.js';
import { PrismaEffectivePermissionsReader } from '@/infrastructure/persistence/prisma/effective-permissions-reader.adapter.js';
import { PrismaUserRoleRepository } from '@/infrastructure/persistence/prisma/user-role.repository.js';
import { AssignRoleUseCase } from '@/application/iam/use-cases/assign-role.use-case.js';
import { BuildActorQuery } from '@/application/iam/use-cases/build-actor.query.js';
import { GetMyPermissionsQuery } from '@/application/iam/use-cases/get-my-permissions.query.js';
import { type AuthLookupPort } from '@/application/identity/ports/auth-lookup.port.js';
import { type SessionRepositoryPort } from '@/application/identity/ports/session-repository.port.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import { type FieldEncryptionPort } from '@/application/platform/ports/field-encryption.port.js';
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
import { ListInvitationsQuery } from '@/application/iam/use-cases/list-invitations.query.js';
import { ListRolesQuery } from '@/application/iam/use-cases/list-roles.query.js';
import {
  CreateInvitationUseCase,
  ResendInvitationUseCase,
  RevokeInvitationUseCase,
} from '@/application/iam/use-cases/write-invitation.use-case.js';
import {
  ApplyRoleChangesUseCase,
  PreviewRoleChangesQuery,
} from '@/application/iam/use-cases/write-role-changes.use-case.js';
import { DeleteCustomRoleUseCase } from '@/application/iam/use-cases/delete-custom-role.use-case.js';
import {
  CreateCustomRoleUseCase,
  UpdateCustomRoleUseCase,
} from '@/application/iam/use-cases/write-custom-role.use-case.js';
import { PrismaCustomRoleRepository } from '@/infrastructure/persistence/prisma/custom-role.repository.js';
import { RemovePermissionOverrideUseCase } from '@/application/iam/use-cases/remove-permission-override.use-case.js';
import { RevokeRoleUseCase } from '@/application/iam/use-cases/revoke-role.use-case.js';
import { WritePermissionOverrideUseCase } from '@/application/iam/use-cases/write-permission-override.use-case.js';
import { PrismaPermissionOverrideRepository } from '@/infrastructure/persistence/prisma/permission-override.repository.js';
import { createPromMetrics } from '@/infrastructure/metrics/prom-client.adapter.js';
import { createHttpLogger } from '@/infrastructure/logging/http-logger.middleware.js';
import { PinoLoggerAdapter } from '@/infrastructure/logging/pino-logger.adapter.js';
import { createMailer } from '@/infrastructure/mail/mail.factory.js';
import { ImmediateMailDispatcher } from '@/infrastructure/mail/immediate-mail-dispatcher.adapter.js';
import { optionalServiceProbes } from '@/infrastructure/platform/optional-service-probes.adapter.js';
import { ProcessHealthAdapter } from '@/infrastructure/platform/process-health.adapter.js';
import { ProcessLifecycleAdapter } from '@/infrastructure/platform/process-lifecycle.adapter.js';
import { SystemClockAdapter } from '@/infrastructure/platform/system-clock.adapter.js';
import { SystemIdGeneratorAdapter } from '@/infrastructure/platform/system-id-generator.adapter.js';
import { Argon2PasswordHasher } from '@/infrastructure/crypto/argon2-password-hasher.adapter.js';
import { HmacAddressHasher } from '@/infrastructure/crypto/address-hasher.adapter.js';
import { JwtAccessTokenAdapter } from '@/infrastructure/crypto/jwt-access-token.adapter.js';
import { Sha256RefreshTokenAdapter } from '@/infrastructure/crypto/refresh-token.adapter.js';
import { Sha256ResetTokenAdapter } from '@/infrastructure/crypto/reset-token.adapter.js';
import { type DbRoleProbeClient } from '@/infrastructure/persistence/prisma/assert-db-role.util.js';
import { PrismaAuthLookup } from '@/infrastructure/persistence/prisma/auth-lookup.adapter.js';
import { createAuthLookupClient } from '@/infrastructure/persistence/prisma/auth-lookup.client.js';
import { databaseReadinessProbe } from '@/infrastructure/persistence/prisma/database-readiness.adapter.js';
import { migrationReadinessProbe } from '@/infrastructure/persistence/prisma/migration-readiness.adapter.js';
import { shippedMigrationNames } from '@/infrastructure/persistence/prisma/shipped-migrations.util.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type DatabaseConnection } from '@/infrastructure/persistence/prisma/database.factory.js';
import {
  detachedAuthLookup,
  detachedUnitOfWork,
} from '@/infrastructure/persistence/prisma/detached-database.adapter.js';
import { ProvisionSystemRolesUseCase } from '@/application/iam/use-cases/provision-system-roles.use-case.js';
import { PrismaRoleRepository } from '@/infrastructure/persistence/prisma/role.repository.js';
import { AesFieldEncryption } from '@/infrastructure/crypto/field-encryption.adapter.js';
import { PrismaEmployeeDirectoryRepository } from '@/infrastructure/persistence/prisma/employee-directory.repository.js';
import { PrismaOwnershipRepository } from '@/infrastructure/persistence/prisma/ownership.repository.js';
import { PrismaUserLifecycleRepository } from '@/infrastructure/persistence/prisma/user-lifecycle.repository.js';
import { PrismaEmployeeProfileRepository } from '@/infrastructure/persistence/prisma/employee-profile.repository.js';
import { PrismaInvitationRepository } from '@/infrastructure/persistence/prisma/invitation.repository.js';
import { PrismaOrganizationRepository } from '@/infrastructure/persistence/prisma/organization.repository.js';
import { PrismaPasswordResetTokenRepository } from '@/infrastructure/persistence/prisma/password-reset-token.repository.js';
import { PrismaSessionRepository } from '@/infrastructure/persistence/prisma/session.repository.js';
import { PrismaUnitOfWork } from '@/infrastructure/persistence/prisma/unit-of-work.adapter.js';
import { PrismaUserRepository } from '@/infrastructure/persistence/prisma/user.repository.js';
import { detachedRateLimit } from '@/infrastructure/rate-limit/detached-rate-limit.adapter.js';
import { RedisRateLimiterAdapter } from '@/infrastructure/rate-limit/rate-limiter.adapter.js';
import { createRedisWindowLimiters } from '@/infrastructure/rate-limit/redis-window-limiter.factory.js';
import { redisReadinessProbe } from '@/infrastructure/redis/redis-readiness.adapter.js';
import { type RedisConnection } from '@/infrastructure/redis/redis.client.js';
import {
  assertAuthDatabaseRole,
  authDatabaseReadinessProbe,
} from '@/infrastructure/bootstrap/auth-database.util.js';
import {
  type AppContainer,
  type ShutdownStep,
  type StartupCheck,
} from '@/infrastructure/bootstrap/container.types.js';
import { type ServerEnv } from '@/infrastructure/bootstrap/env.schema.js';
import { API_VERSION } from '@/presentation/http/api-version.constant.js';
import {
  type IamDependencies,
  type IdentityDependencies,
} from '@/presentation/http/http-server.types.js';

/**
 * Where the migration folders live, relative to the working directory of the process.
 *
 * The assumption is explicit because it is a deployment assumption: the API runs with its own
 * package as the working directory — `tsx watch src/main.ts` under pnpm in development, `node
 * dist/main.js` from the same directory in an image. It is read only when there is a database to
 * check against, so the HTTP suite, which builds a container without one, never touches the disk.
 */
const MIGRATIONS_DIRECTORY = 'prisma/migrations';

export interface ContainerInput {
  readonly env: ServerEnv;
  /** The root pino instance; created before the container because the logger has no dependencies. */
  readonly logger: Logger;
  /**
   * Shared with the logger's mixin, so a line written inside a request carries its identifier.
   * Passing it in rather than creating it here keeps "one context per process" visible at the call
   * site instead of hidden in this function.
   */
  readonly requestContext?: AsyncRequestContextAdapter;
  /**
   * The open pool, when there is one.
   *
   * Optional because the HTTP suite builds the container to drive `/health` and `/ready` through
   * supertest and has no database to give it; a container without one simply registers no database
   * shutdown step. It is *not* optional for the process: `startApiProcess` always passes it, and
   * the adapters that need it are constructed here.
   */
  readonly database?: DatabaseConnection;
  /**
   * The open Redis connection, when there is one.
   *
   * Optional for the same reason as `database`, and with the same consequence: a container without
   * one gets `detachedRateLimit()`, which refuses every attempt instead of admitting it. `REDIS_URL`
   * is required by the env schema, so only a test builds a container this way.
   */
  readonly redis?: RedisConnection;
}

/**
 * The composition root proper: the only function that constructs concrete adapters and hands them
 * to use-cases.
 *
 * No DI container, by decision (rules/hexagonal-backend.mdc, rule 12 and ADR-0002): explicit
 * assembly is readable top to bottom, needs no decorators or reflection metadata, and makes a
 * dependency cycle a compile error rather than a runtime surprise. The price — a longer function as
 * the system grows — is paid in one file, which is exactly where it should be.
 *
 * It lives in `infrastructure/bootstrap` rather than in `main.ts` so that the whole wiring is
 * testable: `main.ts` is three lines that cannot be unit-tested, and everything worth asserting
 * about the process happens here and in `api-process.factory.ts`.
 */
export const buildContainer = (input: ContainerInput): AppContainer => {
  const requestContext = input.requestContext ?? new AsyncRequestContextAdapter();
  const logger = new PinoLoggerAdapter(input.logger);
  const clock = new SystemClockAdapter();
  const idGenerator = new SystemIdGeneratorAdapter();
  const lifecycle = new ProcessLifecycleAdapter();

  const checkHealth = new CheckHealthUseCase(new ProcessHealthAdapter(APP_INFO.version), clock);
  const describeApi = new DescribeApiUseCase(clock, API_VERSION);

  // Closed after the listener, never before: the shutdown handler drains in-flight requests first,
  // and a pool closed early turns a deploy into a burst of "connection closed" in the very requests
  // graceful shutdown exists to protect (rules/hexagonal-backend.mdc, rule 13).
  //
  // The steps are ordered at the end of this function rather than pushed as their subjects are
  // built, because the order *is* the behaviour: `createShutdownHandler` awaits them one after
  // another, in array order.
  const database = input.database;
  const shutdownSteps: ShutdownStep[] = [];

  // The limiter, and with it every authentication route's budget. Built here because this is the
  // only place that may know both the port and ioredis (STORY-006-07): the adapter existed, was
  // covered against a live server, and was constructed nowhere, which made every auth route
  // unbounded no matter how carefully the policy table was written.
  const rateLimit: RateLimitPort =
    input.redis === undefined
      ? detachedRateLimit()
      : new RedisRateLimiterAdapter(createRedisWindowLimiters(input.redis.client), logger);

  // The mailer, and with it the one operation of this epic that leaves the process. Built here
  // because this is the only place allowed to know both the port and nodemailer — and because the
  // adapter existed, was covered against a live Mailpit, and was constructed nowhere, which is the
  // same shape of defect the rate limiter had (STORY-006-08).
  const mailer = createMailer({
    smtpUrl: input.env.SMTP_URL,
    mailFrom: input.env.MAIL_FROM,
    logger,
  });
  const mailDispatcher = new ImmediateMailDispatcher(mailer, logger);

  /**
   * The audit trail: a row in `audit_logs`, written inside the transaction that caused it.
   *
   * The log line did not go away — it is where the events that cannot be rows are recorded, and
   * there are two kinds. `organization_id` is `NOT NULL`, so an action taken before any organization
   * is known has nowhere to be filed; and an action taken outside a tenant scope has no transaction
   * to join. Both are still part of the trail, and both are visibly *not* rows rather than quietly
   * missing.
   */
  const audit = new PrismaAuditLogger({
    addressHasher: new HmacAddressHasher(input.env.APP_ENCRYPTION_KEY),
    requestContext,
    unscoped: pinoAuditLogger(logger, clock),
  });

  const identity = buildIdentity({
    env: input.env,
    clock,
    idGenerator,
    logger,
    database,
    rateLimit,
    mail: mailer,
    mailDispatcher,
    audit,
  });

  const authClient = identity.authClient;

  // The second pool is verified before the port opens, for the reason `assert-db-role.util.ts`
  // gives about the first one: a connection made as the schema owner or as a superuser serves every
  // sign-in correctly and filters nothing, and this is the pool that skips row-level security by
  // design. Prisma connects lazily, so without this the first connection is made by the first
  // person to sign in — hours after the deploy, in the one operation nobody can work around.
  const startupChecks: StartupCheck[] =
    authClient === undefined
      ? []
      : [{ name: 'auth-database-role', run: () => assertAuthDatabaseRole(authClient) }];

  /**
   * A registry with default collectors, or nothing at all.
   *
   * `noopMetrics` rather than a flag at each call site: `collectDefaultMetrics` starts timers that
   * sample the event loop and the heap, and an installation that switched metrics off asked for
   * none of that. «The counter exists but nobody scrapes it» is not the same as off.
   */
  const metrics = input.env.METRICS_ENABLED ? createPromMetrics() : noopMetrics;

  const recordClientError = new RecordClientErrorUseCase(rateLimit, logger);

  const checkReadiness = new CheckReadinessUseCase(
    // `optionalServiceProbes` describes what this installation deliberately does not run; the live
    // probes sit beside it and are contributed by the clients that exist. Redis is live rather than
    // optional: with it unreachable the limiter refuses every sign-in, so an instance that cannot
    // reach it has to leave the load balancer's rotation. The `app_auth` pool is live for exactly
    // the same reason, and appears as `disabled` instead when there is none.
    //
    // Postgres is the pool every request works through, and until STORY-009-02 it was the one
    // dependency `/ready` never asked about: with it unreachable the process answered 200 and kept
    // its place in the rotation while every request inside it failed.
    [
      ...optionalServiceProbes(input.env),
      ...(input.database === undefined
        ? []
        : [
            databaseReadinessProbe(input.database.base),
            migrationReadinessProbe(
              input.database.base,
              shippedMigrationNames(MIGRATIONS_DIRECTORY),
            ),
          ]),
      ...(input.redis === undefined ? [] : [redisReadinessProbe(input.redis.client)]),
      ...(authClient === undefined ? [] : [authDatabaseReadinessProbe(authClient)]),
    ] satisfies readonly ReadinessProbePort[],
    lifecycle,
    clock,
    logger,
  );

  // Mail first, and the order is the point rather than a preference.
  //
  // A message handed over microseconds before SIGTERM is a password-reset link somebody is waiting
  // for, so it is drained before the transport is closed and both happen **before the pools**. The
  // steps used to be pushed in the order their subjects were constructed, which put mail after both
  // database pools — the exact opposite of what the comment claimed, and unnoticed because
  // `identity-wiring.test.ts` compared the names as a set and closed them with `Promise.all`.
  //
  // Today nothing breaks either way: the dispatcher only talks to nodemailer. It stops being free the
  // moment the outbox of ADR-0021 lands, because marking an event delivered is a write, and a write
  // against a closed pool turns a sent message into one that will be sent again.
  shutdownSteps.push({
    name: 'mail',
    close: async (): Promise<void> => {
      await mailDispatcher.drain();
      await mailer.close();
    },
  });

  if (database !== undefined) {
    shutdownSteps.push({ name: 'database', close: (): Promise<void> => database.close() });
  }

  if (identity.closeAuthLookup !== undefined) {
    shutdownSteps.push({ name: 'auth-database', close: identity.closeAuthLookup });
  }

  if (input.redis !== undefined) {
    const redis = input.redis;

    shutdownSteps.push({ name: 'redis', close: (): Promise<void> => redis.close() });
  }

  return {
    env: input.env,
    logger,
    lifecycle,
    shutdownSteps,
    startupChecks,
    http: {
      config: {
        appUrl: input.env.APP_URL,
        corsExtraOrigins: input.env.CORS_EXTRA_ORIGINS,
        storageEndpoint: input.env.S3_ENDPOINT,
        trustedProxyHops: input.env.TRUSTED_PROXY_HOPS,
      },
      logger,
      requestContext,
      idGenerator,
      httpLogger: createHttpLogger({ logger: input.logger, requestContext }),
      // Present only when this installation asked for metrics. `METRICS_TOKEN` is non-optional
      // beside the port because the env schema refuses «enabled without a token» — the pair either
      // exists whole or not at all, so no route can be mounted unprotected.
      ...(input.env.METRICS_ENABLED && input.env.METRICS_TOKEN !== undefined
        ? {
            metrics: {
              collector: createHttpMetrics(metrics),
              port: metrics,
              token: input.env.METRICS_TOKEN,
            },
          }
        : {}),
      checkHealth,
      checkReadiness,
      describeApi,
      recordClientError,
      identity: identity.dependencies,
      // The permission layer. Built here, beside identity, because it needs the same unit of work:
      // «who is this» and «what may they do» are two reads of the same transaction boundary.
      iam: buildIam({
        database: input.database,
        audit,
        identityKit: identity.identityKit,
        logger,
        clock,
        rateLimit,
        mail: mailer,
        mailDispatcher,
        appUrl: input.env.APP_URL,
        fields: new AesFieldEncryption(input.env.APP_ENCRYPTION_KEY),
      }),
    },
  };
};

interface IdentityWiring {
  readonly dependencies: IdentityDependencies;
  /**
   * The three pieces the IAM layer borrows to accept an invitation: it creates an account and opens
   * a session, which is identity's work done from a different door.
   *
   * Handed over rather than rebuilt: a second `Argon2PasswordHasher` would carry its own copy of the
   * cost parameters, and two of those drift the day one of them is tuned.
   */
  readonly identityKit: {
    readonly hasher: PasswordHasherPort;
    readonly issueSession: IssueSessionUseCase;
    readonly authLookup: AuthLookupPort;
    readonly sessions: SessionRepositoryPort;
  };
  /** Present only when a second pool was opened; registered as its own shutdown step. */
  readonly closeAuthLookup?: () => Promise<void>;
  /**
   * The second pool itself, when there is one, so the container can register its startup check and
   * its readiness probe. Absent means the installation has no `DATABASE_AUTH_URL`, and the
   * `authentication` entry of `/ready` comes from `optionalServiceProbes` as `disabled` instead.
   */
  readonly authClient?: DbRoleProbeClient;
}

/**
 * The authentication surface, assembled.
 *
 * Split out of `buildContainer` because it is the one part with a *conditional* shape: the ports
 * that need a connection get one when the process has a database and an explicit refusal when it
 * does not (`detached-database.adapter.ts`). Everything else — repositories, hashers, token
 * services — is constructed unconditionally, because a repository holds no client: it reads the
 * transaction out of the scope `withTenant` opened (`tenant-scoped.repository.ts`).
 */
/**
 * The permission layer of the HTTP surface.
 *
 * Three objects and no state: the actor query the guard mounts, and the two commands the assignment
 * routes call. They share the unit of work with identity for a reason — a role change and the trail
 * entry that records it have to be one transaction, and a second unit of work would be a second
 * transaction that can commit alone.
 */
const buildIam = (input: {
  readonly database: DatabaseConnection | undefined;
  readonly audit: AuditLoggerPort;
  readonly logger: LoggerPort;
  readonly identityKit: {
    readonly hasher: PasswordHasherPort;
    readonly issueSession: IssueSessionUseCase;
    readonly authLookup: AuthLookupPort;
    readonly sessions: SessionRepositoryPort;
  };
  readonly clock: SystemClockAdapter;
  readonly rateLimit: RateLimitPort;
  readonly mail: MailPort;
  readonly mailDispatcher: MailDispatchPort;
  readonly appUrl: string;
  /** Field-level encryption at rest — the emergency contact, and later every other `*_enc` column. */
  readonly fields: FieldEncryptionPort;
}): IamDependencies => {
  const unitOfWork =
    input.database === undefined ? detachedUnitOfWork() : new PrismaUnitOfWork(input.database.base);
  const userRoles = new PrismaUserRoleRepository();
  const permissions = new PrismaEffectivePermissionsReader();
  const overrides = new PrismaPermissionOverrideRepository();
  const customRoles = new PrismaCustomRoleRepository();
  const invitations = new PrismaInvitationRepository();
  const organizations = new PrismaOrganizationRepository();
  // The same 32 CSPRNG bytes and the same SHA-256 digest a password reset mints; an invitation link
  // is the same kind of credential, so it is not a second implementation of one.
  const inviteTokens = new Sha256ResetTokenAdapter();
  const employeeProfiles = new PrismaEmployeeProfileRepository();
  const employeeDirectory = new PrismaEmployeeDirectoryRepository();
  const userLifecycle = new PrismaUserLifecycleRepository();
  const ownership = new PrismaOwnershipRepository();

  const buildActor = new BuildActorQuery(unitOfWork, permissions);

  return {
    buildActor,
    getMyPermissions: new GetMyPermissionsQuery(buildActor),
    assignRole: new AssignRoleUseCase(unitOfWork, userRoles, input.audit),
    revokeRole: new RevokeRoleUseCase(unitOfWork, userRoles, input.audit),
    writeOverride: new WritePermissionOverrideUseCase(
      unitOfWork,
      overrides,
      permissions,
      userRoles,
      input.audit,
    ),
    removeOverride: new RemovePermissionOverrideUseCase(
      unitOfWork,
      overrides,
      permissions,
      userRoles,
      input.audit,
    ),
    listRoles: new ListRolesQuery(unitOfWork, customRoles),
    previewChanges: new PreviewRoleChangesQuery(unitOfWork, customRoles),
    applyChanges: new ApplyRoleChangesUseCase(unitOfWork, customRoles, input.audit),
    createRole: new CreateCustomRoleUseCase(unitOfWork, customRoles, input.audit),
    updateRole: new UpdateCustomRoleUseCase(unitOfWork, customRoles, input.audit),
    deleteRole: new DeleteCustomRoleUseCase(unitOfWork, customRoles, input.audit),
    listInvitations: new ListInvitationsQuery(unitOfWork, invitations),
    createInvitation: new CreateInvitationUseCase(
      unitOfWork,
      invitations,
      organizations,
      inviteTokens,
      input.clock,
      input.audit,
      input.rateLimit,
      input.mail,
      input.mailDispatcher,
      input.appUrl,
    ),
    resendInvitation: new ResendInvitationUseCase(
      unitOfWork,
      invitations,
      organizations,
      inviteTokens,
      input.clock,
      input.audit,
      input.rateLimit,
      input.mail,
      input.mailDispatcher,
      input.appUrl,
    ),
    revokeInvitation: new RevokeInvitationUseCase(unitOfWork, invitations, input.audit),
    acceptInvitation: new AcceptInvitationUseCase(
      input.identityKit.authLookup,
      invitations,
      userRoles,
      organizations,
      input.identityKit.issueSession,
      input.identityKit.hasher,
      inviteTokens,
      unitOfWork,
      input.rateLimit,
      input.clock,
      input.logger,
      input.audit,
    ),
    transferOwnership: new TransferOwnershipUseCase(unitOfWork, ownership, input.audit),
    deactivateUser: new DeactivateUserUseCase(
      unitOfWork,
      userLifecycle,
      input.identityKit.sessions,
      permissions,
      input.audit,
      input.clock,
    ),
    reactivateUser: new ReactivateUserUseCase(unitOfWork, userLifecycle, permissions, input.audit),
    listEmployees: new ListEmployeesQuery(unitOfWork, employeeDirectory),
    getOrgChart: new GetOrgChartQuery(unitOfWork, employeeDirectory),
    readEmployeeProfile: new ReadEmployeeProfileQuery(unitOfWork, employeeProfiles, input.fields),
    writeEmployeeProfile: new WriteEmployeeProfileUseCase(
      unitOfWork,
      employeeProfiles,
      input.fields,
      input.audit,
    ),
  };
};

const buildIdentity = (input: {
  readonly env: ServerEnv;
  readonly clock: SystemClockAdapter;
  readonly idGenerator: SystemIdGeneratorAdapter;
  readonly logger: LoggerPort;
  readonly database: DatabaseConnection | undefined;
  readonly rateLimit: RateLimitPort;
  readonly mail: MailPort;
  readonly mailDispatcher: MailDispatchPort;
  readonly audit: AuditLoggerPort;
}): IdentityWiring => {
  const unitOfWork =
    input.database === undefined ? detachedUnitOfWork() : new PrismaUnitOfWork(input.database.base);

  const authClient =
    input.env.DATABASE_AUTH_URL === undefined || input.database === undefined
      ? undefined
      : createAuthLookupClient(input.env.DATABASE_AUTH_URL);

  const authLookup =
    authClient === undefined ? detachedAuthLookup() : new PrismaAuthLookup(authClient);

  const organizations = new PrismaOrganizationRepository();
  const users = new PrismaUserRepository();
  const sessions = new PrismaSessionRepository();
  const resetTokenRows = new PrismaPasswordResetTokenRepository();

  const hasher = new Argon2PasswordHasher({
    memoryCost: input.env.ARGON2_MEMORY_COST,
    timeCost: input.env.ARGON2_TIME_COST,
    parallelism: input.env.ARGON2_PARALLELISM,
  });
  const refreshTokens = new Sha256RefreshTokenAdapter();
  const resetTokens = new Sha256ResetTokenAdapter();
  const accessTokens = new JwtAccessTokenAdapter(input.env.JWT_SECRET, input.clock);
  const addresses = new HmacAddressHasher(input.env.APP_ENCRYPTION_KEY);

  const issueSession = new IssueSessionUseCase(
    sessions,
    organizations,
    refreshTokens,
    accessTokens,
    addresses,
    input.clock,
    input.idGenerator,
  );

  const bootstrap = new BootstrapOrganizationUseCase(
    unitOfWork,
    organizations,
    input.idGenerator,
    new ProvisionSystemRolesUseCase(new PrismaRoleRepository()),
  );

  const dependencies: IdentityDependencies = {
    register: new RegisterOrganizationUseCase(
      bootstrap,
      hasher,
      unitOfWork,
      issueSession,
      { locale: 'en', timezone: 'UTC', currency: 'USD' },
      input.env.REGISTRATION_OPEN,
      input.rateLimit,
      input.audit,
    ),
    login: new LoginUseCase(
      authLookup,
      hasher,
      users,
      unitOfWork,
      issueSession,
      input.rateLimit,
      input.logger,
      input.audit,
    ),
    refresh: new RefreshSessionUseCase(
      authLookup,
      refreshTokens,
      sessions,
      users,
      organizations,
      unitOfWork,
      issueSession,
      input.clock,
      input.logger,
      input.rateLimit,
    ),
    changePassword: new ChangePasswordUseCase(
      users,
      sessions,
      resetTokenRows,
      hasher,
      unitOfWork,
      input.rateLimit,
      input.mailDispatcher,
      input.clock,
      input.logger,
      input.audit,
      input.env.APP_URL,
    ),
    requestPasswordReset: new RequestPasswordResetUseCase(
      authLookup,
      resetTokenRows,
      resetTokens,
      addresses,
      unitOfWork,
      input.rateLimit,
      input.mail,
      input.mailDispatcher,
      input.clock,
      input.logger,
      input.env.APP_URL,
    ),
    confirmPasswordReset: new ConfirmPasswordResetUseCase(
      authLookup,
      resetTokenRows,
      resetTokens,
      users,
      sessions,
      hasher,
      unitOfWork,
      input.rateLimit,
      input.clock,
      input.logger,
      input.audit,
    ),
    endSession: new EndSessionUseCase(sessions, unitOfWork, input.clock, input.logger, input.audit),
    listSessions: new ListSessionsQuery(sessions, unitOfWork, input.clock),
    authenticate: new AuthenticateSessionQuery(accessTokens, sessions, unitOfWork, input.clock),
    authLookup,
    refreshTokens,
  };

  // `sessions` travels with the kit because offboarding revokes them: the account status, the
  // permission version and every live session have to change in **one** transaction, and a second
  // repository instance built in `buildIam` would be a second connection to co-ordinate.
  const identityKit = { hasher, issueSession, authLookup, sessions };

  return authClient === undefined
    ? { dependencies, identityKit }
    : {
        dependencies,
        identityKit,
        closeAuthLookup: (): Promise<void> => authClient.$disconnect(),
        authClient,
      };
};
