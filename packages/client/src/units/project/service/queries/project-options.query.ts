import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';

import {
  fetchProjectOptions,
  type ProjectDetail,
  type ProjectOptionList,
  type ProjectOptionsParams,
} from '@units/project/api';
import { projectDetailQueryOptions } from '@units/project/service/queries/project-detail.query.js';
import { QueryKeys } from '@shared/lib';

/**
 * Five minutes, not the client's thirty seconds (STORY-014-06, acceptance 9): the switcher is opened
 * many times an hour and the set of projects changes rarely. What does change it — creating,
 * archiving, deleting, a membership — invalidates `QueryKeys.Projects.all`, which this key sits
 * under, so the long freshness never outlives a change made from this tab.
 */
export const PROJECT_OPTIONS_STALE_MS = 5 * 60 * 1000;

/**
 * The projects the switcher offers. `keepPreviousData` keeps the last results on screen while the
 * next search is in flight; the `signal` cancels the previous search when the text changes, so an
 * answer to an older question cannot overwrite a newer one. `enabled` is the switcher's «open»:
 * nothing is asked until the person opens it.
 */
/**
 * The project the header is standing in, for the switcher's label — **read from the cache, never
 * fetched**. The project layout's guard is what asks for the card, and only after it has decided the
 * reader may see it; a header that asked on its own would request a project the route just refused
 * (no `project:read`) and race the route's own retry on a failed load — both measured by
 * `test/routes/project-overview-screen.test.tsx` the moment this was an enabled query. Disabled, it
 * still subscribes to the entry and shows it as soon as the guard has put it there. Without Suspense:
 * the header lives outside the project route's boundaries.
 */
export const useCurrentProjectQuery = (
  projectId: string | null,
): UseQueryResult<ProjectDetail, Error> =>
  useQuery({ ...projectDetailQueryOptions(projectId ?? ''), enabled: false });

export const useProjectOptionsQuery = (
  params: ProjectOptionsParams,
  enabled: boolean,
): UseQueryResult<ProjectOptionList, Error> =>
  useQuery({
    queryKey: QueryKeys.Projects.options(params),
    queryFn: ({ signal }) => fetchProjectOptions(params, signal),
    placeholderData: keepPreviousData,
    staleTime: PROJECT_OPTIONS_STALE_MS,
    enabled,
  });
