import { type TeamDetail } from '@units/team/api';
import { useTeamDetailQuery } from '@units/team/service/queries/team-detail.query.js';

export interface TeamDetailView {
  readonly status: 'pending' | 'error' | 'success';
  /** The team, or `undefined` until it has arrived — the screen renders nothing for it either way. */
  readonly team: TeamDetail | undefined;
  readonly refetch: () => Promise<unknown>;
}

/**
 * One team as a screen renders it — the unit's public API for `ui` (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the screen reached past it.** `widgets/team-detail` called
 * `TeamQueries.useTeamDetailQuery()` and turned the two booleans of the query into the three states
 * of `DataState` in a helper of its own, next to the component (rule 4, and the mapping is the
 * `statusOf` every other unit hook in this tree already owns).
 *
 * `isPending` rather than `isFetching`: adding or removing a member invalidates this key, and a
 * skeleton drawn over rows that are already on screen is a flash after every single click.
 */
export const useTeamDetail = (teamId: string): TeamDetailView => {
  const query = useTeamDetailQuery(teamId);

  return {
    status: query.isError ? 'error' : query.isPending ? 'pending' : 'success',
    team: query.data,
    refetch: () => query.refetch(),
  };
};
