import { getRouteApi } from '@tanstack/react-router';

import { ProjectSettings } from '@widgets/project-settings';

const route = getRouteApi('/_authenticated/projects/$projectId/settings');

/**
 * `/projects/$projectId/settings` — the settings section of a project card. Composition only.
 *
 * A deleted project leaves for the project list — the place its card was reached from, and where the
 * project is now visibly gone.
 */
export function ProjectSettingsPage() {
  const { projectId } = route.useParams();
  const navigate = route.useNavigate();

  return (
    <ProjectSettings
      onDeleted={() => {
        void navigate({ to: '/projects' });
      }}
      projectId={projectId}
    />
  );
}
