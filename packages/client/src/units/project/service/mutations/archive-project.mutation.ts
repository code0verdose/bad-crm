import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { archiveProject } from '@units/project/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

/**
 * Archives a project — **pessimistically**, behind a confirmation.
 *
 * Not an undo-toast (`rules/errors-and-toasts.mdc` §9): there is no operation that brings a project
 * back from the archive yet (STORY-014-07), so an «Undo» could not keep its promise. The card
 * re-reads itself afterwards and shows the archive banner — that and one green toast are the whole
 * feedback. The local `onError` keeps a refusal inside the `aria-modal` dialog that asked.
 */
export const useArchiveProject = (): UseMutationResult<void, Error, string> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (projectId: string) => archiveProject(projectId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Projects.all });
      notify.success({ id: 'project-archived', messageKey: 'projects.archive.done' });
    },
    onError: () => undefined,
  });
};
