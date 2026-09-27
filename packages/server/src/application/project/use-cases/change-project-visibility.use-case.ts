import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { type ProjectRepositoryPort } from '@/application/project/ports/project-repository.port.js';
import { projectWriteFacts } from '@/application/project/project-write-facts.util.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { canManageProjectVisibility } from '@/domain/project/access/project-access.policy.js';
import { type ProjectVisibility } from '@/domain/project/project.enums.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';
import { ConfirmationRequiredError } from '@/domain/shared/errors/app.errors.js';

export interface ChangeProjectVisibilityInput {
  readonly actor: Actor;
  readonly ipAddress: string | undefined;
  readonly projectId: string;
  readonly visibility: ProjectVisibility;
  /** `X-Confirm-Dangerous: 1` was sent — the caller saw what the change does before repeating it. */
  readonly confirmedDangerous: boolean;
}

/**
 * `PUBLIC_ORG` ↔ `PRIVATE` — STORY-014-01, acceptance 7.
 *
 * **The confirmation comes after the decision, not before it.** A caller without the key or the
 * level is refused as every other write refuses them — 403 inside the contour, 404 outside — and
 * only a caller who *may* change the visibility is asked to say so twice (`428
 * confirmation_required`, the mechanism `write-custom-role.use-case.ts` uses for a dangerous key
 * in a role). The other order would let anybody learn from the 428 that they hold the right.
 *
 * Both directions are confirmed. `PUBLIC_ORG → PRIVATE` takes the project away from everybody in
 * the organization who is not on it, in one statement; `PRIVATE → PUBLIC_ORG` hands it to everybody
 * at once. The key is `dangerous` for the pair, and so is the confirmation.
 *
 * What the story asks the *screen* to show — how many colleagues lose access — is not computed
 * here: it is its own read, `PreviewProjectVisibilityQuery` (`GET …/visibility-impact`), asked under
 * the same key and level before the dialog is confirmed. A number in a 428 body would be a second
 * copy of it, and the client that shows the consequences never sees the 428.
 *
 * A repeat asking for the visibility already held is a no-op: no write, no confirmation demanded,
 * no entry — the state the caller wanted already holds.
 */
export class ChangeProjectVisibilityUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly projects: ProjectRepositoryPort,
    private readonly acl: AclScopeResolver,
    private readonly audit: AuditLoggerPort,
  ) {}

  execute(input: ChangeProjectVisibilityInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const facts = projectWriteFacts(this.projects, this.acl, input.actor, input.projectId);

        assertAllowed(await canManageProjectVisibility(input.actor, facts.read), 'project');

        const before = facts.locked();

        if (before.visibility === input.visibility) return;

        if (!input.confirmedDangerous) {
          throw new ConfirmationRequiredError({
            from: before.visibility,
            to: input.visibility,
          });
        }

        const changed = await this.projects.changeVisibility(input.projectId, input.visibility);

        if (!changed) throw denyAccess('project', 'other_organization');

        await this.audit.record({
          action: 'project.visibility_changed',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: input.ipAddress,
          },
          target: { type: 'PROJECT', id: input.projectId },
          before: { visibility: before.visibility },
          after: { visibility: input.visibility },
          requestId: undefined,
        });
      },
    );
  }
}
