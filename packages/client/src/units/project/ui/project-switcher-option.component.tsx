import { Badge, Group, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { type ProjectOption } from '@units/project/api';

import { ProjectColorSwatch } from './project-color-swatch.component.js';

export interface ProjectSwitcherOptionProps {
  readonly option: ProjectOption;
}

/**
 * One row of the switcher: colour, key, name — and an «Archived» mark in words, because an archived
 * project may be offered only when the person asked for the archive and must read as one
 * (STORY-014-06, acceptance 7). The colour is decorative (`ProjectColorSwatch`), the key and the
 * name are what the row is called.
 */
export function ProjectSwitcherOption({ option }: ProjectSwitcherOptionProps) {
  const { t } = useTranslation();

  return (
    <Group gap="xs" wrap="nowrap">
      <ProjectColorSwatch color={option.color} />
      <Text c="var(--bc-text-muted)" fw={600} size="sm">
        {option.key}
      </Text>
      <Text size="sm" truncate>
        {option.name}
      </Text>
      {option.status === 'ARCHIVED' && (
        <Badge color="neutral" size="sm" variant="light">
          {t('nav.projectSwitcher.archivedMark')}
        </Badge>
      )}
    </Group>
  );
}
