import { Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

export interface ArchivedNoteProps {
  /** What the controls it explains point at with `aria-describedby`. */
  readonly id: string;
}

/**
 * «Nothing in it can be changed while it stays in the archive» — beside the controls it explains.
 *
 * The banner in the card's head says the same thing once, at the top; this is the copy a control
 * that is unavailable points at (`aria-describedby`), so that a keyboard or screen reader user who
 * lands on it hears why, rather than «dimmed» and a search for the reason (`rules/a11y.mdc` §23).
 * The same sentence as the banner's description on purpose: one statement, two places it is needed.
 */
export function ArchivedNote({ id }: ArchivedNoteProps) {
  const { t } = useTranslation();

  return (
    <Text c="var(--bc-text-muted)" id={id} size="sm">
      {t('projects.archived.description')}
    </Text>
  );
}
