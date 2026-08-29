import { useMemo } from 'react';

import { useTeamListQuery } from '@units/team/service/queries/team-list.query.js';

/** One team as a label: the identifier the caller asked about, and the name it turned out to have. */
export interface NamedTeam {
  readonly id: string;
  readonly name: string;
}

/**
 * Naming a handful of teams by their identifiers — the unit's public API for anybody holding ids
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because a table cell reached past it.** `widgets/invitation-list/ui/invitation-teams`
 * called `TeamQueries.useTeamListQuery()` and built the lookup and the join in the component body:
 * the middle link of the chain skipped (rule 4), and a `Map` plus a `flatMap` over a query result
 * sitting where rule 5 allows only markup, handlers and hook calls.
 *
 * **An unknown id yields nothing rather than itself.** Three callers land on the same absence — a
 * team dissolved since the invitation was written, a reader the answer was trimmed for, an id that
 * was never a team — and none of them is served by a UUID in a table cell, which is noise a person
 * has to ignore (STORY-012-08, D1). The caller sees a shorter list and decides what to draw for an
 * empty one.
 *
 * **The order is the caller's, not the directory's.** The result follows `teamIds`, because the
 * caller is showing the teams *of one thing* and the order it holds them in is the only one that
 * means anything here.
 */
export const useTeamNames = (teamIds: readonly string[]): readonly NamedTeam[] => {
  const query = useTeamListQuery();
  const teams = query.data;

  return useMemo(() => {
    const names = new Map((teams ?? []).map((team) => [team.id, team.name]));

    return teamIds.flatMap((id) => {
      const name = names.get(id);

      return name === undefined ? [] : [{ id, name }];
    });
  }, [teams, teamIds]);
};
