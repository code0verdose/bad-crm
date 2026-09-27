import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import {
  previewProjectVisibility,
  type ProjectVisibilityImpact,
  type ProjectVisibilityValue,
} from '@units/project/api';
import { QueryKeys } from '@shared/lib';

/**
 * How many colleagues a change of visibility would move — read only while the confirmation is open.
 *
 * `staleTime: 0` rather than the client-wide 30 s: the count is a statement about grants and seats
 * that anybody may change in between, and it is shown as the reason to press a dangerous button —
 * every opening of the dialog asks again. The request is cancelled with the dialog.
 */
export const useProjectVisibilityImpactQuery = (
  projectId: string,
  to: ProjectVisibilityValue,
  enabled: boolean,
): UseQueryResult<ProjectVisibilityImpact, Error> =>
  useQuery({
    queryKey: QueryKeys.Projects.visibilityImpact(projectId, to),
    queryFn: ({ signal }) => previewProjectVisibility(projectId, to, signal),
    enabled,
    staleTime: 0,
  });
