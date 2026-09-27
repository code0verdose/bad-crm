import { Alert } from '@mantine/core';
import { IconArchive } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

/**
 * «This project is archived and cannot be changed» (STORY-014-05, acceptance 7).
 *
 * A banner rather than a toast: it is the state of the thing on screen, not the outcome of an
 * action, and it has to be there for as long as the card is. The edits have shipped (STORY-014-01/02
 * client halves): on an archived project they stay on screen `disabled`, with this banner as the
 * reason, rather than hidden in silence (`useProjectControls().isArchived`). Deletion is the one
 * action still available there — whether the banner's «nothing can be changed» should say so is an
 * open product question, recorded in STORY-014-07.
 */
export function ArchivedBanner() {
  const { t } = useTranslation();

  return (
    <Alert
      color="warning"
      icon={<IconArchive aria-hidden size={20} stroke={1.5} />}
      title={t('projects.archived.title')}
      variant="light"
    >
      {t('projects.archived.description')}
    </Alert>
  );
}
