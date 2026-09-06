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
 * Lives under `access` rather than `project` on purpose. It is the half of the project the ACL
 * resolver needs — written in the step that built the resolver (STORY-011-06) while the project
 * context was being created beside it (EPIC-014) — and its only consumer is that resolver. The
 * project's own policy (`domain/project/access/project-access.policy.ts`, STORY-014-03) does not
 * read it: it takes the resolver's answer and the repository's `scope()`, so «one reader per
 * context» holds without a second port under `application/project/ports/`. A move was planned here
 * and dropped for that reason on 2026-09-06; `test/unit/architecture/access-readers.test.ts` holds
 * the shape of this one wherever it lives.
 */
export interface ProjectAccessReaderPort {
  aclFacts(projectId: string, userId: string): Promise<ProjectAclFacts | null>;
}
