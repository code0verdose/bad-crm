import { queryOptions, useSuspenseQuery, type UseSuspenseQueryResult } from '@tanstack/react-query';

import { fetchProject, type ProjectDetail } from '@units/project/api';
import { isAbortError, isApiError } from '@shared/api';
import { QueryKeys } from '@shared/lib';

/** One retry for a transport failure or a 5xx — the application default, restated below. */
const RETRIES = 1;
const HTTP_SERVER_ERROR = 500;

/**
 * Whether a failed read of the card is worth asking again.
 *
 * **A deviation from the application default, and only in this:** a 4xx is an answer, not a
 * failure. The default retries everything but a 401 and a cancellation, so a `404` — «there is no
 * such project, or it is not yours» — would be asked twice, a retry delay apart, before the route
 * could show the not-found screen (`rules/tanstack-query.mdc` §1: a deviation carries its reason).
 */
const isWorthRetrying = (failureCount: number, error: Error): boolean =>
  failureCount < RETRIES &&
  !isAbortError(error) &&
  !(isApiError(error) && error.status < HTTP_SERVER_ERROR);

/**
 * The card of one project — the options object rather than a hook, because two callers share it:
 * the route's `beforeLoad`/`loader` prime the cache with `ensureQueryData`, and the screen reads the
 * very same entry with `useSuspenseQuery`, so a navigation costs one request, not two
 * (STORY-014-05, acceptance 3; `rules/tanstack-query.mdc` §12).
 */
export const projectDetailQueryOptions = (projectId: string) =>
  queryOptions({
    queryKey: QueryKeys.Projects.detail(projectId),
    queryFn: ({ signal }) => fetchProject(projectId, signal),
    retry: isWorthRetrying,
  });

/**
 * The card, read under Suspense: by the time a component under the project route renders, the
 * route has already loaded it — pending and failure are the route's boundaries, not this hook's.
 */
export const useProjectDetailQuery = (
  projectId: string,
): UseSuspenseQueryResult<ProjectDetail, Error> =>
  useSuspenseQuery(projectDetailQueryOptions(projectId));
