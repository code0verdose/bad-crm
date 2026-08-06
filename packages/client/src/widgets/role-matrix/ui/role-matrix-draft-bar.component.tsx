import { Button, Group, Paper, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

export interface RoleMatrixDraftBarProps {
  readonly changeCount: number;
  readonly isSaving: boolean;
  readonly onReview: () => void;
  readonly onDiscard: () => void;
}

/**
 * The bar that appears once something is unsaved.
 *
 * It counts **roles**, not clicks: what will be sent is one composition per role, and a number that
 * disagreed with the summary on the next screen would make the person doubt the one that matters.
 *
 * «Review» rather than «Save» on the primary button, because the next step is the preview: nothing
 * is written until the summary has been seen (`ux-architecture.md`, confirmation of destructive
 * actions).
 */
export function RoleMatrixDraftBar({
  changeCount,
  isSaving,
  onReview,
  onDiscard,
}: RoleMatrixDraftBarProps) {
  const { t } = useTranslation();

  if (changeCount === 0) return null;

  return (
    <Paper withBorder p="sm" role="region" aria-label={t('roles.draft.region')}>
      <Group justify="space-between">
        <Text aria-live="polite">{t('roles.draft.count', { count: changeCount })}</Text>
        <Group gap="sm">
          <Button variant="default" onClick={onDiscard} disabled={isSaving}>
            {t('roles.draft.discard')}
          </Button>
          <Button onClick={onReview} loading={isSaving}>
            {t('roles.draft.review')}
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}
