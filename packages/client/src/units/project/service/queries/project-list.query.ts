import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { fetchProjectList, type ProjectListPage, type ProjectListParams } from '@units/project/api';
import { QueryKeys } from '@shared/lib';

/**
 * One page of the projects the caller can see (STORY-014-04, acceptances 2 and 4).
 *
 * `keepPreviousData`: while the next page or the next filter is in flight the previous cards stay on
 * screen, so paging does not blink through an empty grid and back; the first load has nothing to
 * keep and is a skeleton.
 *
 * The `signal` is passed on, so a filter changed twice in a second cancels the first request rather
 * than racing it — two answers to two questions arriving out of order is how a list ends up showing
 * projects that match neither. The cancellation is not an error: the query client neither retries
 * nor reports an `AbortError`.
 */
export const useProjectListQuery = (
  params: ProjectListParams,
): UseQueryResult<ProjectListPage, Error> =>
  useQuery({
    queryKey: QueryKeys.Projects.list(params),
    queryFn: ({ signal }) => fetchProjectList(params, signal),
    placeholderData: keepPreviousData,
  });
