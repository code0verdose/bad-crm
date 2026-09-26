import { SharedPermissions } from '@bad-crm/shared';

import { type AclReaderPort } from '@/application/access/ports/acl-reader.port.js';
import { type ProjectAccessReaderPort } from '@/application/access/ports/project-access-reader.port.js';
import { type ResolvableAclResourceType } from '@/application/access/resolvable-acl-resource-types.constant.js';
import { type ClockPort } from '@/application/platform/ports/clock.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type AclChainNode, type AclResourceRef } from '@/domain/access/acl-chain.types.js';
import { resolveFromChain } from '@/domain/access/acl-resolution.policy.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type AclScope } from '@/domain/access/authorize.util.js';
import { implicitLevel, type ImplicitLevelFacts } from '@/domain/access/implicit-level.policy.js';

/**
 * What a command needs from the resolver: one scope for one object, for `authorizeResource`.
 *
 * An interface rather than the class, so a use-case is built over the seam and not over the
 * registry of chains — the doubles in the use-case suites answer a scope and nothing else.
 */
export interface AclScopeResolver {
  resolve(actor: Actor, ref: AclResourceRef): Promise<AclScope>;
}

export interface ResolveAclDependencies {
  readonly acl: AclReaderPort;
  readonly projects: ProjectAccessReaderPort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
}

/**
 * The ancestor chain of one object, and the facts the implicit table reads about it — or `null`
 * when the object is not there.
 */
interface ResolvedChain {
  readonly organizationId: string;
  readonly nodes: readonly AclChainNode[];
  readonly facts: ImplicitLevelFacts;
}

type ChainBuilder = (actor: Actor, id: string) => Promise<ResolvedChain | null>;

/**
 * `resolveAcl` of the model: the object's chain, the entries on it, the level — as one `AclScope`
 * for `authorizeResource` to judge (`docs/security/permission-model.md`, «Наследование ACL»).
 *
 * **A registry of chains, one per kind of object, and only the kinds that have one.** Today that
 * is two: the organization (one node — it is the root of every chain) and the project
 * (`PROJECT → ORGANIZATION`). The registry is the seam the next domains grow through: a board adds
 * an entry that reads `Board.projectId` and, when that is `NULL`, builds `BOARD → ORGANIZATION`
 * directly — the fork `data-model.md` («Про `Board.projectId?`») requires the resolver to take
 * rather than assume a project. A type with no entry answers `unavailable`, not a level: the object
 * may exist, the server cannot answer about it, and a 503 says so (`rules/permissions.mdc`, 6).
 *
 * **Two refusals are decided here, and neither is a level.**
 *
 * - `missing` — the object is not there, is deleted, or is another organization's. One answer for
 *   the three, because a caller must not learn which (invariant 2). It is also the answer to a
 *   **broken chain** (acceptance 9): a parent that has gone is `null` from the reader, and «resolve
 *   by the organization instead» is the one thing this must never do — so the walk stops at the
 *   first `null`, logs the id, and answers 404.
 * - `unavailable` — a reader threw, whichever of the two: the chain builder's query or the
 *   entries query. «We could not check» is not «no access» and it is not «probably fine» either;
 *   `authorizeResource` turns it into `acl_resolution_failed` and a 503.
 *
 * **The owner is not looked at here.** Rule 5 (`MANAGER` without a walk, except the vault) is
 * `authorizeResource`'s, the one place that also knows the family — so this function reads the
 * chain for the owner as for anybody, and the caller clears it. The cost is one query the owner
 * does not need; the alternative is a second copy of the vault exception.
 *
 * A `*.query.ts` in the sense of `rules/hexagonal-backend.mdc` 7: it reads, opens no transaction of
 * its own, and runs inside the scope the calling use-case opened.
 */
export class ResolveAclQuery implements AclScopeResolver {
  private readonly chains: Partial<Record<SharedPermissions.AclResourceType, ChainBuilder>>;

  constructor(private readonly dependencies: ResolveAclDependencies) {
    // Total over the resolvable list, so the list and the registry cannot drift: the validator of
    // `/acl` whitelists `resourceType` from the same constant.
    const registry: Record<ResolvableAclResourceType, ChainBuilder> = {
      ORGANIZATION: (actor, id) => this.organizationChain(actor, id),
      PROJECT: (actor, id) => this.projectChain(actor, id),
    };

    this.chains = registry;
  }

  async resolve(actor: Actor, ref: AclResourceRef): Promise<AclScope> {
    const build = this.chains[ref.type];

    if (build === undefined) {
      this.dependencies.logger.warn(
        { resourceType: ref.type, resourceId: ref.id },
        'acl chain not registered for resource type',
      );

      return { status: 'unavailable' };
    }

    // Both reads sit inside one `try`: the chain builder is a reader too (`projects.aclFacts` is
    // a query), and a timeout there means the same thing a timeout on `entriesAlong` means. Two
    // different answers to one failure — 500 for the first read, 503 for the second — would make
    // the two halves of a resolution disagree about what «we could not check» is.
    try {
      const chain = await build(actor, ref.id);

      if (chain === null) {
        this.dependencies.logger.warn(
          { resourceType: ref.type, resourceId: ref.id },
          'acl chain broken: resource not found',
        );

        return { status: 'missing' };
      }

      const entries = await this.dependencies.acl.entriesAlong(chain.nodes, actor.userId);
      const implicit = implicitLevel(actor, chain.facts);

      return {
        status: 'resolved',
        organizationId: chain.organizationId,
        level: resolveFromChain(entries, implicit, this.dependencies.clock.now()),
        family: SharedPermissions.ACL_RESOURCE_FAMILY[ref.type],
      };
    } catch (error) {
      this.dependencies.logger.warn(
        { resourceType: ref.type, resourceId: ref.id, err: error },
        'acl resolution failed',
      );

      return { status: 'unavailable' };
    }
  }

  /**
   * The root: one node, and no reader to ask — the only organization an actor may resolve is their
   * own, so any other id is «not there» before a query is spent on it.
   */
  private organizationChain(actor: Actor, id: string): Promise<ResolvedChain | null> {
    if (id !== actor.organizationId) return Promise.resolve(null);

    return Promise.resolve({
      organizationId: actor.organizationId,
      nodes: [{ depth: 0, type: 'ORGANIZATION', id }],
      facts: { resourceType: 'ORGANIZATION' },
    });
  }

  private async projectChain(actor: Actor, id: string): Promise<ResolvedChain | null> {
    const facts = await this.dependencies.projects.aclFacts(id, actor.userId);

    if (facts === null) return null;

    return {
      organizationId: facts.organizationId,
      nodes: [
        { depth: 0, type: 'PROJECT', id },
        { depth: 1, type: 'ORGANIZATION', id: facts.organizationId },
      ],
      facts: {
        resourceType: 'PROJECT',
        visibility: facts.visibility,
        memberRole: facts.memberRole,
      },
    };
  }
}
