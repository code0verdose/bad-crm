import { getRouteApi } from '@tanstack/react-router';

import { ProjectSettings } from '@widgets/project-settings';

const route = getRouteApi('/_authenticated/projects/$projectId/settings');

/**
 * `/projects/$projectId/settings` — the settings section of a project card. Composition only.
 *
 * A deleted project leaves for the dashboard: the project list (STORY-014-04) is not a route of this
 * branch yet, and the dashboard is where the not-found screen of the card already sends people.
 */
export function ProjectSettingsPage() {
  const { projectId } = route.useParams();
  const navigate = route.useNavigate();

  return (
    <ProjectSettings
      onDeleted={() => {
        void navigate({ to: '/' });
      }}
      projectId={projectId}
    />
  );
}
