import { useCallback } from 'react';

import { type ErrorMessage } from '@shared/api';
import { projectRefusalMessage } from '@units/project/lib';
import { useArchiveProject } from '@units/project/service/mutations/archive-project.mutation.js';

/** What either confirmation dialog of the danger zone renders. */
export interface ProjectDangerAction {
  /** The refusal as a sentence chosen by `code` and `reason`, never by `detail`. */
  readonly failure: ErrorMessage | undefined;
  readonly isPending: boolean;
  /** Runs it. `onDone` fires only on success. */
  readonly run: (onDone: () => void) => void;
  /** The dialog is done with: forgets the refusal so the next open starts clean. */
  readonly dismiss: () => void;
}

/**
 * Archiving a project, as the confirmation dialog renders it — the unit's public API for `ui`.
 *
 * The id is taken once, when the dialog is built, rather than passed to `run`: the confirmation is
 * about one named project, and a run method that accepts an id could be handed another one than the
 * sentence above the button names.
 */
export const useProjectArchival = (projectId: string): ProjectDangerAction => {
  const { error, isPending, mutate, reset } = useArchiveProject();

  const run = useCallback(
    (onDone: () => void) => {
      mutate(projectId, { onSuccess: onDone });
    },
    [mutate, projectId],
  );

  return {
    failure: error === null ? undefined : projectRefusalMessage(error),
    isPending,
    run,
    dismiss: reset,
  };
};
