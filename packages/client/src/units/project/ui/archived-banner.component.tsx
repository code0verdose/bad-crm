import { Alert } from '@mantine/core';
import { IconArchive } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

/**
 * «This project is archived and cannot be changed» (STORY-014-05, acceptance 7).
 *
 * A banner rather than a toast: it is the state of the thing on screen, not the outcome of an
 * action, and it has to be there for as long as the card is. The screen draws no control that would
 * change the project today, so the explanation is the whole of the acceptance for now — when edits
 * arrive (STORY-014-01/02 client halves) they are disabled *with* this banner as the reason, not
 * hidden in silence.
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
