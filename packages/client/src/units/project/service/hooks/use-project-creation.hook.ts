import { useCallback } from 'react';

import { projectFormFailure, toProjectDraft, type ProjectFormFailure } from '@units/project/lib';
import { type ProjectFormValues } from '@units/project/model';
import { useCreateProject } from '@units/project/service/mutations/create-project.mutation.js';

export interface ProjectCreation {
  /** Where the refusal is shown — under a field, or above the form. Read from the mutation. */
  readonly failure: ProjectFormFailure;
  readonly isPending: boolean;
  /**
   * Creates it from the form's own values; the mapping to the request body lives here, not in the
   * page. `onCreated` fires only on success, with the new id — the page moves to the card, which the
   * mutation has already put in the cache.
   */
  readonly create: (values: ProjectFormValues, onCreated: (projectId: string) => void) => void;
}

/**
 * Creating a project, as the object the create page renders — the unit's public API for `ui`
 * (`rules/frontend-fsd.mdc` rule 6). Every state is read from the mutation at render, never copied
 * into state by an effect (rule 11).
 */
export const useProjectCreation = (): ProjectCreation => {
  const { error, isPending, mutate } = useCreateProject();

  const create = useCallback(
    (values: ProjectFormValues, onCreated: (projectId: string) => void) => {
      mutate(toProjectDraft(values), {
        onSuccess: (project) => {
          onCreated(project.id);
        },
      });
    },
    [mutate],
  );

  return { failure: projectFormFailure(error), isPending, create };
};
