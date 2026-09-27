import { useCallback, useMemo } from 'react';

import {
  projectEditValuesOf,
  projectFormFailure,
  toProjectPatch,
  type ProjectFormFailure,
} from '@units/project/lib';
import { type ProjectEditFormValues, type ProjectFormValues } from '@units/project/model';
import { useUpdateProject } from '@units/project/service/mutations/update-project.mutation.js';
import { useProjectDetailQuery } from '@units/project/service/queries/project-detail.query.js';

export interface ProjectEditing {
  /**
   * The stored project in the form's terms — what the settings form starts from. The key and the
   * visibility ride along for display only: the edit schema strips both before anything is sent.
   */
  readonly initialValues: ProjectFormValues;
  readonly failure: ProjectFormFailure;
  readonly isPending: boolean;
  readonly save: (values: ProjectEditFormValues) => void;
}

/**
 * Editing a project's settings — the unit's public API for the settings section.
 *
 * `initialValues` is derived from the cached card at render. The section is keyed by the card's
 * values by its caller, so a save that changes them starts a fresh form from what the server now
 * holds rather than an effect copying it in (`rules/frontend-fsd.mdc` rule 11).
 */
export const useProjectEditing = (projectId: string): ProjectEditing => {
  const { data: project } = useProjectDetailQuery(projectId);
  const { error, isPending, mutate } = useUpdateProject();
  // Kept per answer, not rebuilt per render: the form moves focus to a refused field when this
  // changes identity (`useRefusalFocus`), and a fresh object on every render would do it every time.
  const failure = useMemo(() => projectFormFailure(error), [error]);

  const save = useCallback(
    (values: ProjectEditFormValues) => {
      mutate({ projectId, patch: toProjectPatch(values) });
    },
    [mutate, projectId],
  );

  return {
    initialValues: {
      ...projectEditValuesOf(project),
      key: project.key,
      visibility: project.visibility,
    },
    failure,
    isPending,
    save,
  };
};
