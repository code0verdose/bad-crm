import { useCallback } from 'react';

import { projectRefusalMessage } from '@units/project/lib';
import { useDeleteProject } from '@units/project/service/mutations/delete-project.mutation.js';

import { type ProjectDangerAction } from './use-project-archival.hook.js';

/**
 * Deleting a project, as the confirmation dialog renders it — the same object as the archive's,
 * for the other dialog of the danger zone. `onDone` is where the caller leaves the card: the screen
 * it is on stops existing once the server agrees, and not a moment before.
 */
export const useProjectDeletion = (projectId: string): ProjectDangerAction => {
  const { error, isPending, mutate, reset } = useDeleteProject();

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
