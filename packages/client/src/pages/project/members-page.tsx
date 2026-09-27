import { getRouteApi } from '@tanstack/react-router';
import { useCallback } from 'react';

import { ProjectMembers } from '@widgets/project-members';
import { type ProjectService } from '@units/project';

const route = getRouteApi('/_authenticated/projects/$projectId/members');

/**
 * `/projects/$projectId/members` — the roster section of a project card. Composition only: it reads
 * the typed search of the route and hands it, with a way to write it back, to the widget.
 */
export function ProjectMembersPage() {
  const { projectId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();

  /**
   * The router's `navigate`, narrowed to what the unit needs — wrapped rather than passed through,
   * because `units/` must not depend on the generated route tree two layers above it.
   */
  const write = useCallback<ProjectService.ProjectHooks.ProjectMembersSearchNavigation>(
    (input) => {
      void navigate({ search: input.search, replace: input.replace });
    },
    [navigate],
  );

  return <ProjectMembers navigate={write} projectId={projectId} search={search} />;
}
