import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { changeProjectVisibility, type ProjectVisibilityValue } from '@units/project/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

export interface ChangeProjectVisibilityInput {
  readonly projectId: string;
  readonly visibility: ProjectVisibilityValue;
}

/**
 * Opens a project to the organization or closes it — **pessimistically**, behind a confirmation.
 *
 * Both directions are dangerous by the catalogue: one statement takes the project away from, or
 * hands it to, everybody in the organization who is not on it. Nothing about that is a toggle to
 * flip ahead of the server.
 *
 * The request carries the confirmation header: it is only sent from the dialog that showed the
 * consequences. **The local `onError` keeps a refusal inside that `aria-modal` dialog** — a toast in
 * the corner of the page it hides would reach no screen reader (`rules/tanstack-query.mdc` §10).
 */
export const useChangeProjectVisibility = (): UseMutationResult<
  void,
  Error,
  ChangeProjectVisibilityInput
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ChangeProjectVisibilityInput) =>
      changeProjectVisibility(input.projectId, input.visibility),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Projects.all });
      notify.success({
        id: 'project-visibility-changed',
        messageKey: 'projects.visibility.changed',
      });
    },
    onError: () => undefined,
  });
};
