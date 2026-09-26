import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import {
  type ProjectDetail,
  type ProjectRepositoryPort,
} from '@/application/project/ports/project-repository.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type ProjectAccessFacts } from '@/domain/project/access/project-access.policy.js';
import { type ProjectPermissions } from '@/domain/project/access/project-permissions.policy.js';

/** One project as the card reads it: the row, and what the caller may do to it. */
export interface ProjectCard extends ProjectDetail {
  readonly permissions: ProjectPermissions;
}

/**
 * The facts a **read** decides on — the row under `FOR SHARE` and the chain — read at most once,
 * however many decisions are made over them.
 *
 * The read counterpart of `projectWriteFacts`: `scope()` rather than `lockForWrite`, because a read
 * takes no write lock (`project-repository.port.ts`). Memoized because the card makes five decisions
 * over one project — may this caller read it, and the four flags of `decideProjectPermissions` — and
 * each would otherwise send its own pair of statements for an answer already held.
 */
export const projectReadFacts = (
  projects: ProjectRepositoryPort,
  acl: AclScopeResolver,
  actor: Actor,
  projectId: string,
): (() => Promise<ProjectAccessFacts>) => {
  let pending: Promise<ProjectAccessFacts> | undefined;

  const load = async (): Promise<ProjectAccessFacts> => ({
    scope: await projects.scope(projectId),
    acl: await acl.resolve(actor, { type: 'PROJECT', id: projectId }),
  });

  return () => {
    pending ??= load();

    return pending;
  };
};
