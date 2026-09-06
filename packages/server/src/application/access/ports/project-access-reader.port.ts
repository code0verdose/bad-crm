import { type ProjectRole, type ProjectVisibility } from '@/domain/access/implicit-level.policy.js';

/**
 * What the implicit table needs to know about one project for one person — and nothing else.
 *
 * An access reader in the sense of `rules/hexagonal-backend.mdc` 6: identifiers, a visibility, a
 * membership role. Not the project. `null` is the one answer for «no such project», «deleted» and
 * «another organization's», because the three must reach the caller as one 404
 * (`rules/permissions.mdc`, 7).
 */
export interface ProjectAclFacts {
  readonly organizationId: string;
  readonly visibility: ProjectVisibility;
  /** The person's live membership (`left_at IS NULL`), or `null` when they are not on the project. */
  readonly memberRole: ProjectRole | null;
}

/**
 * Lives under `access` rather than `project` on purpose, for now: it is the half of the project's
 * access reader that the ACL resolver needs, written in the step that builds the resolver
 * (STORY-011-06), while the project context is being created beside it (EPIC-014). The step that
 * gives the project its own access reader and policy (STORY-014-02) is the one to fold this into
 * `application/project/ports/project-access-reader.port.ts` — one reader per context, not two.
 */
export interface ProjectAccessReaderPort {
  aclFacts(projectId: string, userId: string): Promise<ProjectAclFacts | null>;
}
