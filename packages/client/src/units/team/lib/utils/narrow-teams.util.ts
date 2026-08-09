import { type TeamListSearch } from '@units/team/model/validation/team-list-search.schema.js';
import { type TeamRow } from '@units/team/types';

/** How many rows a page carries. Not in the URL: a property of the screen, not of the view. */
export const TEAMS_PER_PAGE = 25;

export interface NarrowedTeams<TTeam extends TeamRow> {
  /** The rows of the page that is actually being shown. */
  readonly items: readonly TTeam[];
  /** How many matched the phrase, before paging — what the pager counts. */
  readonly total: number;
  /** The page being shown, which is not always the page that was asked for. See below. */
  readonly page: number;
}

/**
 * Searching, ordering and paging the org structure — over the answer, because `GET /teams` takes no
 * parameters.
 *
 * A pure function rather than three pieces of logic in a widget, and each of the three is a decision:
 *
 *   * **the phrase matches the slug as well as the name.** A team called «Frontend» whose address is
 *     `web-client` is exactly the case where somebody types what they saw in a URL;
 *   * **the order breaks its own ties.** Two teams of seven people compared only by size are equal,
 *     and equal rows fall back to whatever order the server happened to serialise — a table that
 *     reshuffles between two identical answers. The name is the tiebreaker, so the order is total;
 *   * **the page is clamped rather than trusted.** A phrase narrows the list without knowing where
 *     the reader was, so page three of «everybody» can be past the end of the result. An empty table
 *     would read as «no such teams», which is a sentence about the wrong thing.
 *
 * The comparison is on the lower-cased string rather than through `localeCompare`, and that is a
 * limitation stated rather than hidden: collation is locale-dependent, `Intl` belongs in
 * `shared/lib/format` (`rules/i18n.mdc` §10), and a locale-aware order for a handful of teams is not
 * worth a formatter threaded through a pure function. Within one alphabet the result is the expected
 * one; across two, teams group by script.
 */
export const narrowTeams = <TTeam extends TeamRow>(
  teams: readonly TTeam[],
  search: TeamListSearch,
): NarrowedTeams<TTeam> => {
  const phrase = search.q.trim().toLowerCase();
  const matched = phrase === '' ? [...teams] : teams.filter((team) => matches(team, phrase));

  matched.sort((left, right) => compare(left, right, search.sort));

  const lastPage = Math.max(1, Math.ceil(matched.length / TEAMS_PER_PAGE));
  const page = Math.min(search.page, lastPage);
  const from = (page - 1) * TEAMS_PER_PAGE;

  return { items: matched.slice(from, from + TEAMS_PER_PAGE), total: matched.length, page };
};

const matches = (team: TeamRow, phrase: string): boolean =>
  team.name.toLowerCase().includes(phrase) || team.slug.toLowerCase().includes(phrase);

/** `-1 | 0 | 1` on the lower-cased name, which is the tiebreaker of every other order. */
const byName = (left: TeamRow, right: TeamRow): number => {
  const a = left.name.toLowerCase();
  const b = right.name.toLowerCase();

  if (a === b) return 0;

  return a < b ? -1 : 1;
};

const compare = (left: TeamRow, right: TeamRow, sort: TeamListSearch['sort']): number => {
  if (sort === 'name') return byName(left, right);
  if (sort === '-name') return byName(right, left);

  const bySize = left.memberCount - right.memberCount;

  if (bySize !== 0) return sort === 'members' ? bySize : -bySize;

  return byName(left, right);
};
