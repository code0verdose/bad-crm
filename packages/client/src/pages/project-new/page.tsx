import { Stack } from '@mantine/core';
import { getRouteApi } from '@tanstack/react-router';

import { SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { ProjectCreate } from '@widgets/project-create';

const route = getRouteApi('/_authenticated/projects/new');

/**
 * `/projects/new` — creating a project (STORY-014-01, acceptance 1). Composition only: the heading
 * and the form; once the server has the project, the reader lands on its card, which the create
 * already put in the cache — no second request, no flash of a skeleton.
 */
export function ProjectNewPage() {
  const navigate = route.useNavigate();

  return (
    <Stack gap="md">
      <SharedUi.PageHeader breadcrumbs={<Breadcrumbs />} titleKey="projects.create.title" />
      <ProjectCreate
        onCreated={(projectId) => {
          void navigate({ to: '/projects/$projectId', params: { projectId } });
        }}
      />
    </Stack>
  );
}
