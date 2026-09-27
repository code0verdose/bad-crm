import { Alert, Box, Button, Skeleton, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { type ProjectVisibilityImpactView } from '@units/project/service/hooks/use-project-visibility-change.hook.js';

export interface ProjectVisibilityImpactProps {
  readonly impact: ProjectVisibilityImpactView;
}

/**
 * «N colleagues lose access at once» — the server's count, inside the confirmation of a change of
 * visibility (STORY-014-01, acceptance 7).
 *
 * **A live region that exists before the count does.** The dialog opens, the count arrives a moment
 * later: the region is mounted with the dialog, `aria-busy` while the request is in flight, and the
 * sentence lands in it — so a screen reader, which inside the `aria-modal` dialog hears nothing
 * outside it, is told the number when it comes (`rules/a11y.mdc` §15–16). The skeleton bar is
 * `aria-hidden`: it is a shape, not content.
 *
 * **A failed read is said here, once.** Not a toast — the page behind an `aria-modal` dialog is
 * out of the accessibility tree — and not the dialog's own refusal alert either, which belongs to
 * the change: this one is about the summary, with its own retry, and pressing the confirm button
 * stays possible because the server decides the change whether or not the count was shown.
 */
export function ProjectVisibilityImpact({ impact }: ProjectVisibilityImpactProps) {
  const { t } = useTranslation();

  return (
    <Box aria-busy={impact.status === 'pending'} aria-live="polite" role="status">
      {impact.status === 'pending' && (
        <Skeleton aria-hidden="true" height="var(--bc-row-height)" radius="sm" />
      )}
      {impact.message !== undefined && (
        <Text fw={600}>{t(impact.message.key, impact.message.values ?? {})}</Text>
      )}
      {impact.failure !== undefined && (
        <Alert color="warning" title={t('projects.visibility.impactFailed')} variant="light">
          <Text size="sm">{t(impact.failure.key, impact.failure.values ?? {})}</Text>
          <Button mt="xs" onClick={impact.retry} size="compact-sm" variant="light">
            {t('common.retry')}
          </Button>
        </Alert>
      )}
    </Box>
  );
}
