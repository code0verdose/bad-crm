import { getRouteApi } from '@tanstack/react-router';

import { ProjectMembers } from '@widgets/project-members';

const route = getRouteApi('/_authenticated/projects/$projectId/members');

/** `/projects/$projectId/members` — the roster section of a project card. Composition only. */
export function ProjectMembersPage() {
  const { projectId } = route.useParams();

  return <ProjectMembers projectId={projectId} />;
}
