import { Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { EmployeeService } from '@units/employee';
import { IamService } from '@units/iam';
import { ProjectLib, ProjectService, ProjectUi } from '@units/project';

import { ProjectDatesCard } from './ui/project-dates-card.component.js';
import { ProjectTeamCard } from './ui/project-team-card.component.js';

export interface ProjectOverviewProps {
  readonly projectId: string;
}

/** Rows of the roster skeleton — a small team, so the page does not jump when it arrives. */
const SKELETON_ROWS = 4;

/**
 * The overview section of a project card, built from what the server actually has
 * (STORY-014-05, acceptance 4): the description, progress by dates, the team with roles and
 * allocation — and, for the domains not built yet, blocks that say so instead of empty charts.
 *
 * **Two loading stories on one screen, deliberately.** The card itself was loaded by the route
 * before anything rendered, so its sections have no pending state; the roster is a second read
 * and has its own skeleton and its own inline error with a retry (`DataState`, never a toast).
 *
 * The names come from the directory, behind `user:read` — joined here, as the header does, because
 * neither the project nor the directory owns the other.
 */
export function ProjectOverview({ projectId }: ProjectOverviewProps) {
  const { t } = useTranslation();
  const { can } = IamService.IamHooks.useCan();
  const view = ProjectService.ProjectHooks.useProject(projectId);
  const roster = ProjectService.ProjectHooks.useProjectMembers(projectId);
  const directory = EmployeeService.EmployeeHooks.useDirectory(can('user:read'));

  return (
    <>
      <SharedUi.Section titleKey="projects.overview.about">
        {view.project.description === null ? (
          <Text c="var(--bc-text-muted)">{t('projects.overview.noDescription')}</Text>
        ) : (
          <Text>{view.project.description}</Text>
        )}
      </SharedUi.Section>

      <SharedUi.Section titleKey="projects.overview.dates">
        <ProjectDatesCard progress={view.progress} />
      </SharedUi.Section>

      <SharedUi.Section titleKey="projects.overview.team">
        <SharedUi.DataState
          errorMessageKey="projects.team.failed"
          onRetry={roster.refetch}
          skeleton={<SharedUi.TextSkeleton lines={SKELETON_ROWS} />}
          status={roster.status}
        >
          <ProjectTeamCard rows={ProjectLib.projectRoster(roster.members, directory.people)} />
        </SharedUi.DataState>
      </SharedUi.Section>

      <SharedUi.Section
        descriptionKey="projects.upcoming.description"
        titleKey="projects.upcoming.title"
      >
        <ProjectUi.ProjectUpcomingBlocks />
      </SharedUi.Section>
    </>
  );
}
