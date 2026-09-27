import { Stack, VisuallyHidden } from '@mantine/core';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { AuthService } from '@units/auth';
import { EmployeeService } from '@units/employee';
import { IamService } from '@units/iam';
import { ProjectLib, ProjectService, ProjectUi, type ProjectModel } from '@units/project';

import { ProjectMemberFilters } from './ui/project-member-filters.component.js';
import { ProjectMembersNoMatches } from './ui/project-members-no-matches.component.js';

export interface ProjectMembersProps {
  readonly projectId: string;
  readonly search: ProjectModel.ProjectMembersSearch;
  readonly navigate: ProjectService.ProjectHooks.ProjectMembersSearchNavigation;
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
 * An archived project shows the same controls, reachable and unavailable, with a note beside the
 * table saying why (acceptance 7; `ProjectMemberTable`). The add form is not drawn: there is nothing
 * in it to read, only a command that cannot run.
 *
 * The names come from the directory, as on the overview; the reader's own id comes from the session,
 * so the picker does not offer them a seat the server refuses to anybody (`self_assignment_forbidden`).
 *
 * **The filter (acceptance 10) narrows the rows already here**: the endpoint answers the whole
 * roster and knows no names, so the phrase can only be matched after the names are joined in. The
 * state is the URL, written by the unit's hook. The add form reads the unfiltered roster — who can
 * be added does not depend on who is being looked at. «Nothing matches» and «nobody is here» are
 * different screens, and every control that takes itself away — a chip, the reset, a row whose role
 * change took it out of the filter — hands focus to the search box.
 */
export function ProjectMembers({ projectId, search, navigate }: ProjectMembersProps) {
  const { t } = useTranslation();
  const searchRef = useRef<HTMLInputElement>(null);
  const { can } = IamService.IamHooks.useCan();
  const session = AuthService.useBootstrapSession();
  const controls = ProjectService.ProjectHooks.useProjectControls(projectId);
  const members = ProjectService.ProjectHooks.useProjectMembers(projectId);
  const roster = ProjectService.ProjectHooks.useProjectRoster(projectId);
  const filters = ProjectService.ProjectHooks.useProjectMemberFilters(search, navigate);
  const directory = EmployeeService.EmployeeHooks.useDirectory(can('user:read'));

  const readerId = session.status === 'authenticated' ? session.userId : undefined;
  const manages = controls.canManageMembers;
  const everyone = ProjectLib.projectRoster(members.members, directory.people);
  const rows = ProjectLib.filterProjectRoster(everyone, search);

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
      <Stack gap="sm">
        <ProjectMemberFilters filters={filters} searchRef={searchRef} />
        <SharedUi.FilterBar
          active={filters.active}
          onRemove={filters.removeFilter}
          onReset={filters.reset}
          returnFocusTo={searchRef}
        />
        <VisuallyHidden aria-live="polite" role="status">
          {members.status === 'success' && filters.isFiltered
            ? t('projects.members.filters.shown', { shown: rows.length, total: everyone.length })
            : null}
        </VisuallyHidden>
        <SharedUi.DataState
          errorMessageKey="projects.team.failed"
          onRetry={members.refetch}
          skeleton={<SharedUi.TextSkeleton lines={SKELETON_ROWS} />}
          status={members.status}
        >
          {everyone.length === 0 ? (
            <SharedUi.EmptyState titleKey="projects.members.empty" />
          ) : rows.length === 0 ? (
            <ProjectMembersNoMatches onReset={filters.reset} returnFocusTo={searchRef} />
          ) : (
            <ProjectUi.ProjectMemberTable
              locked={controls.isArchived}
              returnFocusTo={searchRef}
              rows={rows}
              {...(manages ? { onChangeRole: roster.changeRole, onRemove: roster.remove } : {})}
            />
          )}
        </SharedUi.DataState>
      </Stack>
    </SharedUi.Section>
  );
}
