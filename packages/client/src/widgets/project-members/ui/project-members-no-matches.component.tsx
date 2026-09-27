import { Button } from '@mantine/core';
import { type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedHooks, SharedUi } from '@shared';

export interface ProjectMembersNoMatchesProps {
  readonly onReset: () => void;
  /** Where focus goes when the reset takes itself away — pressing it ends this branch. */
  readonly returnFocusTo: RefObject<HTMLElement | null>;
}

/**
 * «Nobody matches the filters» — not «nobody is on the project»: the two look alike and ask for
 * opposite next steps (`rules/lists-and-filters.mdc` §12). This one's step is to take the filters
 * off, and the button that does it hands focus to the search box on its way out.
 */
export function ProjectMembersNoMatches({ onReset, returnFocusTo }: ProjectMembersNoMatchesProps) {
  const { t } = useTranslation();
  const handOffFocus = SharedHooks.useFocusHandoff(returnFocusTo);

  return (
    <SharedUi.EmptyState
      action={
        <Button onClick={onReset} ref={handOffFocus} variant="light">
          {t('projects.members.filters.reset')}
        </Button>
      }
      descriptionKey="projects.members.filters.noMatches"
      titleKey="projects.members.filters.noMatchesTitle"
    />
  );
}
