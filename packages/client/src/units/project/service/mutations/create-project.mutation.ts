import {
  hashKey,
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';

import { createProject, type ProjectDetail, type ProjectDraft } from '@units/project/api';
import { QueryKeys } from '@shared/lib';
import { notify } from '@shared/ui';

/**
 * Creates a project — **pessimistically**, as `rules/tanstack-query.mdc` §7 requires of a create:
 * an optimistic card would have to invent an id, and every link into it would lead nowhere.
 *
 * The answer is the card itself (`201` with `ProjectDetail`, `permissions` included), so it is
 * written under its detail key: the screen the create page moves to already has it, and that
 * navigation costs no request. The rest of the group is invalidated — a list, when there is one,
 * places the new project by its own sort order — and that entry alone is spared.
 *
 * **The local `onError` makes the form the only signal.** Most refusals of this endpoint are about
 * one field — the key is taken, the lead is not a live account, a bound was crossed — and they
 * belong under that field, never in a toast (`rules/errors-and-toasts.mdc` §4). `MutationCache`
 * steps aside for a mutation that handles its own failure (§10); `logError` still runs.
 */
export const useCreateProject = (): UseMutationResult<ProjectDetail, Error, ProjectDraft> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: ProjectDraft) => createProject(draft),
    onSuccess: (project) => {
      const detail = QueryKeys.Projects.detail(project.id);

      queryClient.setQueryData(detail, project);
      // Everything under the group but the entry just written: marking it stale would make the
      // card's route guard read it again on arrival — the one request this write exists to save.
      void queryClient.invalidateQueries({
        queryKey: QueryKeys.Projects.all,
        predicate: (query) => query.queryHash !== hashKey(detail),
      });
      notify.success({ id: 'project-created', messageKey: 'projects.created' });
    },
    onError: () => undefined,
  });
};
