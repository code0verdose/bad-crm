import { type Actor } from '@/domain/access/actor.types.js';
import {
  canArchiveProject,
  canDeleteProject,
  canManageProjectMembers,
  canManageProjectVisibility,
  canUpdateProject,
  type ProjectAccessFacts,
} from '@/domain/project/access/project-access.policy.js';

/**
 * What the caller may do to one project, answered in advance — the `permissions` block of the
 * project card (STORY-014-05, acceptance 5; STORY-011-08, acceptance 12;
 * `docs/security/permission-model.md` §7 (е), «Уровень ACL конкретного объекта клиент не вычисляет»).
 *
 * The names are the documents' own: `canEdit`, `canManageMembers`, `canArchive` from STORY-014-05,
 * `canDelete` from STORY-011-08 and `ux-architecture.md`, `canChangeVisibility` from STORY-014-01
 * (the settings screen drew its visibility control by the capability alone, without the `MANAGER`
 * level the command demands — the gap §7 (е) forbids). A flag exists only where a command exists for
 * it to promise: `project:manage_settings` has no route, so it is not here.
 */
export interface ProjectPermissions {
  readonly canEdit: boolean;
  readonly canManageMembers: boolean;
  readonly canChangeVisibility: boolean;
  readonly canArchive: boolean;
  readonly canDelete: boolean;
}

/**
 * Every flag is the decision **of the command it promises**, by the same function over the same
 * facts — never a second reading of the role or the level (risk R-15). `canEdit` is
 * `canUpdateProject`, which `UpdateProjectUseCase` asserts; `canManageMembers` is
 * `canManageProjectMembers`, which the three roster commands assert; `canChangeVisibility` is
 * `canManageProjectVisibility`, which `ChangeProjectVisibilityUseCase` asserts; `canArchive` and
 * `canDelete` likewise. A flag therefore cannot say «yes» to a button whose route answers 403, and the table test
 * (`test/unit/application/project-card-permissions.test.ts`) holds that against the commands
 * themselves, not against a copy of this list.
 *
 * `facts` is the reader the caller already asked for its own decision; it is invoked by each
 * decision whose capability holds, so a caller must hand in a memoized one
 * (`application/project/project-card.util.ts`) — five decisions, one read.
 */
export const decideProjectPermissions = async (
  actor: Actor,
  facts: () => Promise<ProjectAccessFacts>,
): Promise<ProjectPermissions> => ({
  canEdit: (await canUpdateProject(actor, facts)).allowed,
  canManageMembers: (await canManageProjectMembers(actor, facts)).allowed,
  canChangeVisibility: (await canManageProjectVisibility(actor, facts)).allowed,
  canArchive: (await canArchiveProject(actor, facts)).allowed,
  canDelete: (await canDeleteProject(actor, facts)).allowed,
});
