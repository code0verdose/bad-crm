import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type PasswordHasherPort } from '@/application/identity/ports/password-hasher.port.js';
import {
  type IssuedSession,
  type IssueSessionUseCase,
  type SessionClient,
} from '@/application/identity/use-cases/issue-session.use-case.js';
import {
  type SessionOrganization,
  type SessionProfile,
} from '@/application/identity/use-cases/login.use-case.js';
import { type BootstrapOrganizationUseCase } from '@/application/organization/use-cases/bootstrap-organization.use-case.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { isWeakPassword } from '@/domain/identity/weak-password.util.js';
import {
  AccountRefusedError,
  RateLimitedError,
  ValidationError,
} from '@/domain/shared/errors/app.errors.js';

export interface RegisterOrganizationInput {
  readonly organization: {
    readonly name: string;
    readonly slug: string;
  };
  readonly owner: {
    readonly email: string;
    readonly password: string;
    readonly locale?: string;
    readonly timezone?: string;
  };
  readonly client: SessionClient;
}

export interface RegisterOrganizationResult {
  readonly session: IssuedSession;
  readonly user: SessionProfile;
  readonly organization: SessionOrganization;
}

/** Defaults of the installation, applied when the form leaves the two optional fields out. */
export interface RegistrationDefaults {
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
}

/**
 * The first door of an empty installation: an organization, its owner, and a session in one call.
 *
 * The tenancy half — one transaction for the organization, the owner and the system roles — belongs
 * to `BootstrapOrganizationUseCase` and stays there. What this adds is everything that is about
 * *authentication* rather than about tenancy: the installation-wide switch, the password policy, the
 * digest, and the session the person ends up holding.
 *
 * **The session is written in a second transaction, deliberately.** "Neither, or both" is a property
 * the acceptance criterion asks for over the organization, the owner and the roles — a half-created
 * tenant is unusable. A session is not in that set: if it fails, an organization and an owner exist
 * and the person signs in. Stretching one transaction over both would only widen the window in which
 * the tenant root is locked.
 */
export class RegisterOrganizationUseCase {
  constructor(
    private readonly bootstrap: BootstrapOrganizationUseCase,
    private readonly hasher: PasswordHasherPort,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly issueSession: IssueSessionUseCase,
    private readonly defaults: RegistrationDefaults,
    /**
     * Whether this installation accepts new organizations through the form.
     *
     * A self-hosted install is normally one organization created once, and an endpoint left open
     * afterwards is an anonymous visitor with a `CREATE` statement (`docs/api/openapi.yaml`,
     * `RegistrationDisabled`).
     */
    private readonly registrationOpen: boolean,
    private readonly rateLimit: RateLimitPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: RegisterOrganizationInput): Promise<RegisterOrganizationResult> {
    // First, and before anything is read or written: the answer must not depend on the address, the
    // slug, or on whether either already exists.
    //
    // Before the budget, too. A closed installation refuses without reading, writing or hashing
    // anything, so spending an attempt on it would only let a form left open in a browser tab lock
    // its owner out of an endpoint that does nothing.
    if (!this.registrationOpen) throw new AccountRefusedError('registration_disabled');

    // Three an hour from one address (`docs/architecture/stack.md` → «Rate limiting», threat model
    // T-TENANT-07). Spent before the argon2id digest below, which is the expensive part and would
    // otherwise be an anonymous visitor's way to allocate 19 MiB per request — and before the
    // transaction that creates a tenant, which is the durable half of the same problem.
    const decision = await this.rateLimit.consume('organization_registration', {
      ipAddress: input.client.ipAddress,
    });

    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds);

    // The half of the password policy `passwordSchema` deliberately leaves to the use-case, which is
    // the layer that can also rate-limit it. Reported as `validation_failed` on the field, exactly
    // like a password that is too short: from the person's side it is the same problem, and a
    // distinct code would tell somebody which of their guesses was nearly acceptable.
    if (isWeakPassword(input.owner.password)) {
      throw new ValidationError([
        {
          path: 'owner.password',
          code: 'custom',
          message: 'Password is a known weak pattern',
        },
      ]);
    }

    const locale = input.owner.locale ?? this.defaults.locale;
    const timezone = input.owner.timezone ?? this.defaults.timezone;

    const { organizationId, ownerId } = await this.bootstrap.execute({
      organization: {
        name: input.organization.name,
        slug: input.organization.slug,
        timezone,
        defaultCurrency: this.defaults.currency,
      },
      owner: {
        email: input.owner.email,
        // The only place the plaintext exists in this use-case, and it does not leave this call.
        passwordHash: await this.hasher.hash(input.owner.password),
        locale,
        timezone,
      },
    });

    const session = await this.unitOfWork.withTenant(
      { organizationId, userId: ownerId },
      async () => {
        const issued = await this.issueSession.execute({
          userId: ownerId,
          // A brand-new account: the version the column defaults to.
          permissionsVersion: 1,
          client: input.client,
        });

        // Inside the transaction, like every other privileged action: an organization created with
        // no record of who created it is the one row an operator can least afford to find
        // unexplained. The slug goes in `after`, the password does not — «after» carries what
        // changed, never a credential.
        await this.audit.record({
          action: 'organization.registered',
          actor: {
            userId: ownerId,
            organizationId,
            ipAddress: input.client.ipAddress,
          },
          target: { type: 'ORGANIZATION', id: organizationId },
          after: { slug: input.organization.slug, name: input.organization.name },
          requestId: undefined,
        });

        return issued;
      },
    );

    return {
      session,
      user: { id: ownerId, email: input.owner.email, locale, timezone },
      organization: {
        id: organizationId,
        name: input.organization.name,
        slug: input.organization.slug,
      },
    };
  }
}
