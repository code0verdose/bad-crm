import { type ProjectAudienceAccessReaderPort } from '@/application/access/ports/project-audience-access-reader.port.js';
import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { actorFromFacts } from '@/application/iam/actor-from-facts.util.js';
import { type EffectivePermissionsReaderPort } from '@/application/iam/ports/effective-permissions-reader.port.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type ProjectRepositoryPort } from '@/application/project/ports/project-repository.port.js';
import { projectReadFacts } from '@/application/project/project-card.util.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  assertProjectAddressable,
  canManageProjectVisibility,
} from '@/domain/project/access/project-access.policy.js';
import {
  type ProjectAudienceSeat,
  type VisibilityImpact,
  visibilityImpact,
} from '@/domain/project/access/visibility-impact.policy.js';
import { type ProjectVisibility } from '@/domain/project/project.enums.js';

export interface PreviewProjectVisibilityInput {
  readonly actor: Actor;
  readonly projectId: string;
  /** The visibility the caller is about to confirm. */
  readonly visibility: ProjectVisibility;
}

/**
 * What a change of visibility would do, before it is confirmed — how many colleagues lose the
 * project and how many gain it (STORY-014-01, acceptance 7: «сводка показывает, сколько сотрудников
 * потеряет доступ»).
 *
 * **Asked under the command's own decision.** `canManageProjectVisibility` — `project:manage_visibility`
 * and `MANAGER` on the chain — over the same read facts the card decides on: whoever may not change
 * the visibility may not learn what the change would do, and every outsider is the same 404 as on
 * the card. Nothing about the audience is read before that decision holds.
 *
 * **Decided per colleague by the read decision, not counted by a second rule.** The audience reader
 * brings every active account with its seat and the grants that reach it; each becomes the actor it
 * would be on its own request (`actorFromFacts`, the fold `BuildActorQuery` uses) and
 * `visibilityImpact` asks `canReadProject` for it under both visibilities. Explicit grants, seats,
 * the owner, guests and DENY exceptions are therefore not cases of this class — they are what the
 * policy already answers. Suspended and invited accounts are not in the audience at all.
 *
 * A preview of the visibility already held moves nobody and costs no read of the audience.
 *
 * Reads only; the transaction is the one `withTenant` opens for every query in this tree.
 */
export class PreviewProjectVisibilityQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly projects: ProjectRepositoryPort,
    private readonly acl: AclScopeResolver,
    private readonly audience: ProjectAudienceAccessReaderPort,
    private readonly capabilities: EffectivePermissionsReaderPort,
    private readonly clock: ClockPort,
  ) {}

  execute(input: PreviewProjectVisibilityInput): Promise<VisibilityImpact> {
    const { actor } = input;

    return this.unitOfWork.withTenant(
      { organizationId: actor.organizationId, userId: actor.userId },
      async () => {
        const facts = projectReadFacts(this.projects, this.acl, actor, input.projectId);

        assertAllowed(await canManageProjectVisibility(actor, facts), 'project');

        const { scope } = await facts();

        // Unreachable once the policy allowed — it refuses a missing or deleted row — and still the
        // same 404 rather than a `null` the compiler would let through.
        assertProjectAddressable(scope);

        if (scope.visibility === input.visibility) return { losingAccess: 0, gainingAccess: 0 };

        const seats = await this.audience.seatsOf(input.projectId);
        const grants = await this.audience.grantsOn(input.projectId);
        const folded = await this.capabilities.capabilitiesOfMany(seats.map((seat) => seat.userId));

        const audience = seats.flatMap((seat): ProjectAudienceSeat[] => {
          const capability = folded.get(seat.userId);

          return capability === undefined
            ? []
            : [
                {
                  actor: actorFromFacts(seat.userId, actor.organizationId, capability),
                  memberRole: seat.memberRole,
                  entries: grants
                    .filter((grant) => grant.userId === seat.userId)
                    .map(({ depth, level, expiresAt }) => ({ depth, level, expiresAt })),
                },
              ];
        });

        return visibilityImpact(
          audience,
          {
            projectId: input.projectId,
            organizationId: actor.organizationId,
            visibility: scope.visibility,
          },
          input.visibility,
          this.clock.now(),
        );
      },
    );
  }
}
