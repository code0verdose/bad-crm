import { SharedUi } from '@shared';

import { AuthService } from '@units/auth';
import { EmployeeService } from '@units/employee';
import { IamService } from '@units/iam';
import { ProjectLib, ProjectService, ProjectUi } from '@units/project';

export interface ProjectMembersProps {
  readonly projectId: string;
}

/** Rows of the roster skeleton, so the page does not jump when it arrives. */
const SKELETON_ROWS = 6;

/**
 * `/projects/$projectId/members`: who is on the project, and — for a reader the card lets manage
 * the roster — the three roster commands (STORY-014-02, client half).
 *
 * **The controls come from `permissions.canManageMembers` and nothing else** (STORY-014-05,
 * acceptance 5). Without it the roster is read-only and the add form is not drawn; with it, each row
 * gets a role select and a remove button, and the form appears — once the directory has answered,
 * because a picker cannot offer people the reader may not be told about (`user:read`).
 *
 * An archived project shows the same controls disabled (acceptance 7); the header's banner says why.
 *
 * The names come from the directory, as on the overview; the reader's own id comes from the session,
 * so the picker does not offer them a seat the server refuses to anybody (`self_assignment_forbidden`).
 */
export function ProjectMembers({ projectId }: ProjectMembersProps) {
  const { can } = IamService.IamHooks.useCan();
  const session = AuthService.useBootstrapSession();
  const controls = ProjectService.ProjectHooks.useProjectControls(projectId);
  const members = ProjectService.ProjectHooks.useProjectMembers(projectId);
  const roster = ProjectService.ProjectHooks.useProjectRoster(projectId);
  const directory = EmployeeService.EmployeeHooks.useDirectory(can('user:read'));

  const readerId = session.status === 'authenticated' ? session.userId : undefined;
  const manages = controls.canManageMembers;
  const rows = ProjectLib.projectRoster(members.members, directory.people);

  return (
    <SharedUi.Section
      descriptionKey="projects.members.description"
      titleKey="projects.members.title"
    >
      {manages && directory.isLoaded && !controls.isArchived && (
        <ProjectUi.ProjectMemberAddForm
          candidates={ProjectLib.projectCandidates(
            directory.people,
            members.members.map((member) => member.userId),
            readerId,
          )}
          isPending={roster.isAdding}
          onAdd={roster.add}
        />
      )}
      <SharedUi.DataState
        errorMessageKey="projects.team.failed"
        onRetry={members.refetch}
        skeleton={<SharedUi.TextSkeleton lines={SKELETON_ROWS} />}
        status={members.status}
      >
        {rows.length === 0 ? (
          <SharedUi.EmptyState titleKey="projects.members.empty" />
        ) : (
          <ProjectUi.ProjectMemberTable
            locked={controls.isArchived}
            rows={rows}
            {...(manages ? { onChangeRole: roster.changeRole, onRemove: roster.remove } : {})}
          />
        )}
      </SharedUi.DataState>
    </SharedUi.Section>
  );
}
