import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { deleteProject } from '@units/project/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

/**
 * Deletes a project — **pessimistically**, behind a confirmation, and without an undo: the key is
 * freed at once and every member is re-authorised without the seat, so there is nothing an undo
 * could put back.
 *
 * **`refetchType: 'none'`** on the invalidation, and it is load-bearing. The screen that asked is
 * the project's own card, still mounted while the caller navigates away; a refetch of its active
 * entries would be answered `404` and throw into the route's boundary for a frame before the
 * navigation lands. Marked stale and not refetched, the entries are simply dropped once nobody
 * reads them, and whatever list the reader goes to next asks fresh.
 *
 * The local `onError` keeps a refusal inside the `aria-modal` dialog that asked.
 */
export const useDeleteProject = (): UseMutationResult<void, Error, string> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (projectId: string) => deleteProject(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: QueryKeys.Projects.all,
        refetchType: 'none',
      });
      notify.success({ id: 'project-deleted', messageKey: 'projects.delete.done' });
    },
    onError: () => undefined,
  });
};
