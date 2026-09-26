import { type ProjectListPage } from '@units/project/api';
import { type ProjectListSearch } from '@units/project/model/validation/project-list-search.schema.js';
import {
  useProjectFilters,
  type ProjectFilters,
  type ProjectSearchNavigation,
} from '@units/project/service/hooks/use-project-filters.hook.js';
import { useProjectListQuery } from '@units/project/service/queries/project-list.query.js';

export interface ProjectListScreen {
  readonly filters: ProjectFilters;
  /** The page on screen — the previous one while the next is in flight (`keepPreviousData`). */
  readonly page: ProjectListPage | undefined;
  readonly status: 'pending' | 'error' | 'success';
  /** The answer arrived and holds nothing — the empty state, not an empty grid. */
  readonly isEmpty: boolean;
  /** Resolves when the reload answers, so «Retry» stays busy until then. */
  readonly refetch: () => Promise<unknown>;
}

/**
 * `/projects` as one screen reads it: the filter and the page it selects — the unit's public API
 * for the widget (`rules/frontend-fsd.mdc` rule 6; STORY-014-04, acceptances 1–4).
 *
 * **`isPending`, not `isFetching`.** With `keepPreviousData` a refetch keeps the previous cards on
 * screen, and a skeleton over cards already there is a flash on every page turn; only the first
 * load — the one with nothing to keep — gets the skeleton.
 */
export const useProjectList = (
  search: ProjectListSearch,
  navigate: ProjectSearchNavigation,
): ProjectListScreen => {
  const filters = useProjectFilters(search, navigate);
  const query = useProjectListQuery(filters.params);

  return {
    filters,
    page: query.data,
    status: query.isError ? 'error' : query.isPending ? 'pending' : 'success',
    isEmpty: query.data?.items.length === 0,
    refetch: () => query.refetch(),
  };
};
