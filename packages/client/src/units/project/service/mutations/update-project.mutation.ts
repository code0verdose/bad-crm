import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

import { updateProject, type ProjectPatch } from '@units/project/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

export interface UpdateProjectInput {
  readonly projectId: string;
  readonly patch: ProjectPatch;
}

/**
 * Saves the project's settings — **pessimistically**, and that is a judgement about this write
 * rather than an exception to the canon.
 *
 * `rules/tanstack-query.mdc` §6 names *inline* edits as optimistic; this is a form of six fields
 * submitted at once, one of which — the lead — is a change of rights that the server may refuse on
 * its own grounds (`project:manage_members`, `self_assignment_forbidden`, an inactive account). A
 * card that showed the new lead and then took it back would tell everybody watching, twice, who
 * runs the project. `PATCH` answers `204` and nothing else, so the group is invalidated rather than
 * written: the header, the overview and the roster all read it.
 *
 * **The local `onError` makes the form the only signal**, as on the create: the refusals are about
 * fields and are rendered under them (`rules/errors-and-toasts.mdc` §4, `tanstack-query` §10).
 */
export const useUpdateProject = (): UseMutationResult<void, Error, UpdateProjectInput> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateProjectInput) => updateProject(input.projectId, input.patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Projects.all });
      notify.success({ id: 'project-saved', messageKey: 'projects.saved' });
    },
    onError: () => undefined,
  });
};
