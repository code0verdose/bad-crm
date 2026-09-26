import { getRouteApi } from '@tanstack/react-router';

import { ProjectOverview } from '@widgets/project-overview';

const route = getRouteApi('/_authenticated/projects/$projectId/');

/** `/projects/$projectId/` — the overview section of a project card. Composition only. */
export function ProjectOverviewPage() {
  const { projectId } = route.useParams();

  return <ProjectOverview projectId={projectId} />;
}
