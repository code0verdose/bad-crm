import { Button } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedHooks, SharedUi } from '@shared';

import { IamUi } from '@units/iam';

export interface ProjectListEmptyProps {
  /** Whether a filter emptied the list, rather than the reader having no projects at all. */
  readonly isFiltered: boolean;
  readonly onReset: () => void;
  /**
   * Where focus goes when the reset takes itself away — pressing it ends the filtered branch, and
   * the button with it.
   */
  readonly returnFocusTo: RefObject<HTMLElement | null>;
}

/**
 * «Nothing here», and what to do about it — two different emptinesses with two different next
 * steps (`rules/lists-and-filters.mdc` §12; STORY-014-04, acceptance 7).
 *
 * * **A filter emptied the list** → take the filters off.
 * * **The reader sees no project at all** → the sentence depends on whether they may create one
 *   (`<Can permission="project:create">`, a hint — the server decides). Somebody who may not is told
 *   who can change that: a project lead adds people.
 *
 * Somebody who may create one gets the step itself in the action slot — «New project», to
 * `/projects/new`, the same link the page header carries: an empty list is where it is looked for
 * first.
 */
export function ProjectListEmpty({ isFiltered, onReset, returnFocusTo }: ProjectListEmptyProps) {
  const { t } = useTranslation();
  const handOffFocus = SharedHooks.useFocusHandoff(returnFocusTo);

  if (isFiltered) {
    return (
      <SharedUi.EmptyState
        action={
          <Button onClick={onReset} ref={handOffFocus} variant="light">
            {t('projects.list.empty.reset')}
          </Button>
        }
        descriptionKey="projects.list.empty.filtered"
        titleKey="projects.list.empty.filteredTitle"
      />
    );
  }

  return (
    <IamUi.Can
      fallback={
        <SharedUi.EmptyState
          descriptionKey="projects.list.empty.askLead"
          titleKey="projects.list.empty.title"
        />
      }
      permission="project:create"
    >
      <SharedUi.EmptyState
        action={
          <Button component={Link} to="/projects/new" variant="light">
            {t('projects.list.create')}
          </Button>
        }
        descriptionKey="projects.list.empty.canCreate"
        titleKey="projects.list.empty.title"
      />
    </IamUi.Can>
  );
}
