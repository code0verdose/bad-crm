import { Badge, Group, Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

import { EmployeeService } from '@units/employee';
import { IamService } from '@units/iam';
import { ProjectLib, ProjectService, ProjectUi } from '@units/project';

export interface ProjectHeaderProps {
  readonly projectId: string;
}

/**
 * The head of a project card on every one of its sections: key, name, status, visibility, colour,
 * lead and dates (STORY-014-05, acceptance 1), and the archive banner when it applies
 * (acceptance 7).
 *
 * **The lead is a name only when the reader may see the directory.** `ProjectDetail.leadId` is an
 * id on purpose — who an account belongs to is `GET /employees`, behind `user:read` — so the name is
 * joined here, through the employee unit's own hook, and only when the permission is held. Without
 * it there is no second request at all and the lead is shown by id, the way the team roster does.
 * Joining two units' answers is what a widget is for.
 */
export function ProjectHeader({ projectId }: ProjectHeaderProps) {
  const { t, i18n } = useTranslation();
  const { can } = IamService.IamHooks.useCan();
  const view = ProjectService.ProjectHooks.useProject(projectId);
  const directory = EmployeeService.EmployeeHooks.useDirectory(can('user:read'));
  const { project } = view;
  const zone = SharedLib.resolveTimeZone();

  return (
    <Stack gap="sm">
      <Group align="center" gap="sm" wrap="wrap">
        <ProjectUi.ProjectColorSwatch color={project.color} />
        <Title order={2}>{project.name}</Title>
        <Badge variant="outline">{project.key}</Badge>
        <ProjectUi.ProjectStatusBadge status={project.status} />
        <Badge color="neutral" variant="light">
          {t(view.visibilityLabelKey)}
        </Badge>
      </Group>

      <Group gap="lg" wrap="wrap">
        <Group gap="xs" wrap="nowrap">
          <Text c="var(--bc-text-muted)" size="sm">
            {t('projects.header.lead')}
          </Text>
          <Text size="sm">{ProjectLib.nameOf(project.leadId, directory.people)}</Text>
        </Group>
        <Text size="sm">{t('projects.header.members', { count: project.memberCount })}</Text>
        {project.startedAt !== null && (
          <Text size="sm">
            {t('projects.header.startedAt', {
              date: SharedLib.formatDate(project.startedAt, i18n.language, zone),
            })}
          </Text>
        )}
        {project.dueAt !== null && (
          <Text size="sm">
            {t('projects.header.dueAt', {
              date: SharedLib.formatDate(project.dueAt, i18n.language, zone),
            })}
          </Text>
        )}
      </Group>

      {view.isArchived && <ProjectUi.ArchivedBanner />}
    </Stack>
  );
}
