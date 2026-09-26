import { Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { PROJECT_UPCOMING_BLOCKS } from '@units/project/model';

/**
 * The overview's blocks for domains that are not built yet — recent changes, tasks, time, CI —
 * each saying «arrives in a later release» instead of drawing an empty chart
 * (STORY-014-05, acceptance 4). An empty chart would claim there is nothing, which is false: there
 * is nothing *yet*, and the reader should know which of the two it is.
 */
export function ProjectUpcomingBlocks() {
  const { t } = useTranslation();

  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
      {PROJECT_UPCOMING_BLOCKS.map((block) => (
        <Paper key={block.value} p="md" radius="md" withBorder>
          <Stack gap="xs">
            <Title order={3} size="h4">
              {t(block.titleKey)}
            </Title>
            <Text c="var(--bc-text-muted)" size="sm">
              {t('projects.upcoming.later')}
            </Text>
          </Stack>
        </Paper>
      ))}
    </SimpleGrid>
  );
}
