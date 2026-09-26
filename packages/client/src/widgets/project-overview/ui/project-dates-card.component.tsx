import { Progress, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { SharedLib } from '@shared';

import { type ProjectTypes } from '@units/project';

export interface ProjectDatesCardProps {
  /** `null` when the project lacks a start or a deadline — there is no span to measure. */
  readonly progress: ProjectTypes.DateProgress | null;
}

/**
 * Progress **by dates** (STORY-014-05, acceptance 4) — how much of the calendar is behind, never a
 * claim about the work. The bar carries its own accessible name and value; the sentence under it
 * says the same thing in words, and «overdue» is a word, not only a colour (`rules/a11y.mdc` §2).
 * The number reaches the sentence already formatted — the sign is the locale's, not the
 * catalogue's (`rules/i18n.mdc` §10).
 */
export function ProjectDatesCard({ progress }: ProjectDatesCardProps) {
  const { t, i18n } = useTranslation();

  if (progress === null) {
    return (
      <Text c="var(--bc-text-muted)" size="sm">
        {t('projects.dates.noSpan')}
      </Text>
    );
  }

  return (
    <Stack gap="xs">
      <Progress.Root size="md">
        <Progress.Section
          aria-label={t('projects.dates.progressLabel')}
          color={progress.isOverdue ? 'danger' : 'brand'}
          value={progress.percent}
        />
      </Progress.Root>
      <Text size="sm">
        {progress.isOverdue
          ? t('projects.dates.overdue')
          : t('projects.dates.elapsed', {
              percent: SharedLib.formatPercent(progress.percent, i18n.language),
            })}
      </Text>
    </Stack>
  );
}
