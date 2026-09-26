import { type ProjectMember } from '@units/project/api';
import { useProjectMembersQuery } from '@units/project/service/queries/project-members.query.js';

export interface ProjectMembersView {
  readonly status: 'pending' | 'error' | 'success';
  /** Empty until the roster arrives — the screen draws a skeleton for that, not an empty list. */
  readonly members: readonly ProjectMember[];
  /** Resolves when the reload answers, so «Retry» can stay busy until then. */
  readonly refetch: () => Promise<unknown>;
}

/**
 * Who is on a project, as the overview renders it.
 *
 * `isPending` rather than `isFetching`, as in `useTeamDetail`: a membership change will invalidate
 * this key, and a skeleton drawn over rows already on screen is a flash after every click. A failed
 * load is an inline error with a retry, never a toast (`rules/errors-and-toasts.mdc` §5).
 */
export const useProjectMembers = (projectId: string): ProjectMembersView => {
  const query = useProjectMembersQuery(projectId);

  return {
    status: query.isError ? 'error' : query.isPending ? 'pending' : 'success',
    members: query.data ?? [],
    refetch: () => query.refetch(),
  };
};
