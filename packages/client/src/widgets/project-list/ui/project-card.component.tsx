import { Badge, Group, Stack, Text, Title } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { ProjectModel, ProjectUi, type ProjectApi, type ProjectLib } from '@units/project';

import classes from './project-list-ui.module.css';

export interface ProjectCardProps {
  readonly row: ProjectLib.ProjectListRow<ProjectApi.ProjectListItem>;
}

/**
 * One project as a card: its colour, key and name, its status as a word and an icon, who leads it
 * and how many people are on it.
 *
 * **Presentational.** What it does not draw is decided upstream: the list item carries no budget
 * and no burn at any permission level (acceptance 6), so there is nothing here to hide. The name is
 * the link, and it sits in a heading, so a screen reader can walk the grid by headings.
 */
export function ProjectCard({ row }: ProjectCardProps) {
  const { t } = useTranslation();

  return (
    <Stack className={classes['card']} component="article" gap="xs">
      <Group gap="xs" wrap="nowrap">
        <ProjectUi.ProjectColorSwatch color={row.color} />
        <Badge variant="outline">{row.key}</Badge>
      </Group>
      <Title order={2} size="h4">
        <Link
          className={classes['projectLink']}
          params={{ projectId: row.id }}
          to="/projects/$projectId"
        >
          {row.name}
        </Link>
      </Title>
      <Group gap="xs" wrap="wrap">
        <ProjectUi.ProjectStatusBadge status={row.status} />
        <Badge color="neutral" variant="light">
          {t(ProjectModel.PROJECT_VISIBILITY_LABEL[row.visibility])}
        </Badge>
      </Group>
      <Text size="sm">{t('projects.list.card.lead', { name: row.leadLabel })}</Text>
      <Text c="var(--bc-text-muted)" size="sm">
        {t('projects.header.members', { count: row.memberCount })}
      </Text>
    </Stack>
  );
}
