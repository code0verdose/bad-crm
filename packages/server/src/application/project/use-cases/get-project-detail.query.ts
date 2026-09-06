import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import {
  type ProjectDetail,
  type ProjectRepositoryPort,
} from '@/application/project/ports/project-repository.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import {
  assertProjectAddressable,
  canReadProject,
  type ProjectAccessFacts,
} from '@/domain/project/access/project-access.policy.js';

export interface GetProjectDetailInput {
  readonly actor: Actor;
  readonly projectId: string;
}

/**
 * One project, as the detail screen reads it — the first read the resource layer of the model
 * has (`docs/security/permission-model.md` §7 (в); STORY-011-07, acceptance 3 and 4, the resource
 * halves).
 *
 * **The order of the reads is the point of this class.** The capability is decided before anything
 * is sent; the scope and the chain are read next, and the policy decides on them; the entity is
 * read **last**, and only for a caller the policy let through. A caller without `project:read`,
 * a foreign id, a `PRIVATE` project they are not on — none of these ever causes `detail()` to be
 * sent, so a refusal carries nothing of the row and a caller without the key sends no statement
 * about the project — only the transaction `withTenant` opens, as every query in this tree does
 * (`docs/security/permission-model.md` §5; the trace is held by
 * `get-project-detail.query.test.ts` and the statements by
 * `test/integration/db/project-read-access.test.ts`).
 *
 * **Both facts are read whether or not the first one found a row.** A `scope()` that answered
 * `null` could spare the resolver its reads, and deliberately does not: the decision would then be
 * split between this class and the policy, with a `null` check here that is a 404 in disguise. What
 * the resolver itself spares — the chain query, once its reader found no row — is its own documented
 * behaviour, and the integration suite records the resulting counts (2, 2, 3, 4) rather than
 * claiming they are equal.
 *
 * `scope()` reads under `FOR SHARE`, and the lock is held to the end of this transaction. It is
 * spent on a read on purpose: the row the policy decided on is the row `detail()` returns, and a
 * `softDelete` racing this request waits rather than landing in between.
 *
 * `scope()` is a repository read, not an access reader, and it fails the way `detail()` fails — a
 * 500, like every repository in this tree. Only the resolver answers a failed read as
 * `unavailable` → 503, because «we could not check the chain» is a statement about authorization
 * and not about the row; a failed `scope()` is the second, and is not dressed up as the first.
 */
export class GetProjectDetailQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly projects: ProjectRepositoryPort,
    private readonly acl: AclScopeResolver,
  ) {}

  execute(input: GetProjectDetailInput): Promise<ProjectDetail> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        assertAllowed(
          await canReadProject(input.actor, () => this.facts(input.actor, input.projectId)),
          'project',
        );

        const detail = await this.projects.detail(input.projectId);

        // Unreachable on a real database — `scope()` holds the row under `FOR SHARE` — and still
        // the same 404 rather than a `null` the compiler would let through.
        assertProjectAddressable(detail);

        return detail;
      },
    );
  }

  private async facts(actor: Actor, projectId: string): Promise<ProjectAccessFacts> {
    return {
      scope: await this.projects.scope(projectId),
      acl: await this.acl.resolve(actor, { type: 'PROJECT', id: projectId }),
    };
  }
}
