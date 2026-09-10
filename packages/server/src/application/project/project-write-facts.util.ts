import { type AclScopeResolver } from '@/application/access/use-cases/resolve-acl.query.js';
import { type ProjectRepositoryPort } from '@/application/project/ports/project-repository.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import {
  assertProjectAddressable,
  type ProjectAccessFacts,
} from '@/domain/project/access/project-access.policy.js';
import { type ProjectSummary } from '@/domain/project/project.entity.js';

/**
 * The facts a **write** decides on, read once per command and handed to the policy as a function.
 *
 * Every mutation of a project starts the same way: the row under `FOR UPDATE`, then the chain —
 * both read only once the capability holds, because `decideProjectAccess` invokes `read` only then
 * (STORY-011-07, acceptance 3). Two properties are held here and nowhere else:
 *
 * - **the lock is the write lock.** `lockForWrite`, never `scope()`: a writer that took the share
 *   lock and then updated would deadlock against a second writer doing the same
 *   (`project-repository.port.ts`, `lockForWrite`);
 * - **the facts are read once, however many decisions a command makes.** `UpdateProjectUseCase`
 *   asks two questions of the same row — may this caller edit, and may they hand the lead over —
 *   and a second `lockForWrite` would be a second statement for an answer already held. `read` is
 *   memoized, and `locked()` hands the same row back to the command as its audit `before`.
 *
 * Both facts are read whether or not the row was found, for the reason `get-project-detail.query.ts`
 * gives: a `null` check here would be a 404 in disguise, and the 404 is the policy's to answer.
 */
/** The two things a command needs from the facts: the reader the policy takes, and the locked row. */
export interface ProjectWriteFacts {
  readonly read: () => Promise<ProjectAccessFacts>;
  /**
   * The locked row, after the policy let the caller through.
   *
   * Narrowed by the same assertion the policy already made: on a real database the row the policy
   * decided on is the row this returns — it is locked — and the assertion is for the compiler and
   * for a double that holds no lock, where it answers the same 404 rather than a `null` the code
   * would dereference.
   */
  readonly locked: () => ProjectSummary;
}

export const projectWriteFacts = (
  projects: ProjectRepositoryPort,
  acl: AclScopeResolver,
  actor: Actor,
  projectId: string,
): ProjectWriteFacts => {
  let pending: Promise<ProjectAccessFacts> | undefined;
  let summary: ProjectSummary | null = null;

  const load = async (): Promise<ProjectAccessFacts> => {
    summary = await projects.lockForWrite(projectId);

    return { scope: summary, acl: await acl.resolve(actor, { type: 'PROJECT', id: projectId }) };
  };

  return {
    read: () => {
      pending ??= load();

      return pending;
    },
    locked: () => {
      const row = summary;

      assertProjectAddressable(row);

      return row;
    },
  };
};
