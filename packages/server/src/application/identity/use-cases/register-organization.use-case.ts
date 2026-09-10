import { SharedValidation } from '@bad-crm/shared';

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
import {
  AccountRefusedError,
  RateLimitedError,
  ValidationError,
} from '@/domain/shared/errors/app.errors.js';
import { refundingHashRefusals } from '@/application/platform/rate-limit/hash-refusal-refund.util.js';

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
 *
 * **The audit record is in the first transaction, not the second — and that follows from the
 * paragraph above.** The trail is written into the transaction that is open (`audit-log.adapter.ts`),
 * so a record made beside the session would exist exactly when the session did; a session is
 * allowed to fail and leave the tenant standing, and the record must not be. Until 2026-09-06 it
 * was beside the session, and an installation whose first session insert failed had an organization
 * with no `organization.registered` row. `BootstrapOrganizationUseCase.inSameTransaction` is the
 * seam: the record is written after the roles, with the owner's id.
 *
 * **The place is necessary and not sufficient: «rolls back with the tenant» is decided by the
 * severity of the action, not by this call site.** The writer fences an `INFO` row behind no
 * dangerous key in a savepoint and the decorator above it swallows the failure
 * (`degradable-audit-actions.util.ts`) — so while `organization.registered` was `INFO`, a refused
 * insert here rolled back to the savepoint, was reported as a log line, and the tenant committed
 * without its row, exactly as if the record had never been moved. Every double in the unit suites
 * rejects, so none of them could see it. The action is `WARNING` since 2026-09-10
 * (`audit-severity.enums.ts`), which is what makes a failed row abort this transaction; the chain
 * as the process wires it is proved in `test/integration/db/registration-audit-atomicity.test.ts`.
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
    if (SharedValidation.isWeakPassword(input.owner.password)) {
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

    // The hourly point is returned if the argon2 queue refuses the digest below. Three an hour is
    // the thinnest budget of any path that hashes, so three refusals during one load spike cost a
    // team the whole hour — for a registration that never reached the hasher
    // (`hash-refusal-refund.util.ts`).
    const { organizationId, ownerId } = await refundingHashRefusals(
      this.rateLimit,
      'organization_registration',
      { ipAddress: input.client.ipAddress },
      async () =>
        await this.bootstrap.execute({
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
          // Inside the transaction that creates the tenant, like every other privileged action —
          // and not the one below, which may fail without undoing the tenant. An organization
          // created with no record of who created it is the one row an operator can least afford
          // to find unexplained — and being in this transaction only *lets* a failed row undo the
          // tenant; that it *does* is the action's `WARNING` severity, which the writer never
          // degrades (`audit-severity.enums.ts`). The slug goes in `after`, the password does not —
          // «after» carries what changed, never a credential.
          inSameTransaction: async (created) => {
            await this.audit.record({
              action: 'organization.registered',
              actor: {
                userId: created.ownerId,
                organizationId: created.organizationId,
                ipAddress: input.client.ipAddress,
              },
              target: { type: 'ORGANIZATION', id: created.organizationId },
              after: { slug: input.organization.slug, name: input.organization.name },
              requestId: undefined,
            });
          },
        }),
    );

    const session = await this.unitOfWork.withTenant({ organizationId, userId: ownerId }, () =>
      this.issueSession.execute({
        userId: ownerId,
        // A brand-new account: the version the column defaults to.
        permissionsVersion: 1,
        client: input.client,
      }),
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
